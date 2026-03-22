import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { Agent, Project, CreateAgentInput, StartAgentInput } from '../types';
import { startAgentProcess, stopAgentProcess, isAgentRunning } from '../services/process-manager';
import { buildSystemPrompt } from '../services/system-prompt';
import { config } from '../config';

export function registerAgentRoutes(fastify: FastifyInstance): void {
  // List agents for a project
  fastify.get<{ Params: { pid: string } }>('/api/projects/:pid/agents', async (request) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at').all(request.params.pid);
  });

  // Create agent
  fastify.post<{ Params: { pid: string }; Body: CreateAgentInput }>('/api/projects/:pid/agents', async (request, reply) => {
    const { name, role, is_controller, session_id, working_directory } = request.body;
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.pid);
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, session_id, working_directory, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'idle')
    `).run(id, request.params.pid, name, role || '', is_controller ? 1 : 0, session_id || null, working_directory || null);

    return reply.code(201).send(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
  });

  // Get agent
  fastify.get<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return agent;
  });

  // Update agent
  fastify.put<{ Params: { id: string }; Body: Partial<CreateAgentInput> }>('/api/agents/:id', async (request, reply) => {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Agent not found' });

    const { name, role, session_id, working_directory, custom_instructions, new_session_per_run } = request.body as any;
    db.prepare(`
      UPDATE agents SET
        name = COALESCE(?, name),
        role = COALESCE(?, role),
        session_id = COALESCE(?, session_id),
        working_directory = COALESCE(?, working_directory),
        custom_instructions = COALESCE(?, custom_instructions),
        new_session_per_run = COALESCE(?, new_session_per_run)
      WHERE id = ?
    `).run(name ?? null, role ?? null, session_id ?? null, working_directory ?? null, custom_instructions ?? null, new_session_per_run !== undefined ? (new_session_per_run ? 1 : 0) : null, request.params.id);

    return db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id);
  });

  // Delete agent
  fastify.delete<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (isAgentRunning(agent.id)) {
      stopAgentProcess(agent.id);
    }

    // Clear assigned_to on issues referencing this agent
    db.prepare('UPDATE issues SET assigned_to = NULL WHERE assigned_to = ?').run(request.params.id);

    db.prepare('DELETE FROM agents WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // Start agent
  fastify.post<{ Params: { id: string }; Body: { prompt?: string } }>('/api/agents/:id/start', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      return reply.code(409).send({ error: 'Agent is already running' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found for this agent' });

    // Build prompt: user-provided > auto-generated from role + task
    let prompt = request.body?.prompt?.trim() || '';
    if (!prompt) {
      const parts: string[] = [];
      if (agent.role) parts.push(`Role: ${agent.role}`);
      if (project.task_description) parts.push(`Task: ${project.task_description}`);

      // Include open issues assigned to this agent
      const issues = db.prepare(
        "SELECT * FROM issues WHERE project_id = ? AND assigned_to = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
      ).all(project.id, agent.id) as any[];
      if (issues.length > 0) {
        parts.push('Assigned issues:\n' + issues.map((i: any) => `#${i.number} [${i.status}] ${i.title}: ${i.body.slice(0, 200)}`).join('\n'));
        // Mark as in_progress
        db.prepare("UPDATE issues SET status = 'in_progress', updated_at = datetime('now') WHERE project_id = ? AND assigned_to = ? AND status = 'open'")
          .run(project.id, agent.id);
      }

      prompt = parts.join('\n\n');
    }

    if (!prompt) return reply.code(400).send({ error: 'No prompt could be generated. Set agent role or project task_description.' });

    const commandTemplate = project.command_template || config.defaultCommandTemplate;

    // Inject system prompt by default; skip for raw shell commands (bash -c / sh -c)
    const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
    const fullPrompt = isRawShell
      ? prompt
      : buildSystemPrompt(agent, project) + prompt;

    const result = startAgentProcess(agent, fullPrompt, commandTemplate);
    return { success: true, runId: result.runId, pid: result.pid };
  });

  // Retry agent (re-run with the same last_prompt)
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/retry', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      return reply.code(409).send({ error: 'Agent is already running' });
    }

    if (!agent.last_prompt) {
      return reply.code(400).send({ error: 'No previous prompt to retry. Use start instead.' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found for this agent' });

    // Reset session_id to ensure fresh session on retry
    db.prepare('UPDATE agents SET session_id = NULL WHERE id = ?').run(agent.id);
    const freshAgent = { ...agent, session_id: null };

    const commandTemplate = project.command_template || config.defaultCommandTemplate;
    const result = startAgentProcess(freshAgent, agent.last_prompt, commandTemplate);
    return { success: true, runId: result.runId, pid: result.pid };
  });

  // Stop agent
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/stop', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const stopped = stopAgentProcess(agent.id);
    if (!stopped) {
      db.prepare("UPDATE agents SET status = 'stopped', pid = NULL WHERE id = ?").run(agent.id);
    }

    return { success: true };
  });

  // Get agent status
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/status', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    // If error, fetch the last stderr log
    let lastError: string | null = null;
    if (agent.status === 'error') {
      const errLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND stream = 'stderr' ORDER BY id DESC LIMIT 1"
      ).get(agent.id) as { content: string } | undefined;
      lastError = errLog?.content || null;
      if (!lastError) {
        const anyLog = db.prepare(
          "SELECT content FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT 1"
        ).get(agent.id) as { content: string } | undefined;
        lastError = anyLog?.content || null;
      }
    }

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      pid: agent.pid,
      is_running: isAgentRunning(agent.id),
      started_at: agent.started_at,
      finished_at: agent.finished_at,
      last_error: lastError,
    };
  });

  // Preview system prompt for an agent
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/system-prompt', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return { prompt: buildSystemPrompt(agent, project) };
  });

  // Plain text terminal output (for debugging / curl)
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/agents/:id/terminal', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send('Agent not found');
    const limit = parseInt(request.query.limit || '200', 10);
    const logs = db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
    ).all(request.params.id, limit) as any[];
    logs.reverse();

    let text = `=== ${agent.name} [${agent.status}] ===\n\n`;
    for (const l of logs) {
      if (l.stream === 'stdin') {
        text += `--- Input Prompt (${l.content.length} chars) ---\n`;
        text += l.content.replace(/\n/g, ' ').slice(0, 100) + '...\n';
        text += '--- Output ---\n';
      } else if (l.stream === 'stderr') {
        text += `[ERR] ${l.content}`;
      } else {
        text += l.content;
      }
    }
    return reply.type('text/plain').send(text);
  });

  // Get agent logs
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/agents/:id/logs', async (request, reply) => {
    const db = getDatabase();
    const limit = parseInt(request.query.limit || '100', 10);
    return db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
    ).all(request.params.id, limit);
  });

  // Get logs for a specific run
  fastify.get<{ Params: { id: string; run_id: string } }>('/api/agents/:id/logs/:run_id', async (request) => {
    const db = getDatabase();
    return db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? ORDER BY id'
    ).all(request.params.id, request.params.run_id);
  });
}
