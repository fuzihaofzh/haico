import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getDatabase } from '../db/database';
import { Project, CreateProjectInput, Agent, OrchestratorEngine, ProjectMember } from '../types';
import { stopAgentProcess, isAgentRunning } from '../services/process-manager';
import { config } from '../config';
import { isLegacyAuthUser } from '../middleware/auth';
import { buildControllerCommandConfig, resolveCommandType } from '../services/command-profiles';
import {
  ensureProjectAccess,
  getProjectPermission,
  getProjectRequestContext,
  listAccessibleProjectIds,
  listAccessibleProjects,
} from '../services/project-permissions';

function normalizeOrchestratorEngine(value: unknown): OrchestratorEngine | null {
  if (value === undefined) return null;
  const engine = String(value).toLowerCase();
  if (engine === 'native' || engine === 'langgraph') return engine as OrchestratorEngine;
  return null;
}

function buildSqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

interface ProjectOwnerSummary {
  id: string;
  username: string;
  display_name: string;
  role: string;
}

function getProjectOwnerSummary(db: ReturnType<typeof getDatabase>, projectId: string): ProjectOwnerSummary | null {
  return db.prepare(
    `SELECT u.id, u.username, u.display_name, u.role
     FROM projects p
     LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.id = ?`
  ).get(projectId) as ProjectOwnerSummary | null;
}

