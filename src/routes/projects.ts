import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import { getDatabase } from '../db/database';
import { Project, CreateProjectInput, Agent } from '../types';
import { scheduleProject, unscheduleProject } from '../services/scheduler';
import { stopAgentProcess, isAgentRunning } from '../services/process-manager';
import { config } from '../config';

export function registerProjectRoutes(fastify: FastifyInstance): void {

  // Generate project metadata from user description using AI
  fastify.post<{ Body: { description: string; tool_path: string } }>('/api/generate-project', async (request, reply) => {
    const { description, tool_path } = request.body;
    if (!description) return reply.code(400).send({ error: 'description is required' });

    const tool = tool_path || config.defaultCommandTemplate;
    const prompt = `Given the user's input below, generate a JSON object. IMPORTANT: Use the SAME LANGUAGE as the user's input (if Chinese, respond in Chinese; if English, respond in English).

Fields:
- "name": short project name in English (lowercase, hyphens, max 30 chars)
- "description": one-line summary (max 100 chars, same language as user)
- "task_description": detailed instructions for the controller agent (2-5 sentences, same language as user)
- "controller_role": role description for the controller agent (same language as user)
- "working_directory": if the user mentions a path or directory, extract it here (absolute path); otherwise null

User's input: "${description.replace(/"/g, '\\"')}"

Respond with ONLY valid JSON, no markdown, no explanation.`;

    try {
      const result = execSync(`echo ${JSON.stringify(prompt)} | ${tool} -p`, {
        timeout: 60000,
        encoding: 'utf-8',
        env: { ...process.env },
      }).trim();

      // Extract JSON from response (handle possible markdown wrapping)
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return reply.code(500).send({ error: 'AI did not return valid JSON', raw: result });
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return { ...parsed };
    } catch (e: any) {
      return reply.code(500).send({ error: 'Failed to generate: ' + (e.message || '').slice(0, 200) });
    }
  });
  // Project cost summary
  fastify.get<{ Params: { id: string } }>('/api/projects/:id/costs', async (request) => {
    const db = getDatabase();
    const pid = request.params.id;
    const costs = db.prepare(
      "SELECT c.content, a.name as agent_name FROM conversation_logs c JOIN agents a ON c.agent_id = a.id WHERE a.project_id = ? AND c.stream = 'cost' ORDER BY c.id"
    ).all(pid) as any[];

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const byAgent: Record<string, { cost: number; runs: number }> = {};

    for (const c of costs) {
      try {
        const data = JSON.parse(c.content);
        totalCost += data.cost_usd || 0;
        totalInput += data.input_tokens || 0;
        totalOutput += data.output_tokens || 0;
        if (!byAgent[c.agent_name]) byAgent[c.agent_name] = { cost: 0, runs: 0 };
        byAgent[c.agent_name].cost += data.cost_usd || 0;
        byAgent[c.agent_name].runs++;
      } catch {}
    }

    return { total_cost_usd: totalCost, total_input_tokens: totalInput, total_output_tokens: totalOutput, by_agent: byAgent };
  });

  // Project activity timeline
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/projects/:id/activity', async (request) => {
    const db = getDatabase();
    const limit = parseInt(request.query.limit || '50', 10);
    const pid = request.params.id;

    // Combine: issue events + agent status changes + comments into a unified timeline
    const issues = db.prepare(
      "SELECT 'issue' as event_type, id, number, title, status, created_by as actor, created_at as time FROM issues WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(pid, limit) as any[];

    const comments = db.prepare(
      "SELECT 'comment' as event_type, c.id, c.body, c.author_id as actor, c.created_at as time, i.number as issue_number, i.title as issue_title FROM issue_comments c JOIN issues i ON c.issue_id = i.id WHERE i.project_id = ? ORDER BY c.created_at DESC LIMIT ?"
    ).all(pid, limit) as any[];

    const agentRuns = db.prepare(
      "SELECT 'agent_run' as event_type, a.id, a.name, a.status as agent_status, a.started_at as time FROM agents a WHERE a.project_id = ? AND a.started_at IS NOT NULL ORDER BY a.started_at DESC LIMIT ?"
    ).all(pid, limit) as any[];

    // Merge and sort by time DESC
    const all = [...issues, ...comments, ...agentRuns]
      .sort((a: any, b: any) => b.time > a.time ? 1 : -1)
      .slice(0, limit);

    return all;
  });

  // List projects
  fastify.get('/api/projects', async () => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  });

  // Create project
  fastify.post<{ Body: CreateProjectInput }>('/api/projects', async (request, reply) => {
    const { name, description, task_description, controller_interval_min, command_template, working_directory, controller_role } = request.body as any;

    if (!task_description) {
      return reply.code(400).send({ error: 'task_description is required' });
    }

    const db = getDatabase();
    const id = uuidv4();
    const interval = controller_interval_min || 5;
    const tmpl = command_template || config.defaultCommandTemplate;

    db.prepare(`
      INSERT INTO projects (id, name, description, task_description, controller_interval_min, command_template, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(id, name, description || '', task_description, interval, tmpl);

    // Create default controller agent
    const controllerId = uuidv4();
    const ctrlRole = controller_role || 'Main controller agent that manages and coordinates other agents';
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, working_directory, status)
      VALUES (?, ?, ?, ?, 1, ?, 'idle')
    `).run(controllerId, id, `${name || 'project'}-controller`, ctrlRole, working_directory || null);

    // Create default assistant agent
    const assistantId = uuidv4();
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, working_directory, status)
      VALUES (?, ?, ?, ?, 0, ?, 'idle')
    `).run(assistantId, id, `${name || 'project'}-assistant`, 'Assistant to the controller. Handles analysis, code execution, data processing, and research tasks delegated by the controller.', working_directory || null);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;

    // Schedule the project
    scheduleProject(project);

    return reply.code(201).send(project);
  });

  // Get project
  fastify.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return project;
  });

  // Update project
  fastify.put<{ Params: { id: string }; Body: Partial<CreateProjectInput> & { status?: string } }>('/api/projects/:id', async (request, reply) => {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id) as Project | undefined;
    if (!existing) return reply.code(404).send({ error: 'Project not found' });

    const { name, description, task_description, controller_interval_min, command_template, status, schedule_hours } = request.body as any;

    db.prepare(`
      UPDATE projects SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        task_description = COALESCE(?, task_description),
        controller_interval_min = COALESCE(?, controller_interval_min),
        command_template = COALESCE(?, command_template),
        schedule_hours = COALESCE(?, schedule_hours),
        status = COALESCE(?, status),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? null, description ?? null, task_description ?? null,
      controller_interval_min ?? null, command_template ?? null, schedule_hours ?? null, status ?? null,
      request.params.id
    );

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id) as Project;

    // Re-schedule if interval or status changed
    if (updated.status === 'active') {
      scheduleProject(updated);
    } else {
      unscheduleProject(updated.id);
    }

    return updated;
  });

  // Delete project
  fastify.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Project not found' });

    // Stop all running agents before deleting
    const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(request.params.id) as Agent[];
    for (const agent of agents) {
      if (isAgentRunning(agent.id)) stopAgentProcess(agent.id);
    }

    unscheduleProject(request.params.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(request.params.id);
    return { success: true };
  });
}
