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

// Track last activity (output) time per agent — used by watchdog to detect stuck agents
const lastActivityTime = new Map<string, number>();
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes with no output = stuck

// Track consecutive error count per agent for session invalidation
const agentErrorCount = new Map<string, number>();
const MAX_CONSECUTIVE_ERRORS = 3;

// Track child process CPU snapshots for watchdog — detect truly stuck vs actively computing
interface CpuSnapshot {
  totalCpuTime: number;   // sum of utime+stime across all descendants
  staleCount: number;     // consecutive scans with no CPU change
}
const childCpuSnapshots = new Map<string, CpuSnapshot>();
const CPU_STALE_THRESHOLD = 3; // 3 consecutive unchanged scans (= 15 min at 5-min interval) → stuck

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
  commandTemplate: string,
  systemPrompt?: string
): { runId: string; pid: number } {
  const db = getDatabase();
  const runId = uuidv4();

  // Write prompt to temp file (written later after fullPrompt is determined)
  let promptFile: string;

  // commandTemplate is the tool command name (e.g., "cld", "claude",
  // "codex", "gemini"). For Claude Code / Codex / Gemini we append
  // appropriate flags so they behave like non-interactive agents; for other
  // CLIs we run the template as-is.
  const toolPath = commandTemplate.trim() || 'claude';
  // Session strategy: time-based timeout → cache token (preferred) → run count (fallback)
  const resumeTimeout = (agent as any).session_resume_timeout ?? 300; // default 5 minutes
  const maxTokens = (agent as any).session_max_tokens || 400000;
  const maxRuns = (agent as any).session_max_runs || 10;
  const runCount = ((agent as any).session_run_count || 0) + 1;
  let shouldReset = false;

  // Time-based reset: if last session ended more than resumeTimeout seconds ago, start fresh
  if (resumeTimeout > 0 && agent.session_id && agent.finished_at) {
    const finishedTime = new Date(agent.finished_at + (agent.finished_at.includes('Z') ? '' : 'Z')).getTime();
    const elapsed = (Date.now() - finishedTime) / 1000;
    if (elapsed > resumeTimeout) {
      shouldReset = true;
      logger.info(`Agent ${agent.id} session idle for ${Math.round(elapsed)}s (timeout=${resumeTimeout}s), starting new session`);
    }
  }

  // If time check didn't trigger reset, fall back to token/run-count strategy
  if (!shouldReset) {
    if (maxTokens > 0 && agent.session_id) {
      // Query the latest cost record for this agent to get cache token usage
      const latestCost = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND stream = 'cost' ORDER BY id DESC LIMIT 1"
      ).get(agent.id) as { content: string } | undefined;
      let cacheTokens = 0;
      if (latestCost) {
        try {
          const data = JSON.parse(latestCost.content);
          cacheTokens = (data.cache_read || 0) + (data.cache_creation || 0);
        } catch {}
      }
      shouldReset = cacheTokens >= maxTokens;
      if (shouldReset) {
        logger.info(`Agent ${agent.id} cache tokens (${cacheTokens}) >= max (${maxTokens}), resetting session`);
      }
    } else {
      shouldReset = runCount > maxRuns;
    }
  }
  const existingSessionId = shouldReset ? null : agent.session_id;
  let sessionId = existingSessionId || uuidv4();

  // Update run count (reset to 1 if new session)
  db.prepare('UPDATE agents SET session_run_count = ? WHERE id = ?')
    .run(shouldReset ? 1 : runCount, agent.id);

  // Build command per tool. For Claude Code (cld/claude) we use stream-json
  // and pass session flags; for Codex and Gemini we use their non-interactive
  // JSON/stream-json modes; other commands are executed as-is.
  const lowerTool = toolPath.toLowerCase();
  let command: string;
  let useStreamJson = false;

  if (lowerTool.startsWith('cld') || lowerTool.startsWith('claude')) {
    const sessionFlag = existingSessionId ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
    command = `${toolPath} -p --output-format stream-json --verbose ${sessionFlag} --dangerously-skip-permissions --allowedTools "Bash Edit Read Write Glob Grep NotebookEdit WebFetch WebSearch Agent"`;
    useStreamJson = true;
  } else if (lowerTool === 'codex') {
    // Codex CLI: non-interactive exec mode with JSONL output.
    // Support resume like Claude: use existing session's thread_id to resume,
    // otherwise start a new session. The resume subcommand uses
    // --dangerously-bypass-approvals-and-sandbox instead of --sandbox.
    if (existingSessionId) {
      // Resume: prompt is read from stdin (using -)
      command = `codex exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${sessionId} -`;
    } else {
      command = 'codex exec --json --sandbox danger-full-access --skip-git-repo-check';
    }
    useStreamJson = true;
  } else if (lowerTool.startsWith('codex ')) {
    // Allow advanced users to fully customize Codex invocation via
    // command_template (e.g. "codex exec --json --sandbox workspace-write").
    // We respect their flags and only enable JSON parsing if --json is
    // explicitly requested.
    command = toolPath;
    useStreamJson = toolPath.includes('--json');
  } else if (lowerTool.startsWith('gemini')) {
    // Gemini CLI: use stream-json output and sandboxed auto-approval so
    // long-running agents can operate with minimal friction.
    command = `${toolPath} --output-format stream-json --sandbox --approval-mode yolo`;
    useStreamJson = true;
  } else {
    // Other CLIs: execute as provided. We still send the prompt via stdin but
    // do not assume any particular JSON schema.
    command = toolPath;
    useStreamJson = false;
  }

  // Resume session时跳过systemPrompt以节省token，只发送任务内容
  const fullPrompt = (existingSessionId || !systemPrompt) ? prompt : systemPrompt + prompt;

  // Write prompt file now that fullPrompt is determined
  promptFile = writePromptFile(runId, fullPrompt);

  if (existingSessionId && systemPrompt) {
    logger.info(`Agent ${agent.id} resuming session ${sessionId}, skipping system prompt (saved ~${systemPrompt.length} chars)`);
  }

  // Update agent status
  db.prepare(`
    UPDATE agents SET status = 'running', last_prompt = ?, session_id = ?, started_at = datetime('now'), pid = NULL
    WHERE id = ?
  `).run(fullPrompt, sessionId, agent.id);

  broadcastToProject(agent.project_id, {
    type: 'agent_status', projectId: agent.project_id,
    data: { agentId: agent.id, status: 'running' },
  });

  let cwd = agent.working_directory || process.cwd();
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2));

  const child = spawn('/bin/sh', ['-c', 'exec ' + command], {
    cwd,
    env: {
      ...process.env,
      no_proxy: [process.env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
      NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
      ARGUS_PROMPT: fullPrompt,
      ARGUS_PROMPT_FILE: promptFile,
      ARGUS_SESSION_ID: sessionId,
      ARGUS_AGENT_ID: agent.id,
      ARGUS_RUN_ID: runId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Feed prompt via stdin (so command template doesn't need to handle it)
  if (child.stdin) {
    child.stdin.write(fullPrompt);
    child.stdin.end();
  }

  const pid = child.pid || 0;
  runningProcesses.set(agent.id, child);
  lastActivityTime.set(agent.id, Date.now());

  db.prepare('UPDATE agents SET pid = ? WHERE id = ?').run(pid, agent.id);

  const logStmt = db.prepare(
    'INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, ?)'
  );

  // Log the input prompt
  logStmt.run(agent.id, runId, fullPrompt, 'stdin');

  // Use stream-json parser only for Claude Code / Codex; other tools are
  // logged as plain text so we don't depend on their JSON schema.
  const isStreamJson = useStreamJson;
  const isCodex = lowerTool === 'codex' || (lowerTool.startsWith('codex ') && useStreamJson);
  let stdoutBuffer = '';

  function logAndBroadcast(content: string, stream: string) {
    if (!content.trim()) return;
    lastActivityTime.set(agent.id, Date.now());
    logStmt.run(agent.id, runId, content, stream);
    broadcastToAgent(agent.id, { type: 'output', stream, content, runId });
  }

  function parseStreamJsonLine(line: string) {
    try {
      const obj = JSON.parse(line);
      let handled = false;

      // --- Codex-specific events ---
      if (isCodex) {
        if (obj.type === 'thread.started' && obj.thread_id) {
          // Capture Codex's thread_id as session_id for future resume
          handled = true;
          sessionId = obj.thread_id;
          db.prepare('UPDATE agents SET session_id = ? WHERE id = ?')
            .run(sessionId, agent.id);
          logger.info(`Agent ${agent.id} Codex thread started: ${sessionId}`);
        } else if (obj.type === 'item.completed' && obj.item) {
          handled = true;
          if (obj.item.type === 'agent_message' && obj.item.text) {
            logAndBroadcast(obj.item.text + '\n', 'stdout');
          } else if (obj.item.type === 'tool_call') {
            logAndBroadcast(`[Tool: ${obj.item.name || 'unknown'}] ${JSON.stringify(obj.item).slice(0, 200)}\n`, 'stdout');
          } else if (obj.item.type === 'tool_call_output') {
            const output = (obj.item.output || obj.item.text || '').slice(0, 500);
            logAndBroadcast(`[Result] ${output}\n`, 'stdout');
          }
        } else if (obj.type === 'turn.completed' && obj.usage) {
          handled = true;
          const input = obj.usage.input_tokens || 0;
          const output = obj.usage.output_tokens || 0;
          const cacheRead = obj.usage.cached_input_tokens || 0;
          // Codex doesn't report cache_creation separately; estimate as input - cached
          const cacheCreation = Math.max(0, input - cacheRead);
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          logAndBroadcast(`\n--- [${now}] Tokens: ${input} in, ${output} out, ${cacheRead} cache ---\n`, 'stdout');
          try {
            db.prepare("INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'cost')")
              .run(agent.id, runId, JSON.stringify({ cost_usd: 0, input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_creation: cacheCreation }));
          } catch {}
        } else if (obj.type === 'turn.started') {
          handled = true; // silently consume
        }
      }

      // --- Claude Code events ---
      if (!handled && obj.type === 'assistant' && obj.message?.content) {
        handled = true;
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            logAndBroadcast(block.text + '\n', 'stdout');
          } else if (block.type === 'tool_use') {
            logAndBroadcast(`[Tool: ${block.name}] ${JSON.stringify(block.input).slice(0, 200)}\n`, 'stdout');
          }
        }
      } else if (!handled && obj.type === 'user' && obj.tool_use_result !== undefined) {
        handled = true;
        const raw = obj.tool_use_result;
        const result = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
        logAndBroadcast(`[Result] ${result}\n`, 'stdout');
      } else if (!handled && obj.type === 'result') {
        handled = true;
        if (obj.result) {
          logAndBroadcast('\n--- Final Result ---\n' + obj.result + '\n', 'stdout');
        }
        // Track cost/usage — only if there's actual data
        if (obj.total_cost_usd > 0 || obj.usage?.input_tokens > 0 || obj.usage?.output_tokens > 0) {
          const costUsd = obj.total_cost_usd || 0;
          const input = obj.usage?.input_tokens || 0;
          const output = obj.usage?.output_tokens || 0;
          const cacheRead = obj.usage?.cache_read_input_tokens || 0;
          const cacheCreation = obj.usage?.cache_creation_input_tokens || 0;
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          logAndBroadcast(`\n--- [${now}] Cost: $${costUsd.toFixed(4)} | Tokens: ${input} in, ${output} out, ${cacheRead} cache ---\n`, 'stdout');
          try {
            db.prepare("INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'cost')")
              .run(agent.id, runId, JSON.stringify({ cost_usd: costUsd, input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_creation: cacheCreation, duration_ms: obj.duration_ms }));
          } catch {}
        }
      }

      // For unknown JSON shapes (e.g. other CLIs' stream-json), log the raw
      // line so that output is still visible even if we don't understand the
      // schema.
      if (!handled) {
        logAndBroadcast(line + '\n', 'stdout');
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
    lastActivityTime.delete(agent.id);
    childCpuSnapshots.delete(agent.id);
    cleanupPromptFile(promptFile);
    // If agent was explicitly stopped, preserve 'stopped' status
    const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agent.id) as { status: string } | undefined;
    const status = currentAgent?.status === 'stopped' ? 'stopped' : (code === 0 ? 'idle' : 'error');

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
    lastActivityTime.delete(agent.id);
    childCpuSnapshots.delete(agent.id);
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

/** Get all descendant PIDs of a process by traversing /proc */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    try {
      const entries = fs.readdirSync('/proc').filter(e => /^\d+$/.test(e));
      for (const entry of entries) {
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
          // Field 4 (1-indexed) is ppid. Format: pid (comm) state ppid ...
          const match = stat.match(/^\d+\s+\([^)]*\)\s+\S+\s+(\d+)/);
          if (match && parseInt(match[1]) === parentPid) {
            const childPid = parseInt(entry);
            descendants.push(childPid);
            queue.push(childPid);
          }
        } catch { /* process may have exited */ }
      }
    } catch { break; }
  }
  return descendants;
}

/** Read cumulative CPU time (utime + stime) for a single PID from /proc/<pid>/stat */
function getProcessCpuTime(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Fields are space-separated, but field 2 (comm) may contain spaces/parens.
    // Skip past the (comm) field first.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    // After stripping "pid (comm) ", field[0]=state, field[1]=ppid, ...
    // utime = field[11] (0-indexed from after comm), stime = field[12]
    const utime = parseInt(fields[11]) || 0;
    const stime = parseInt(fields[12]) || 0;
    return utime + stime;
  } catch {
    return 0;
  }
}

