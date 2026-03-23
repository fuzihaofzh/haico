import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { getDatabase } from '../db/database';
import { Agent, Project, CreateAgentInput, StartAgentInput } from '../types';
import { startAgentProcess, stopAgentProcess, isAgentRunning } from '../services/process-manager';
import { buildSystemPrompt } from '../services/system-prompt';
import { config } from '../config';
import { broadcastToProject } from '../services/websocket';

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

    const { name, role, session_id, working_directory, custom_instructions, new_session_per_run, session_max_runs } = request.body as any;
    db.prepare(`
      UPDATE agents SET
        name = COALESCE(?, name),
        role = COALESCE(?, role),
        session_id = COALESCE(?, session_id),
        working_directory = COALESCE(?, working_directory),
        custom_instructions = COALESCE(?, custom_instructions),
        new_session_per_run = COALESCE(?, new_session_per_run),
        session_max_runs = COALESCE(?, session_max_runs)
      WHERE id = ?
    `).run(name ?? null, role ?? null, session_id ?? null, working_directory ?? null, custom_instructions ?? null, new_session_per_run !== undefined ? (new_session_per_run ? 1 : 0) : null, session_max_runs !== undefined ? Math.max(1, parseInt(session_max_runs) || 10) : null, request.params.id);

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
  fastify.post<{ Params: { id: string }; Body: { prompt?: string; force_new_session?: boolean } }>('/api/agents/:id/start', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (agent.paused) {
      return reply.code(409).send({ error: 'Agent is paused. Unpause it first.' });
    }

    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      return reply.code(409).send({ error: 'Agent is already running' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found for this agent' });

    // If force_new_session is requested, clear session_id to start fresh
    if (request.body?.force_new_session) {
      db.prepare('UPDATE agents SET session_id = NULL WHERE id = ?').run(agent.id);
      agent.session_id = null;
    }

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
      // Process not in memory map — try killing PID directly if it exists
      if (agent.pid) {
        try { process.kill(agent.pid, 'SIGTERM'); } catch {}
      }
      db.prepare("UPDATE agents SET status = 'stopped', pid = NULL WHERE id = ?").run(agent.id);
    }

    return { success: true };
  });

  // Pause agent — prevents auto-start and manual start until unpaused
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/pause', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (agent.paused) {
      return reply.code(409).send({ error: 'Agent is already paused' });
    }

    // If running, stop it first
    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      stopAgentProcess(agent.id);
    }

    db.prepare("UPDATE agents SET paused = 1, status = 'stopped' WHERE id = ?").run(agent.id);

    broadcastToProject(agent.project_id, {
      type: 'agent_status', projectId: agent.project_id,
      data: { agentId: agent.id, status: 'stopped', paused: true },
    });

    return { success: true };
  });

  // Unpause agent — allows it to be started again
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/unpause', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (!agent.paused) {
      return reply.code(409).send({ error: 'Agent is not paused' });
    }

    db.prepare("UPDATE agents SET paused = 0, status = 'idle' WHERE id = ?").run(agent.id);

    broadcastToProject(agent.project_id, {
      type: 'agent_status', projectId: agent.project_id,
      data: { agentId: agent.id, status: 'idle', paused: false },
    });

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
      paused: !!agent.paused,
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

  // Get agent cost summary
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/costs', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const costs = db.prepare(
      "SELECT content, run_id, created_at FROM conversation_logs WHERE agent_id = ? AND stream = 'cost' ORDER BY created_at"
    ).all(request.params.id) as any[];

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const runs: Array<{ run_id: string; cost_usd: number; input_tokens: number; output_tokens: number; timestamp: string }> = [];

    for (const c of costs) {
      try {
        const data = JSON.parse(c.content);
        const costUsd = data.cost_usd || 0;
        const inputTokens = data.input_tokens || 0;
        const outputTokens = data.output_tokens || 0;
        totalCost += costUsd;
        totalInput += inputTokens;
        totalOutput += outputTokens;
        runs.push({ run_id: c.run_id, cost_usd: costUsd, input_tokens: inputTokens, output_tokens: outputTokens, timestamp: c.created_at });
      } catch {}
    }

    return {
      total_cost_usd: totalCost,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_runs: runs.length,
      runs,
    };
  });

  // Get logs for a specific run
  fastify.get<{ Params: { id: string; run_id: string } }>('/api/agents/:id/logs/:run_id', async (request) => {
    const db = getDatabase();
    return db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? ORDER BY id'
    ).all(request.params.id, request.params.run_id);
  });

  // List agent runs with summary
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/agents/:id/runs', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);

    // Get distinct run_ids with timestamps
    const runs = db.prepare(`
      SELECT run_id,
        MIN(created_at) as started_at,
        MAX(created_at) as finished_at
      FROM conversation_logs
      WHERE agent_id = ?
      GROUP BY run_id
      ORDER BY MIN(id) DESC
      LIMIT ?
    `).all(request.params.id, limit) as any[];

    const result = runs.map(run => {
      // Get cost data for this run
      const costLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'cost' LIMIT 1"
      ).get(request.params.id, run.run_id) as { content: string } | undefined;

      let costUsd = 0, inputTokens = 0, outputTokens = 0, durationMs = 0;
      if (costLog) {
        try {
          const data = JSON.parse(costLog.content);
          costUsd = data.cost_usd || 0;
          inputTokens = data.input_tokens || 0;
          outputTokens = data.output_tokens || 0;
          durationMs = data.duration_ms || 0;
        } catch {}
      }

      // Count tool calls
      const toolCount = db.prepare(
        "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' AND content LIKE '[Tool:%'"
      ).get(request.params.id, run.run_id) as { c: number };

      // Check if there was an error
      const hasError = db.prepare(
        "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stderr' AND content != ''"
      ).get(request.params.id, run.run_id) as { c: number };

      // Get final result snippet
      const finalResult = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' AND content LIKE '%--- Final Result ---%' LIMIT 1"
      ).get(request.params.id, run.run_id) as { content: string } | undefined;

      const resultSnippet = finalResult?.content?.replace('--- Final Result ---', '').trim().slice(0, 200) || '';

      return {
        run_id: run.run_id,
        started_at: run.started_at,
        finished_at: run.finished_at,
        status: hasError.c > 0 ? 'error' : 'success',
        cost_usd: costUsd,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        duration_ms: durationMs,
        tool_call_count: toolCount.c,
        result_snippet: resultSnippet,
      };
    });

    return { runs: result };
  });

  // Get agent git status
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/git-status', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    let dir = agent.working_directory;
    if (!dir) return { branch: null, recent_commits: [], has_uncommitted: false, diff_stat: '' };
    if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));

    try {
      const gitExec = (cmd: string) => execSync(cmd, { cwd: dir!, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      const branch = gitExec('git branch --show-current') || gitExec('git rev-parse --short HEAD');

      const logOutput = gitExec("git log --format='%H|%s|%ai' -n 5");
      const recent_commits = logOutput ? logOutput.split('\n').map(line => {
        const parts = line.split('|');
        return { hash: parts[0]?.slice(0, 7) || '', message: parts[1] || '', date: parts.slice(2).join('|') };
      }) : [];

      const statusOutput = execSync('git status --porcelain', { cwd: dir!, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const statusLines = statusOutput.split('\n').filter(l => l.length > 0);
      const has_uncommitted = statusLines.length > 0;

      let diff_stat = '';
      if (has_uncommitted) {
        try { diff_stat = gitExec('git diff --stat'); } catch {}
      }

      const uncommitted_files = statusLines.map(line => {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3);
        return { status, file };
      });

      return { branch, recent_commits, has_uncommitted, diff_stat, uncommitted_files };
    } catch {
      return { branch: null, recent_commits: [], has_uncommitted: false, diff_stat: '' };
    }
  });

  // Get structured run report
  fastify.get<{ Params: { id: string; run_id: string } }>('/api/agents/:id/runs/:run_id/report', async (request, reply) => {
    const db = getDatabase();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const logs = db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? ORDER BY id'
    ).all(request.params.id, request.params.run_id) as any[];

    if (!logs.length) return reply.code(404).send({ error: 'Run not found' });

    // Parse logs into structured report
    const toolCalls: Array<{ name: string; input: string; result: string; index: number }> = [];
    const textBlocks: string[] = [];
    const filesChanged = new Set<string>();
    let costData: any = null;
    let finalResult = '';
    let hasError = false;
    let errorMsg = '';

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];

      if (log.stream === 'cost') {
        try { costData = JSON.parse(log.content); } catch {}
        continue;
      }

      if (log.stream === 'stderr' && log.content.trim()) {
        hasError = true;
        errorMsg += log.content;
        continue;
      }

      if (log.stream === 'stdin') continue;

      const content = log.content || '';

      // Parse tool calls
      const toolMatch = content.match(/^\[Tool: (\w+)\] (.*)$/s);
      if (toolMatch) {
        const toolName = toolMatch[1];
        const toolInput = toolMatch[2].trim();

        // Extract file paths from Edit/Write/Read tool calls
        try {
          const inputObj = JSON.parse(toolInput);
          if (inputObj.file_path) filesChanged.add(inputObj.file_path);
          if (inputObj.path) filesChanged.add(inputObj.path);
        } catch {
          // Input was truncated, try to extract file paths with regex
          const pathMatch = toolInput.match(/"(?:file_path|path)"\s*:\s*"([^"]+)"/);
          if (pathMatch) filesChanged.add(pathMatch[1]);
        }

        toolCalls.push({ name: toolName, input: toolInput.slice(0, 300), result: '', index: i });
        continue;
      }

      // Parse results — associate with the preceding tool call
      const resultMatch = content.match(/^\[Result\] (.*)$/s);
      if (resultMatch && toolCalls.length > 0) {
        toolCalls[toolCalls.length - 1].result = resultMatch[1].slice(0, 500);
        continue;
      }

      // Final result
      if (content.includes('--- Final Result ---')) {
        finalResult = content.replace(/.*--- Final Result ---\n?/, '').trim();
        continue;
      }

      // Cost line (formatted)
      if (content.includes('--- Cost:')) continue;

      // Regular text output
      if (content.trim()) {
        textBlocks.push(content.trim());
      }
    }

    // Build summary
    const startedAt = logs[0]?.created_at;
    const finishedAt = logs[logs.length - 1]?.created_at;

    // Tool call frequency
    const toolFreq: Record<string, number> = {};
    for (const tc of toolCalls) {
      toolFreq[tc.name] = (toolFreq[tc.name] || 0) + 1;
    }

    return {
      run_id: request.params.run_id,
      agent_id: request.params.id,
      agent_name: agent.name,
      started_at: startedAt,
      finished_at: finishedAt,
      status: hasError ? 'error' : 'success',
      error_message: errorMsg.slice(0, 1000) || null,
      cost: costData ? {
        total_usd: costData.cost_usd,
        input_tokens: costData.input_tokens,
        output_tokens: costData.output_tokens,
        cache_read: costData.cache_read,
        duration_ms: costData.duration_ms,
      } : null,
      summary: {
        total_tool_calls: toolCalls.length,
        tool_frequency: toolFreq,
        files_changed: Array.from(filesChanged),
        text_output_length: textBlocks.join('').length,
      },
      final_result: finalResult.slice(0, 2000) || null,
      tool_calls: toolCalls.map(tc => ({
        name: tc.name,
        input: tc.input,
        result: tc.result,
      })),
      key_decisions: textBlocks.slice(0, 20).map(t => t.slice(0, 300)),
    };
  });
}
