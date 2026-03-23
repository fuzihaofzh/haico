import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getDatabase } from '../db/database';
import { Project, CreateProjectInput, Agent } from '../types';
import { scheduleProject, unscheduleProject } from '../services/scheduler';
import { stopAgentProcess, isAgentRunning } from '../services/process-manager';
import { config } from '../config';

export function registerProjectRoutes(fastify: FastifyInstance): void {

  // Dashboard summary — aggregate stats across all projects
  fastify.get('/api/dashboard/summary', async () => {
    const db = getDatabase();

    const agentStats = db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count FROM agents"
    ).get() as any;

    const issueStats = db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as open_count FROM issues"
    ).get() as any;

    // Total cost across all projects
    const costRows = db.prepare(
      "SELECT content FROM conversation_logs WHERE stream = 'cost'"
    ).all() as any[];
    let totalCost = 0;
    for (const c of costRows) {
      try { totalCost += JSON.parse(c.content).cost_usd || 0; } catch {}
    }

    // Last activity per project (most recent agent started_at or issue updated_at)
    const projectActivity = db.prepare(
      `SELECT p.id,
        MAX(COALESCE(a.started_at, a.finished_at)) as last_agent_activity,
        MAX(i.updated_at) as last_issue_activity
       FROM projects p
       LEFT JOIN agents a ON a.project_id = p.id
       LEFT JOIN issues i ON i.project_id = p.id
       GROUP BY p.id`
    ).all() as any[];

    const lastActivityMap: Record<string, string | null> = {};
    for (const row of projectActivity) {
      const times = [row.last_agent_activity, row.last_issue_activity].filter(Boolean);
      lastActivityMap[row.id] = times.length ? times.sort().pop()! : null;
    }

    return {
      agents: { total: agentStats.total || 0, running: agentStats.running || 0, error_count: agentStats.error_count || 0 },
      issues: { total: issueStats.total || 0, open: issueStats.open_count || 0 },
      total_cost_usd: totalCost,
      last_activity: lastActivityMap,
    };
  });

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
  // Project cost summary with per-run breakdowns and time-series support
  fastify.get<{ Params: { id: string }; Querystring: { period?: string } }>('/api/projects/:id/costs', async (request) => {
    const db = getDatabase();
    const pid = request.params.id;
    const period = request.query.period; // day | week | month

    const costs = db.prepare(
      "SELECT c.content, c.run_id, c.created_at, a.name as agent_name FROM conversation_logs c JOIN agents a ON c.agent_id = a.id WHERE a.project_id = ? AND c.stream = 'cost' ORDER BY c.created_at"
    ).all(pid) as any[];

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const byAgent: Record<string, { cost: number; runs: number }> = {};
    const runs: Array<{ run_id: string; agent_name: string; cost_usd: number; input_tokens: number; output_tokens: number; timestamp: string }> = [];
    const timeSeries: Record<string, { cost: number; runs: number }> = {};
    const timeSeriesByAgent: Record<string, Record<string, { cost: number; runs: number }>> = {};

    for (const c of costs) {
      try {
        const data = JSON.parse(c.content);
        const costUsd = data.cost_usd || 0;
        const inputTokens = data.input_tokens || 0;
        const outputTokens = data.output_tokens || 0;

        totalCost += costUsd;
        totalInput += inputTokens;
        totalOutput += outputTokens;

        if (!byAgent[c.agent_name]) byAgent[c.agent_name] = { cost: 0, runs: 0 };
        byAgent[c.agent_name].cost += costUsd;
        byAgent[c.agent_name].runs++;

        runs.push({
          run_id: c.run_id,
          agent_name: c.agent_name,
          cost_usd: costUsd,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          timestamp: c.created_at,
        });

        // Build time-series buckets
        if (period && c.created_at) {
          let key: string;
          const date = c.created_at.slice(0, 10); // YYYY-MM-DD
          if (period === 'day') {
            key = date;
          } else if (period === 'week') {
            const d = new Date(date);
            const day = d.getDay();
            d.setDate(d.getDate() - day);
            key = d.toISOString().slice(0, 10);
          } else if (period === 'month') {
            key = date.slice(0, 7); // YYYY-MM
          } else {
            key = date;
          }
          if (!timeSeries[key]) timeSeries[key] = { cost: 0, runs: 0 };
          timeSeries[key].cost += costUsd;
          timeSeries[key].runs++;

          // Per-agent time-series
          if (!timeSeriesByAgent[c.agent_name]) timeSeriesByAgent[c.agent_name] = {};
          if (!timeSeriesByAgent[c.agent_name][key]) timeSeriesByAgent[c.agent_name][key] = { cost: 0, runs: 0 };
          timeSeriesByAgent[c.agent_name][key].cost += costUsd;
          timeSeriesByAgent[c.agent_name][key].runs++;
        }
      } catch {}
    }

    const result: any = {
      total_cost_usd: totalCost,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      by_agent: byAgent,
      runs,
    };

    if (period) {
      result.time_series = Object.entries(timeSeries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period_start, data]) => ({ period_start, ...data }));

      // Per-agent time-series breakdown
      result.time_series_by_agent = Object.fromEntries(
        Object.entries(timeSeriesByAgent).map(([agent, series]) => [
          agent,
          Object.entries(series)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([period_start, data]) => ({ period_start, ...data })),
        ])
      );
    }

    return result;
  });

  // Git log — aggregate recent commits from all agents' working directories
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/projects/:id/git-log', async (request) => {
    const db = getDatabase();
    const pid = request.params.id;
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);

    const agents = db.prepare('SELECT id, name, working_directory FROM agents WHERE project_id = ?').all(pid) as Agent[];

    const seen = new Set<string>(); // deduplicate by commit hash
    const commits: Array<{ hash: string; short_hash: string; author: string; message: string; date: string; repo_path: string; agent_name: string }> = [];

    // Collect unique working directories
    const dirToAgents = new Map<string, string[]>();
    for (const agent of agents) {
      let dir = agent.working_directory;
      if (!dir) continue;
      if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));
      if (!dirToAgents.has(dir)) dirToAgents.set(dir, []);
      dirToAgents.get(dir)!.push(agent.name);
    }

    for (const [dir, agentNames] of dirToAgents) {
      try {
        if (!fs.existsSync(path.join(dir, '.git')) && !fs.existsSync(dir)) continue;
        const output = execSync(
          `git log --format='%H|%an|%s|%ai' -n ${limit}`,
          { cwd: dir, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (!output) continue;
        for (const line of output.split('\n')) {
          const parts = line.split('|');
          if (parts.length < 4) continue;
          const hash = parts[0];
          if (seen.has(hash)) continue;
          seen.add(hash);
          commits.push({
            hash,
            short_hash: hash.slice(0, 7),
            author: parts[1],
            message: parts[2],
            date: parts.slice(3).join('|'), // date may contain |
            repo_path: dir,
            agent_name: agentNames[0],
          });
        }
      } catch {
        // Not a git repo or git failed — skip gracefully
      }
    }

    // Sort by date descending and limit
    commits.sort((a, b) => b.date > a.date ? 1 : -1);
    return commits.slice(0, limit);
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

  // List projects (with optional embedded stats for dashboard performance)
  fastify.get<{ Querystring: { with_stats?: string } }>('/api/projects', async (request) => {
    const db = getDatabase();
    const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];

    if (request.query.with_stats !== '1') return projects;

    // Single-pass stats: avoids N+2 frontend requests per project
    return projects.map(p => {
      const agentStats = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as error_count FROM agents WHERE project_id = ?"
      ).get(p.id) as any;

      const issueStats = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) as open_count FROM issues WHERE project_id = ?"
      ).get(p.id) as any;

      const userIssues = db.prepare(
        "SELECT number, title FROM issues WHERE project_id = ? AND assigned_to = 'user' AND status IN ('open','in_progress') ORDER BY priority DESC LIMIT 10"
      ).all(p.id) as any[];

      return {
        ...p,
        stats: {
          agents: agentStats.total || 0,
          running: agentStats.running || 0,
          agentError: agentStats.error_count || 0,
          issues: issueStats.total || 0,
          openIssues: issueStats.open_count || 0,
          userIssues,
        },
      };
    });
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
      controller_interval_min ?? null, command_template ?? null, schedule_hours ?? null,
      status ?? null,
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

  // Export project data as JSON
  fastify.get<{ Params: { id: string } }>('/api/projects/:id/export', async (request, reply) => {
    const db = getDatabase();
    const pid = request.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    const agents = db.prepare('SELECT id, name, role, is_controller, status, started_at, finished_at, created_at FROM agents WHERE project_id = ?').all(pid);
    const issues = db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY number').all(pid);
    const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ?').all(pid);

    // Cost summary
    const costRows = db.prepare(
      "SELECT c.content, c.run_id, c.created_at, a.name as agent_name FROM conversation_logs c JOIN agents a ON c.agent_id = a.id WHERE a.project_id = ? AND c.stream = 'cost' ORDER BY c.created_at"
    ).all(pid) as any[];

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    for (const c of costRows) {
      try {
        const data = JSON.parse(c.content);
        totalCost += data.cost_usd || 0;
        totalInput += data.input_tokens || 0;
        totalOutput += data.output_tokens || 0;
      } catch {}
    }

    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="${project.name || 'project'}-export.json"`);
    return {
      exported_at: new Date().toISOString(),
      project,
      agents,
      issues,
      milestones,
      cost_summary: { total_cost_usd: totalCost, total_input_tokens: totalInput, total_output_tokens: totalOutput },
    };
  });

  // Export issues as CSV
  fastify.get<{ Params: { id: string } }>('/api/projects/:id/export/issues.csv', async (request, reply) => {
    const db = getDatabase();
    const pid = request.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    const issues = db.prepare('SELECT number, title, status, priority, labels, assigned_to, created_by, created_at, updated_at FROM issues WHERE project_id = ? ORDER BY number').all(pid) as any[];

    const csvHeader = 'number,title,status,priority,labels,assigned_to,created_by,created_at,updated_at';
    const csvRows = issues.map((i: any) => {
      const escape = (v: any) => {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return [i.number, i.title, i.status, i.priority, i.labels, i.assigned_to, i.created_by, i.created_at, i.updated_at].map(escape).join(',');
    });

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${project.name || 'project'}-issues.csv"`);
    return [csvHeader, ...csvRows].join('\n');
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