function getProjectMemberCount(db: ReturnType<typeof getDatabase>, projectId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count
     FROM (
       SELECT owner_id as user_id
       FROM projects
       WHERE id = ? AND owner_id IS NOT NULL
       UNION
       SELECT user_id
       FROM project_members
       WHERE project_id = ?
     ) members`
  ).get(projectId, projectId) as { count: number } | undefined;
  return row?.count || 0;
}

function serializeProject(
  db: ReturnType<typeof getDatabase>,
  project: Project,
  user: ReturnType<typeof getProjectRequestContext>['user'],
  localhostBypass: boolean
) {
  const permission = getProjectPermission(db, project.id, user, localhostBypass);
  const owner = getProjectOwnerSummary(db, project.id);
  return {
    ...project,
    permission_level: permission.level,
    can_manage: permission.canManage,
    owner,
    member_count: getProjectMemberCount(db, project.id),
  };
}

export function registerProjectRoutes(fastify: FastifyInstance): void {

  // Dashboard summary — aggregate stats across all projects
  fastify.get('/api/dashboard/summary', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);

    if (projectIds.length === 0) {
      return {
        agents: { total: 0, running: 0, error_count: 0 },
        issues: { total: 0, open: 0 },
        total_cost_usd: 0,
        last_activity: {},
      };
    }

    const placeholders = buildSqlPlaceholders(projectIds);

    const agentStats = db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
       FROM agents
       WHERE project_id IN (${placeholders})`
    ).get(...projectIds) as any;

    const issueStats = db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as open_count
       FROM issues
       WHERE project_id IN (${placeholders})`
    ).get(...projectIds) as any;

    // Total cost across all projects — only last record per run_id (cost is cumulative)
    const costRows = db.prepare(
      `SELECT c.content FROM conversation_logs c
       INNER JOIN (
         SELECT MAX(cl.id) as max_id
         FROM conversation_logs cl
         JOIN agents a ON cl.agent_id = a.id
         WHERE cl.stream = 'cost' AND a.project_id IN (${placeholders})
         GROUP BY cl.run_id
       ) latest
       ON c.id = latest.max_id`
    ).all(...projectIds) as any[];
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const c of costRows) {
      try {
        const data = JSON.parse(c.content);
        totalCost += data.cost_usd || 0;
        totalInputTokens += data.input_tokens || 0;
        totalOutputTokens += data.output_tokens || 0;
      } catch {}
    }

    // Last activity per project (most recent agent started_at or issue updated_at)
    const projectActivity = db.prepare(
      `SELECT p.id,
        MAX(COALESCE(a.started_at, a.finished_at)) as last_agent_activity,
        MAX(i.updated_at) as last_issue_activity
       FROM projects p
       LEFT JOIN agents a ON a.project_id = p.id
       LEFT JOIN issues i ON i.project_id = p.id
       WHERE p.id IN (${placeholders})
       GROUP BY p.id`
    ).all(...projectIds) as any[];

    const lastActivityMap: Record<string, string | null> = {};
    for (const row of projectActivity) {
      const times = [row.last_agent_activity, row.last_issue_activity].filter(Boolean);
      lastActivityMap[row.id] = times.length ? times.sort().pop()! : null;
    }

    // Pending approval count
    const approvalCount = db.prepare(
      `SELECT COUNT(*) as count FROM approval_requests WHERE project_id IN (${placeholders}) AND status = 'pending'`
    ).get(...projectIds) as any;

    return {
      agents: { total: agentStats.total || 0, running: agentStats.running || 0, error_count: agentStats.error_count || 0 },
      issues: { total: issueStats.total || 0, open: issueStats.open_count || 0 },
      pending_approvals: approvalCount?.count || 0,
      total_cost_usd: totalCost,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      last_activity: lastActivityMap,
    };
  });

  // Dashboard usage by project — stacked bar chart data
  fastify.get<{ Querystring: { period?: string } }>('/api/dashboard/usage-by-project', async (request) => {
    const db = getDatabase();
    const period = request.query.period || 'day';
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);

    if (projectIds.length === 0) {
      return {
        period,
        time_buckets: [],
        projects: [],
        data: {},
      };
    }

    const placeholders = buildSqlPlaceholders(projectIds);

    // Only last cost record per run_id (cost is cumulative)
    const rows = db.prepare(
      `SELECT c.content, c.created_at, p.id as project_id, p.name as project_name
       FROM conversation_logs c
       INNER JOIN (
         SELECT MAX(cl.id) as max_id
         FROM conversation_logs cl
         JOIN agents a2 ON cl.agent_id = a2.id
         WHERE cl.stream = 'cost' AND a2.project_id IN (${placeholders})
         GROUP BY cl.run_id
       ) latest ON c.id = latest.max_id
       JOIN agents a ON c.agent_id = a.id
       JOIN projects p ON a.project_id = p.id
       ORDER BY c.created_at`
    ).all(...projectIds) as any[];

    // Aggregate by time bucket + project
    const buckets: Record<string, Record<string, { cost: number; input_tokens: number; output_tokens: number }>> = {};
    const projectNames: Record<string, string> = {};

    for (const row of rows) {
      try {
        const data = JSON.parse(row.content);
        const costUsd = data.cost_usd || 0;
        const inputTokens = data.input_tokens || 0;
        const outputTokens = data.output_tokens || 0;
        if (!row.created_at) continue;

        let key: string;
        const date = row.created_at.slice(0, 10);
        if (period === 'hour') {
          key = row.created_at.slice(0, 13);
        } else if (period === 'week') {
          const d = new Date(date);
          d.setDate(d.getDate() - d.getDay());
          key = d.toISOString().slice(0, 10);
        } else if (period === 'month') {
          key = date.slice(0, 7);
        } else {
          key = date;
        }

        projectNames[row.project_id] = row.project_name;
        if (!buckets[key]) buckets[key] = {};
        if (!buckets[key][row.project_id]) buckets[key][row.project_id] = { cost: 0, input_tokens: 0, output_tokens: 0 };
        buckets[key][row.project_id].cost += costUsd;
        buckets[key][row.project_id].input_tokens += inputTokens;
        buckets[key][row.project_id].output_tokens += outputTokens;
      } catch {}
    }

    const timeBuckets = Object.keys(buckets).sort();
    const projects = Object.entries(projectNames).map(([id, name]) => ({ id, name }));

    return {
      period,
      time_buckets: timeBuckets,
      projects,
      data: Object.fromEntries(
        timeBuckets.map(t => [t, buckets[t]])
      ),
    };
  });

  // Dashboard activity stream — global timeline across all projects
  fastify.get<{ Querystring: { limit?: string; project_id?: string } }>('/api/dashboard/activity-stream', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);
    const filterProjectId = request.query.project_id;

    if (projectIds.length === 0) return [];

    const ids = filterProjectId && projectIds.includes(filterProjectId) ? [filterProjectId] : projectIds;
    const placeholders = buildSqlPlaceholders(ids);

    // Single UNION ALL query instead of 5 separate queries
    const all = db.prepare(`
      SELECT * FROM (
        SELECT 'issue_created' as event_type, i.id as object_id, i.number, i.title, i.status,
               i.created_by as actor, i.created_at as time, p.id as project_id, p.name as project_name,
               NULL as body, NULL as issue_number, NULL as issue_title, NULL as issue_id,
               NULL as agent_name, NULL as agent_status, NULL as approval_status, NULL as risk_level
        FROM issues i JOIN projects p ON i.project_id = p.id
        WHERE i.project_id IN (${placeholders})
        ORDER BY i.created_at DESC LIMIT ?
      )
      UNION ALL SELECT * FROM (
        SELECT 'issue_status_change', i.id, i.number, i.title, i.status,
               NULL, i.updated_at, p.id, p.name,
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM issues i JOIN projects p ON i.project_id = p.id
        WHERE i.project_id IN (${placeholders}) AND i.updated_at != i.created_at
        ORDER BY i.updated_at DESC LIMIT ?
      )
      UNION ALL SELECT * FROM (
        SELECT 'comment', c.id, NULL, NULL, NULL,
               c.author_id, c.created_at, p.id, p.name,
               c.body, i.number, i.title, i.id, NULL, NULL, NULL, NULL
        FROM issue_comments c JOIN issues i ON c.issue_id = i.id JOIN projects p ON i.project_id = p.id
        WHERE i.project_id IN (${placeholders})
        ORDER BY c.created_at DESC LIMIT ?
      )
      UNION ALL SELECT * FROM (
        SELECT CASE WHEN a.status = 'running' THEN 'agent_started' ELSE 'agent_stopped' END,
               a.id, NULL, NULL, NULL,
               NULL, COALESCE(a.started_at, a.finished_at), p.id, p.name,
               NULL, NULL, NULL, NULL, a.name, a.status, NULL, NULL
        FROM agents a JOIN projects p ON a.project_id = p.id
        WHERE a.project_id IN (${placeholders}) AND (a.started_at IS NOT NULL OR a.finished_at IS NOT NULL)
        ORDER BY COALESCE(a.started_at, a.finished_at) DESC LIMIT ?
      )
      UNION ALL SELECT * FROM (
        SELECT CASE WHEN ar.status = 'pending' THEN 'approval_created' ELSE 'approval_decided' END,
               ar.id, NULL, ar.title, NULL,
               NULL, COALESCE(ar.decided_at, ar.created_at), p.id, p.name,
               NULL, NULL, NULL, NULL, ag.name, NULL, ar.status, ar.risk_level
        FROM approval_requests ar
        JOIN projects p ON ar.project_id = p.id
        JOIN agents ag ON ar.agent_id = ag.id
        WHERE ar.project_id IN (${placeholders})
        ORDER BY COALESCE(ar.decided_at, ar.created_at) DESC LIMIT ?
      )
      ORDER BY time DESC LIMIT ?
    `).all(...ids, limit, ...ids, limit, ...ids, limit, ...ids, limit, ...ids, limit, limit) as any[];

    return all;
  });

  // Dashboard agents overview — all agents across all projects
  fastify.get<{ Querystring: { status?: string } }>('/api/dashboard/agents', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);
    const statusFilter = request.query.status;

    if (projectIds.length === 0) return [];

    const placeholders = buildSqlPlaceholders(projectIds);
    let query = `SELECT a.id, a.name, a.role, a.status, a.is_controller, a.started_at, a.finished_at, a.paused,
                        p.id as project_id, p.name as project_name
                 FROM agents a JOIN projects p ON a.project_id = p.id
                 WHERE a.project_id IN (${placeholders})`;
    const params: any[] = [...projectIds];

    if (statusFilter) {
      query += ` AND a.status = ?`;
      params.push(statusFilter);
    }

    query += ` ORDER BY CASE a.status WHEN 'running' THEN 0 WHEN 'error' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, a.name`;

    const agents = db.prepare(query).all(...params) as any[];

    // Attach current issue for each agent
    const agentIds = agents.map((a: any) => a.id);
    if (agentIds.length > 0) {
      const issueMap: Record<string, any> = {};
      const issuePlaceholders = buildSqlPlaceholders(agentIds);
      const currentIssues = db.prepare(
        `SELECT assigned_to, number, title FROM issues
         WHERE assigned_to IN (${issuePlaceholders}) AND status = 'in_progress'
         ORDER BY updated_at DESC`
      ).all(...agentIds) as any[];
      for (const issue of currentIssues) {
        if (!issueMap[issue.assigned_to]) {
          issueMap[issue.assigned_to] = { number: issue.number, title: issue.title };
        }
      }
      for (const agent of agents) {
        (agent as any).current_issue = issueMap[agent.id] || null;
      }
    }

    return agents;
  });

  // Dashboard today's cost — for cost alert
  fastify.get('/api/dashboard/today-cost', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);

    if (projectIds.length === 0) return { today_cost_usd: 0, by_project: {} };

    const placeholders = buildSqlPlaceholders(projectIds);
    const today = new Date().toISOString().slice(0, 10);

    const rows = db.prepare(
      `SELECT c.content, p.id as project_id, p.name as project_name
       FROM conversation_logs c
       INNER JOIN (
         SELECT MAX(cl.id) as max_id
         FROM conversation_logs cl
         JOIN agents a ON cl.agent_id = a.id
         WHERE cl.stream = 'cost' AND a.project_id IN (${placeholders}) AND cl.created_at >= ?
         GROUP BY cl.run_id
       ) latest ON c.id = latest.max_id
       JOIN agents a ON c.agent_id = a.id
       JOIN projects p ON a.project_id = p.id`
    ).all(...projectIds, today + ' 00:00:00') as any[];

    let todayCost = 0;
    const byProject: Record<string, { name: string; cost: number }> = {};

    for (const row of rows) {
      try {
        const data = JSON.parse(row.content);
        const cost = data.cost_usd || 0;
        todayCost += cost;
        if (!byProject[row.project_id]) byProject[row.project_id] = { name: row.project_name, cost: 0 };
        byProject[row.project_id].cost += cost;
      } catch {}
    }

    return { today_cost_usd: todayCost, by_project: byProject };
  });

  // Generate project metadata from user description using AI
  fastify.post<{ Body: { description: string; tool_path: string; command_type?: string | null } }>('/api/generate-project', async (request, reply) => {
    const { description, tool_path, command_type } = request.body;
    if (!description) return reply.code(400).send({ error: 'description is required' });

    const tool = (tool_path || config.defaultCommandTemplate || '').trim() || 'cld';
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
      const lowerTool = tool.toLowerCase();
      const resolvedCommandType = resolveCommandType(command_type, tool);
      const toolBinary = tool.split(/\s+/).filter(Boolean)[0] || tool;
      let cmd: string;

      if (resolvedCommandType === 'claude') {
        // Claude Code / cld — keep existing non-interactive print mode
        cmd = `${tool} -p`;
      } else if (lowerTool.startsWith('gemini')) {
        // Gemini CLI — use text output mode with -p prompt flag
        cmd = `${tool} --output-format text -p`;
      } else if (resolvedCommandType === 'codex') {
        // Codex CLI — non-interactive exec. We avoid --json here to keep
        // output as plain text so that JSON extraction via regex still works.
        // PROMPT is read from stdin when '-' is used.
        cmd = `${toolBinary} exec --sandbox workspace-write --skip-git-repo-check -`;
      } else {
        // Fallback: run the tool as-is, reading prompt from stdin
        cmd = tool;
      }

      const result = execSync(`echo ${JSON.stringify(prompt)} | ${cmd}`, {
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
  fastify.get<{ Params: { id: string }; Querystring: { period?: string } }>('/api/projects/:id/costs', async (request, reply) => {
    const db = getDatabase();
    const pid = request.params.id;
    const period = request.query.period; // day | week | month
    const access = ensureProjectAccess(db, request, reply, pid);
    if (!access) return;

    // Only last cost record per run_id (cost is cumulative)
    const costs = db.prepare(
      `SELECT c.content, c.run_id, c.created_at, a.name as agent_name
       FROM conversation_logs c
       INNER JOIN (SELECT MAX(cl.id) as max_id FROM conversation_logs cl JOIN agents al ON cl.agent_id = al.id WHERE al.project_id = ? AND cl.stream = 'cost' GROUP BY cl.run_id) latest ON c.id = latest.max_id
       JOIN agents a ON c.agent_id = a.id
       ORDER BY c.created_at`
    ).all(pid) as any[];

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const byAgent: Record<string, { cost: number; runs: number; input_tokens: number; output_tokens: number }> = {};
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

        if (!byAgent[c.agent_name]) byAgent[c.agent_name] = { cost: 0, runs: 0, input_tokens: 0, output_tokens: 0 };
        byAgent[c.agent_name].cost += costUsd;
        byAgent[c.agent_name].runs++;
        byAgent[c.agent_name].input_tokens += inputTokens;
        byAgent[c.agent_name].output_tokens += outputTokens;

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
          if (period === 'hour') {
            key = c.created_at.slice(0, 13); // YYYY-MM-DD HH
          } else if (period === 'day') {
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
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/projects/:id/git-log', async (request, reply) => {
    const db = getDatabase();
    const pid = request.params.id;
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
    const access = ensureProjectAccess(db, request, reply, pid);
    if (!access) return;

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
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/projects/:id/activity', async (request, reply) => {
    const db = getDatabase();
    const limit = parseInt(request.query.limit || '50', 10);
    const pid = request.params.id;
    const access = ensureProjectAccess(db, request, reply, pid);
    if (!access) return;

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

  // Recent orchestration decision runs (for graph visualization)
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/projects/:id/orchestration-runs',
    async (request, reply) => {
      const db = getDatabase();
      const pid = request.params.id;
      const limit = Math.min(Math.max(parseInt(request.query.limit || '20', 10), 1), 100);
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const rows = db.prepare(
        "SELECT id, project_id, engine, decision, controller_agent_id, controller_started, controller_run_id, controller_pid, dispatch_count, dispatch_summary, reasons, actions, dispatch_results, created_at FROM orchestration_runs WHERE project_id = ? ORDER BY id DESC LIMIT ?"
      ).all(pid, limit) as any[];

      const parseJson = <T>(raw: unknown, fallback: T): T => {
        if (typeof raw !== 'string' || raw.trim() === '') return fallback;
        try { return JSON.parse(raw) as T; } catch { return fallback; }
      };

      return rows.map((row) => ({
        ...row,
        controller_started: !!row.controller_started,
        reasons: parseJson<string[]>(row.reasons, []),
        actions: parseJson<any[]>(row.actions, []),
        dispatch_results: parseJson<any[]>(row.dispatch_results, []),
      }));
    }
  );

  // List projects (with optional embedded stats for dashboard performance)
  fastify.get<{ Querystring: { with_stats?: string } }>('/api/projects', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projects = listAccessibleProjects(db, user, localhostBypass).map((project) =>
      serializeProject(db, project, user, localhostBypass)
    );

    if (request.query.with_stats !== '1') return projects;

    // Batch stats: single query per table instead of N queries per project
    const pIds = projects.map((p: any) => p.id);
    if (pIds.length === 0) return projects;
    const ph = pIds.map(() => '?').join(',');

    const agentRows = db.prepare(
      `SELECT project_id, COUNT(*) as total,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as error_count
       FROM agents WHERE project_id IN (${ph}) GROUP BY project_id`
    ).all(...pIds) as any[];
    const agentMap = new Map(agentRows.map((r: any) => [r.project_id, r]));

    const issueRows = db.prepare(
      `SELECT project_id, COUNT(*) as total,
              SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) as open_count
       FROM issues WHERE project_id IN (${ph}) GROUP BY project_id`
    ).all(...pIds) as any[];
    const issueMap = new Map(issueRows.map((r: any) => [r.project_id, r]));

    const userIssueRows = db.prepare(
      `SELECT project_id, number, title, priority FROM issues
       WHERE project_id IN (${ph}) AND assigned_to = 'user' AND status IN ('open','in_progress')
       ORDER BY priority DESC`
    ).all(...pIds) as any[];
    const userIssueMap = new Map<string, any[]>();
    for (const r of userIssueRows) {
      const arr = userIssueMap.get(r.project_id);
      if (arr) { if (arr.length < 10) arr.push(r); } else userIssueMap.set(r.project_id, [r]);
    }

    const controllerRows = db.prepare(
      `SELECT project_id, id FROM agents WHERE project_id IN (${ph}) AND is_controller = 1`
    ).all(...pIds) as any[];
    const controllerMap = new Map(controllerRows.map((r: any) => [r.project_id, r.id]));

    return projects.map((p: any) => {
      const as = agentMap.get(p.id);
      const is = issueMap.get(p.id);
      return {
        ...p,
        stats: {
          agents: as?.total || 0,
          running: as?.running || 0,
          agentError: as?.error_count || 0,
          issues: is?.total || 0,
          openIssues: is?.open_count || 0,
          userIssues: userIssueMap.get(p.id) || [],
          controllerAgentId: controllerMap.get(p.id) || null,
        },
      };
    });
  });

  // Create project
  fastify.post<{ Body: CreateProjectInput }>('/api/projects', async (request, reply) => {
    const { name, description, task_description, command_template, command_type, orchestrator_engine, working_directory, controller_role } = request.body as any;

    if (!task_description) {
      return reply.code(400).send({ error: 'task_description is required' });
    }

    const db = getDatabase();
    const id = uuidv4();
    const tmpl = command_template || config.defaultCommandTemplate;
    const resolvedCommandType = resolveCommandType(command_type, tmpl);
    const orchestratorEngine = normalizeOrchestratorEngine(orchestrator_engine);
    const { user } = getProjectRequestContext(request);
    const ownerId = user && !isLegacyAuthUser(user) ? user.id : null;

    if (orchestrator_engine !== undefined && orchestratorEngine === null) {
      return reply.code(400).send({ error: 'Invalid orchestrator_engine. Use native or langgraph.' });
    }

    db.prepare(`
      INSERT INTO projects (id, name, description, task_description, command_template, command_type, orchestrator_engine, owner_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(id, name, description || '', task_description, tmpl, resolvedCommandType, orchestratorEngine || config.defaultOrchestratorEngine, ownerId);

    if (ownerId) {
      db.prepare(`
        INSERT INTO project_members (id, project_id, user_id, role)
        VALUES (?, ?, ?, 'owner')
        ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'owner'
      `).run(uuidv4(), id, ownerId);
    }

    // Create default controller agent (with Sonnet model for cost efficiency)
    const controllerId = uuidv4();
    const ctrlRole = controller_role || 'Main controller agent that manages and coordinates other agents';
    const ctrlCommandConfig = buildControllerCommandConfig({ commandTemplate: tmpl, commandType: resolvedCommandType });
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, working_directory, command_template, command_type, status)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'idle')
    `).run(
      controllerId,
      id,
      `${name || 'project'}-controller`,
      ctrlRole,
      working_directory || null,
      ctrlCommandConfig.commandTemplate,
      ctrlCommandConfig.commandType
    );

    // Create default assistant agent
    const assistantId = uuidv4();
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, working_directory, status)
      VALUES (?, ?, ?, ?, 0, ?, 'idle')
    `).run(assistantId, id, `${name || 'project'}-assistant`, 'Assistant to the controller. Handles analysis, code execution, data processing, and research tasks delegated by the controller.', working_directory || null);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;

    return reply.code(201).send(serializeProject(db, project, user, false));
  });

  // Get project
  fastify.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.id);
    if (!access) return;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return serializeProject(db, project, access.user, access.localhostBypass);
  });

  // Update project
  fastify.put<{ Params: { id: string }; Body: Partial<CreateProjectInput> & { status?: string } }>('/api/projects/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id) as Project | undefined;
    if (!existing) return reply.code(404).send({ error: 'Project not found' });

    const { name, description, task_description, command_template, command_type, orchestrator_engine, status, color } = request.body as any;
    const hasCommandTemplate = Object.prototype.hasOwnProperty.call(request.body || {}, 'command_template');
    const hasCommandType = Object.prototype.hasOwnProperty.call(request.body || {}, 'command_type');
    const nextCommandTemplate = hasCommandTemplate
      ? (typeof command_template === 'string' ? command_template.trim() || config.defaultCommandTemplate : config.defaultCommandTemplate)
      : existing.command_template;
    const nextCommandType = hasCommandType || hasCommandTemplate
      ? resolveCommandType(hasCommandType ? command_type : existing.command_type, nextCommandTemplate)
      : existing.command_type;

    const orchestratorEngine = normalizeOrchestratorEngine(orchestrator_engine);
    if (orchestrator_engine !== undefined && orchestratorEngine === null) {
      return reply.code(400).send({ error: 'Invalid orchestrator_engine. Use native or langgraph.' });
    }

    db.prepare(`
      UPDATE projects SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        task_description = COALESCE(?, task_description),
        command_template = COALESCE(?, command_template),
        command_type = COALESCE(?, command_type),
        orchestrator_engine = COALESCE(?, orchestrator_engine),
        status = COALESCE(?, status),
        color = COALESCE(?, color),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? null, description ?? null, task_description ?? null,
      hasCommandTemplate ? nextCommandTemplate : null, (hasCommandType || hasCommandTemplate) ? nextCommandType : null,
      orchestratorEngine ?? null,
      status ?? null, color ?? null,
      request.params.id
    );

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id) as Project;

    return serializeProject(db, updated, access.user, access.localhostBypass);
  });

  fastify.get<{ Params: { id: string } }>('/api/projects/:id/members', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.id);
    if (!access) return;

    const members = db.prepare(
      `SELECT pm.*,
              u.username,
              u.display_name,
              u.role as user_role
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY CASE pm.role WHEN 'owner' THEN 0 ELSE 1 END, COALESCE(u.display_name, u.username), u.username`
    ).all(request.params.id) as Array<ProjectMember & {
      username: string;
      display_name: string;
      user_role: string;
    }>;

    return { members };
  });

  fastify.post<{ Params: { id: string }; Body: { user_id?: string; username?: string; role?: string } }>(
    '/api/projects/:id/members',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      const { user_id, username, role } = request.body as any;
      if (!user_id && !username) {
        return reply.code(400).send({ error: 'user_id or username is required' });
      }
      const validRoles = ['member', 'editor', 'owner'];
      const assignRole = role && validRoles.includes(role) ? role : 'member';

      const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(request.params.id) as { owner_id: string | null } | undefined;
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const targetUser = user_id
        ? db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(user_id) as any
        : db.prepare('SELECT id, username, display_name, role FROM users WHERE username = ?').get(username) as any;
      if (!targetUser) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (project.owner_id === targetUser.id) {
        return reply.code(400).send({ error: 'Project owner already has access' });
      }

      const existingMember = db.prepare(
        'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?'
      ).get(request.params.id, targetUser.id) as ProjectMember | undefined;

      if (existingMember?.role === 'owner') {
        return reply.code(400).send({ error: 'Cannot change project owner membership via share API' });
      }

      if (existingMember) {
        db.prepare("UPDATE project_members SET role = ? WHERE id = ?").run(assignRole, existingMember.id);
      } else {
        db.prepare(
          "INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, ?)"
        ).run(uuidv4(), request.params.id, targetUser.id, assignRole);
      }

      const member = db.prepare(
        `SELECT pm.*,
                u.username,
                u.display_name,
                u.role as user_role
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ? AND pm.user_id = ?`
      ).get(request.params.id, targetUser.id);

      return reply.code(existingMember ? 200 : 201).send(member);
    }
  );

  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/api/projects/:id/members/:userId',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(request.params.id) as { owner_id: string | null } | undefined;
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      if (project.owner_id === request.params.userId) {
        return reply.code(400).send({ error: 'Cannot remove project owner' });
      }

      const existingMember = db.prepare(
        'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?'
      ).get(request.params.id, request.params.userId) as ProjectMember | undefined;
      if (!existingMember) {
        return reply.code(404).send({ error: 'Project member not found' });
      }

      db.prepare('DELETE FROM project_members WHERE id = ?').run(existingMember.id);
      return { success: true };
    }
  );

  // Update member role
  fastify.patch<{ Params: { id: string; userId: string }; Body: { role: string } }>(
    '/api/projects/:id/members/:userId',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      const { role } = request.body as any;
      const validRoles = ['member', 'editor', 'owner'];
      if (!role || !validRoles.includes(role)) {
        return reply.code(400).send({ error: 'role must be one of: member, editor, owner' });
      }

      const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(request.params.id) as { owner_id: string | null } | undefined;
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      if (project.owner_id === request.params.userId) {
        return reply.code(400).send({ error: 'Cannot change project owner role' });
      }

      const existingMember = db.prepare(
        'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?'
      ).get(request.params.id, request.params.userId) as ProjectMember | undefined;
      if (!existingMember) {
        return reply.code(404).send({ error: 'Project member not found' });
      }

      db.prepare('UPDATE project_members SET role = ? WHERE id = ?').run(role, existingMember.id);

      const member = db.prepare(
        `SELECT pm.*, u.username, u.display_name, u.role as user_role
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.id = ?`
      ).get(existingMember.id);

      return member;
    }
  );

  // Export project data as JSON
  fastify.get<{ Params: { id: string } }>('/api/projects/:id/export', async (request, reply) => {
    const db = getDatabase();
    const pid = request.params.id;
    const access = ensureProjectAccess(db, request, reply, pid);
    if (!access) return;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    const agents = db.prepare('SELECT id, name, role, is_controller, status, started_at, finished_at, created_at FROM agents WHERE project_id = ?').all(pid);
    const issues = db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY number').all(pid);
    const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ?').all(pid);

    // Cost summary — only last cost record per run_id (cost is cumulative)
    const costRows = db.prepare(
      `SELECT c.content FROM conversation_logs c
       INNER JOIN (SELECT MAX(cl.id) as max_id FROM conversation_logs cl JOIN agents al ON cl.agent_id = al.id WHERE al.project_id = ? AND cl.stream = 'cost' GROUP BY cl.run_id) latest
       ON c.id = latest.max_id`
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
    const access = ensureProjectAccess(db, request, reply, pid);
    if (!access) return;
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
    const access = ensureProjectAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    if (access.permission.level === 'editor') {
      return reply.code(403).send({ error: 'Only project owners or admins can delete projects' });
    }
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Project not found' });

    // Stop all running agents before deleting
    const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(request.params.id) as Agent[];
    for (const agent of agents) {
      if (isAgentRunning(agent.id)) stopAgentProcess(agent.id);
    }

    try {
      db.prepare('DELETE FROM projects WHERE id = ?').run(request.params.id);
    } catch (err) {
      request.log.error({ err, projectId: request.params.id }, 'Failed to delete project');
      const message = err instanceof Error ? err.message : String(err);
      if (/foreign key|constraint|agents_old|issues_old|projects_old/i.test(message)) {
        return reply.code(409).send({
          error: 'Project could not be deleted because related records still block deletion. Please restart the server to apply database migrations and retry.',
        });
      }
      throw err;
    }
    return { success: true };
  });
}