/**
 * Check child process CPU activity for watchdog.
 * Returns:
 *   'active'      — children exist and CPU time increased since last check
 *   'stale'       — children exist but CPU unchanged for >= CPU_STALE_THRESHOLD scans
 *   'warming'     — children exist, CPU unchanged but below threshold (give more time)
 *   'no_children' — no descendant processes found
 */
export function checkChildCpuActivity(agentId: string, pid: number): 'active' | 'stale' | 'warming' | 'no_children' {
  const descendants = getDescendantPids(pid);
  if (descendants.length === 0) return 'no_children';

  let totalCpu = 0;
  for (const dpid of descendants) {
    totalCpu += getProcessCpuTime(dpid);
  }

  const prev = childCpuSnapshots.get(agentId);
  if (!prev) {
    // First observation — record baseline
    childCpuSnapshots.set(agentId, { totalCpuTime: totalCpu, staleCount: 0 });
    return 'active';
  }

  if (totalCpu > prev.totalCpuTime) {
    // CPU time increased — actively computing
    childCpuSnapshots.set(agentId, { totalCpuTime: totalCpu, staleCount: 0 });
    return 'active';
  }

  // CPU unchanged — increment stale count
  const newStaleCount = prev.staleCount + 1;
  childCpuSnapshots.set(agentId, { totalCpuTime: totalCpu, staleCount: newStaleCount });

  if (newStaleCount >= CPU_STALE_THRESHOLD) {
    return 'stale';
  }
  return 'warming';
}

