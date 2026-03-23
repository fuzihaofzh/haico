import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDatabase } from '../db/database';
import { Agent } from '../types';
import { broadcastToAgent, broadcastToProject } from './websocket';
import logger from '../logger';

const runningProcesses = new Map<string, ChildProcess>();
const PROMPT_DIR = path.join(os.tmpdir(), 'argus-prompts');

// Track consecutive error count per agent for session invalidation
const agentErrorCount = new Map<string, number>();
const MAX_CONSECUTIVE_ERRORS = 3;

function writePromptFile(runId: string, prompt: string): string {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const fp = path.join(PROMPT_DIR, runId + '.txt');
  fs.writeFileSync(fp, prompt, 'utf-8');
  return fp;
}

function cleanupPromptFile(fp: string): void {
  try { fs.unlinkSync(fp); } catch (e) { logger.error(e, 'Failed to cleanup prompt file %s', fp); }
}

export type OnAgentFinishCallback = (agent: Agent, exitCode: number | null) => void;
let onAgentFinish: OnAgentFinishCallback | null = null;

export function setOnAgentFinish(cb: OnAgentFinishCallback): void {
  onAgentFinish = cb;
}

export function startAgentProcess(
  agent: Agent,
  prompt: string,
  commandTemplate: string
): { runId: string; pid: number } {
  const db = getDatabase();
  const runId = uuidv4();

  // Write prompt to temp file
  const promptFile = writePromptFile(runId, prompt);

  // commandTemplate is just the tool path (e.g., "cld", "claude", "/usr/bin/claude")
  // We build the full command with all necessary flags
  const toolPath = commandTemplate.trim() || 'claude';
  // Session strategy: resume existing session, auto-reset after session_max_runs
  const maxRuns = (agent as any).session_max_runs || 10;
  const runCount = ((agent as any).session_run_count || 0) + 1;
  const shouldReset = runCount > maxRuns;
  const existingSessionId = shouldReset ? null : agent.session_id;
  let sessionId = existingSessionId || uuidv4();

  // Update run count (reset to 1 if new session)
  db.prepare('UPDATE agents SET session_run_count = ? WHERE id = ?')
    .run(shouldReset ? 1 : runCount, agent.id);
  const sessionFlag = existingSessionId ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  const command = `${toolPath} -p --output-format stream-json --verbose ${sessionFlag} --allowedTools "Bash Edit Read Write Glob Grep NotebookEdit WebFetch WebSearch Agent"`;

  // Update agent status
  db.prepare(`
    UPDATE agents SET status = 'running', last_prompt = ?, session_id = ?, started_at = datetime('now'), pid = NULL
    WHERE id = ?
  `).run(prompt, sessionId, agent.id);

  broadcastToProject(agent.project_id, {
    type: 'agent_status', projectId: agent.project_id,
    data: { agentId: agent.id, status: 'running' },
  });

  let cwd = agent.working_directory || process.cwd();
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2));

  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    env: {
      ...process.env,
      no_proxy: [process.env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
      NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
      ARGUS_PROMPT: prompt,
      ARGUS_PROMPT_FILE: promptFile,
      ARGUS_SESSION_ID: sessionId,
      ARGUS_AGENT_ID: agent.id,
      ARGUS_RUN_ID: runId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Feed prompt via stdin (so command template doesn't need to handle it)
  if (child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  const pid = child.pid || 0;
  runningProcesses.set(agent.id, child);

  db.prepare('UPDATE agents SET pid = ? WHERE id = ?').run(pid, agent.id);

  const logStmt = db.prepare(
    'INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, ?)'
  );

  // Log the input prompt
  logStmt.run(agent.id, runId, prompt, 'stdin');

  // Always use stream-json output format (set in command building above)
  const isStreamJson = true;
  let stdoutBuffer = '';

  function logAndBroadcast(content: string, stream: string) {
    if (!content.trim()) return;
    logStmt.run(agent.id, runId, content, stream);
    broadcastToAgent(agent.id, { type: 'output', stream, content, runId });
  }

  function parseStreamJsonLine(line: string) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            logAndBroadcast(block.text + '\n', 'stdout');
          } else if (block.type === 'tool_use') {
            logAndBroadcast(`[Tool: ${block.name}] ${JSON.stringify(block.input).slice(0, 200)}\n`, 'stdout');
          }
        }
      } else if (obj.type === 'user' && obj.tool_use_result !== undefined) {
        const raw = obj.tool_use_result;
        const result = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
        logAndBroadcast(`[Result] ${result}\n`, 'stdout');
      } else if (obj.type === 'result') {
        if (obj.result) {
          logAndBroadcast('\n--- Final Result ---\n' + obj.result + '\n', 'stdout');
        }
        // Track cost/usage — only if there's actual data
        if (obj.total_cost_usd > 0 || obj.usage?.input_tokens > 0 || obj.usage?.output_tokens > 0) {
          const costUsd = obj.total_cost_usd || 0;
          const input = obj.usage?.input_tokens || 0;
          const output = obj.usage?.output_tokens || 0;
          const cacheRead = obj.usage?.cache_read_input_tokens || 0;
          logAndBroadcast(`\n--- Cost: $${costUsd.toFixed(4)} | Tokens: ${input} in, ${output} out, ${cacheRead} cache ---\n`, 'stdout');
          try {
            db.prepare("INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'cost')")
              .run(agent.id, runId, JSON.stringify({ cost_usd: costUsd, input_tokens: input, output_tokens: output, cache_read: cacheRead, duration_ms: obj.duration_ms }));
          } catch {}
        }
      }
    } catch {
      // Not JSON (proxychains noise etc), skip or log as-is
      if (!line.includes('proxychains') && !line.includes('Executing through proxy') && !line.includes('Port 7897')) {
        logAndBroadcast(line + '\n', 'stdout');
      }
    }
  }

  const handleData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
    const raw = data.toString();
    if (stream === 'stderr') {
      // Skip proxychains noise in stderr
      if (!raw.includes('proxychains')) {
        logAndBroadcast(raw, 'stderr');
      }
      return;
    }

    if (!isStreamJson) {
      logAndBroadcast(raw, 'stdout');
      return;
    }

    // Parse stream-json line by line
    stdoutBuffer += raw;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) parseStreamJsonLine(line.trim());
    }
  };

  child.stdout?.on('data', handleData('stdout'));
  child.stderr?.on('data', handleData('stderr'));

  child.on('close', (code) => {
    runningProcesses.delete(agent.id);
    cleanupPromptFile(promptFile);
    const status = code === 0 ? 'idle' : 'error';

    if (status === 'error') {
      // P1: Track consecutive errors — only clear session after MAX_CONSECUTIVE_ERRORS
      const errorCount = (agentErrorCount.get(agent.id) || 0) + 1;
      agentErrorCount.set(agent.id, errorCount);

      if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
        logger.info(`Agent ${agent.id} hit ${errorCount} consecutive errors, clearing session`);
        db.prepare(`
          UPDATE agents SET status = ?, pid = NULL, finished_at = datetime('now'), session_id = NULL WHERE id = ?
        `).run(status, agent.id);
        agentErrorCount.delete(agent.id);
      } else {
        logger.info(`Agent ${agent.id} error (${errorCount}/${MAX_CONSECUTIVE_ERRORS}), preserving session for reuse`);
        db.prepare(`
          UPDATE agents SET status = ?, pid = NULL, finished_at = datetime('now') WHERE id = ?
        `).run(status, agent.id);
      }
    } else {
      // Success — reset error count
      agentErrorCount.delete(agent.id);
      db.prepare(`
        UPDATE agents SET status = ?, pid = NULL, finished_at = datetime('now') WHERE id = ?
      `).run(status, agent.id);
    }

    broadcastToAgent(agent.id, { type: 'exit', code, runId });
    broadcastToProject(agent.project_id, {
      type: 'agent_status', projectId: agent.project_id,
      data: { agentId: agent.id, status },
    });

    // Fetch updated agent and trigger callback
    if (onAgentFinish) {
      const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as Agent;
      if (updated) {
        onAgentFinish(updated, code);
      }
    }
  });

  child.on('error', (err: any) => {
    logger.error(`Spawn error: ${err.message} code=${err.code} path=${err.path} syscall=${err.syscall} cwd=${cwd}`);
    runningProcesses.delete(agent.id);
    cleanupPromptFile(promptFile);

    // If resume failed, retry with a fresh session
    if (existingSessionId && err.code === 'ENOENT') {
      logger.info(`Retrying agent ${agent.id} with fresh session (resume failed)`);
      const freshAgent = { ...agent, session_id: null };
      db.prepare("UPDATE agents SET session_id = NULL, status = 'idle' WHERE id = ?").run(agent.id);
      startAgentProcess(freshAgent, prompt, commandTemplate);
      return;
    }

    db.prepare(`
      UPDATE agents SET status = 'error', pid = NULL, finished_at = datetime('now') WHERE id = ?
    `).run(agent.id);
    logStmt.run(agent.id, runId, `Process error: ${err.message}`, 'stderr');
    broadcastToAgent(agent.id, { type: 'error', message: err.message, runId });
  });

  return { runId, pid };
}

export function stopAgentProcess(agentId: string): boolean {
  const child = runningProcesses.get(agentId);
  if (!child) return false;

  child.kill('SIGTERM');
  // Force kill after 5 seconds
  setTimeout(() => {
    if (runningProcesses.has(agentId)) {
      child.kill('SIGKILL');
    }
  }, 5000);

  return true;
}

export function isAgentRunning(agentId: string): boolean {
  return runningProcesses.has(agentId);
}

export function getRunningAgentIds(): string[] {
  return Array.from(runningProcesses.keys());
}

export function stopAllProcesses(): void {
  for (const [agentId, child] of runningProcesses) {
    logger.info(`Killing agent ${agentId} (pid: ${child.pid})`);
    child.kill('SIGTERM');
  }
  // Force kill after 3 seconds
  if (runningProcesses.size > 0) {
    setTimeout(() => {
      for (const [agentId, child] of runningProcesses) {
        logger.info(`Force killing agent ${agentId}`);
        child.kill('SIGKILL');
      }
    }, 3000);
  }
}