/** Clean up CPU snapshot when agent stops */
export function clearCpuSnapshot(agentId: string): void {
  childCpuSnapshots.delete(agentId);
}

export function stopAgentProcess(agentId: string): boolean {
  const child = runningProcesses.get(agentId);
  if (!child) return false;

  child.kill('SIGTERM');
  // Force kill after 5 seconds
  setTimeout(() => {
    if (runningProcesses.has(agentId)) {
      child.kill('SIGKILL');
      // Force cleanup after 3 more seconds — grandchild processes may hold
      // stdio pipes open, preventing the 'close' event from ever firing.
      setTimeout(() => {
        if (runningProcesses.has(agentId)) {
          logger.info(`Force cleanup: agent ${agentId} close event not fired after SIGKILL, cleaning up`);
          runningProcesses.delete(agentId);
          lastActivityTime.delete(agentId);
        }
      }, 3000);
    }
  }, 5000);

  return true;
}

export function isAgentRunning(agentId: string): boolean {
  return runningProcesses.has(agentId);
}

/** Returns how many ms since the agent last produced output, or -1 if not tracked. */
export function getAgentIdleMs(agentId: string): number {
  const t = lastActivityTime.get(agentId);
  return t ? Date.now() - t : -1;
}

/** Reset the last activity timestamp to now (used by watchdog when child processes are detected). */
export function resetAgentActivity(agentId: string): void {
  lastActivityTime.set(agentId, Date.now());
}

export { DEFAULT_IDLE_TIMEOUT_MS };

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
