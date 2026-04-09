import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDatabase, isDatabaseOpen } from '../db/database';
import { Agent, Project } from '../types';
import { broadcastToAgent, broadcastToProject } from './websocket';
import { resolveCommandType } from './command-profiles';
import logger from '../logger';

const runningProcesses = new Map<string, ChildProcess>();
const PROMPT_DIR = path.join(os.tmpdir(), 'agentopia-prompts');

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

// Codex-mini pricing (USD per token) — used to estimate cost when Codex CLI
// doesn't report cost_usd in turn.completed events.
const CODEX_INPUT_PRICE  = 1.50 / 1_000_000;
const CODEX_OUTPUT_PRICE = 6.00 / 1_000_000;
const CODEX_CACHED_PRICE = 0.375 / 1_000_000;

// Track API connection errors for auto-retry
const agentApiConnectErrorCount = new Map<string, number>();
const agentLastErrorWasApiConnect = new Map<string, boolean>();
const pendingRetryTimers = new Map<string, NodeJS.Timeout>();

// Track orphaned timers from stopAgentProcess so they can be cancelled during shutdown
const pendingStopTimers = new Set<NodeJS.Timeout>();

// Shutdown flag — when true, all async callbacks skip DB access and timer creation
let shuttingDown = false;

// Track when agent received its final result — used by watchdog to kill stuck post-completion processes
const agentFinalResultTime = new Map<string, number>();
const FINAL_RESULT_KILL_DELAY_MS = 2 * 60 * 1000; // 2 minutes after Final Result → force kill

const RESTART_COOLDOWN_MS = 0; // no cooldown — restart immediately when issues are assigned
const INTRA_LOW_OUTPUT_KILL_THRESHOLD = 2; // 2 consecutive low-output assistant turns → terminate
const INTRA_LOW_OUTPUT_CHAR_LIMIT = 200;   // assistant text below this = "low output"
const TOOL_INPUT_LOG_CHAR_LIMIT = 4000;    // large enough for expandable UI without storing unbounded payloads
const RESUME_MISSING_FILE_RE = /no such file or directory/i;
const CLOSED_STDIN_SESSION_RE = /stdin is closed for this session|write_stdin failed/i;
const PROMPT_ENV_MAX_CHARS = 16000;

function resolveProcessCommandConfig(
  db: ReturnType<typeof getDatabase>,
  agent: Agent,
  commandTemplate: string
): { commandTemplate: string; commandType: ReturnType<typeof resolveCommandType> } {
  const normalizedCommandTemplate = commandTemplate.trim() || 'claude';
  let inheritedProjectCommandType: Project['command_type'] | null = null;

  if (!agent.command_type && agent.project_id) {
    const project = db.prepare('SELECT command_template, command_type FROM projects WHERE id = ?').get(agent.project_id) as
      | Pick<Project, 'command_template' | 'command_type'>
      | undefined;
    const projectCommandTemplate = String(project?.command_template || '').trim();
    const agentUsesProjectDefault = !String(agent.command_template || '').trim()
      || (!!projectCommandTemplate && projectCommandTemplate === normalizedCommandTemplate);

    if (agentUsesProjectDefault) {
      inheritedProjectCommandType = project?.command_type || null;
    }
  }

  return {
    commandTemplate: normalizedCommandTemplate,
    commandType: resolveCommandType(agent.command_type || inheritedProjectCommandType, normalizedCommandTemplate),
  };
}

function writePromptFile(runId: string, prompt: string): string {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const fp = path.join(PROMPT_DIR, runId + '.txt');
  fs.writeFileSync(fp, prompt, 'utf-8');
  return fp;
}

function cleanupPromptFile(fp: string): void {
  try {
    if (!fp || !fs.existsSync(fp)) return;
    fs.unlinkSync(fp);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      logger.error(e, 'Failed to cleanup prompt file %s', fp);
    }
  }
}

function buildPromptEnvValue(prompt: string): { value: string; truncated: boolean } {
  if (prompt.length <= PROMPT_ENV_MAX_CHARS) {
    return { value: prompt, truncated: false };
  }

  const notice = '\n...[truncated; read AGENTOPIA_PROMPT_FILE for full prompt]...\n';
  const remaining = Math.max(0, PROMPT_ENV_MAX_CHARS - notice.length);
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);

  return {
    value: prompt.slice(0, headLength) + notice + prompt.slice(Math.max(0, prompt.length - tailLength)),
    truncated: true,
  };
}

function detachChildProcessIo(child: ChildProcess | undefined): void {
  if (!child) return;

  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue;
    try {
      if (typeof (stream as any).unref === 'function') {
        (stream as any).unref();
      }
    } catch {}
    try {
      if (!(stream as any).destroyed && typeof stream.destroy === 'function') {
        stream.destroy();
      }
    } catch {}
  }

  try {
    child.unref();
  } catch {}
}

export type OnAgentFinishCallback = (agent: Agent, exitCode: number | null) => void;
let onAgentFinish: OnAgentFinishCallback | null = null;

export function setOnAgentFinish(cb: OnAgentFinishCallback | null): void {
  onAgentFinish = cb;
}

export function classifyAgentExitStatus(input: {
  currentStatus?: string | null;
  exitCode: number | null;
  requiresCompletionSignal: boolean;
  sawClosedStdinSessionError: boolean;
  sawCompletionSignal: boolean;
  hadFinalResult: boolean;
}): 'idle' | 'error' | 'stopped' {
  if (input.currentStatus === 'stopped') return 'stopped';
  if (input.hadFinalResult) return 'idle';
  if (input.exitCode !== 0 || input.sawClosedStdinSessionError) return 'error';
  if (!input.requiresCompletionSignal) return 'idle';
  return input.sawCompletionSignal ? 'idle' : 'error';
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
  const commandConfig = resolveProcessCommandConfig(db, agent, commandTemplate);
  const toolPath = commandConfig.commandTemplate;
  const resolvedCommandType = commandConfig.commandType;
  // Session strategy: time-based timeout → cache token (preferred) → run count (fallback)
  const resumeTimeout = (agent as any).session_resume_timeout ?? 300; // default 5 minutes
  const maxTokens = (agent as any).session_max_tokens || 400000;
  const maxRuns = (agent as any).session_max_runs || 10;
  const runCount = ((agent as any).session_run_count || 0) + 1;
  const newSessionPerRun = !!(agent as any).new_session_per_run;
  let shouldReset = false;

  // Forced new session per run
  if (newSessionPerRun) {
    shouldReset = true;
    logger.info(`Agent ${agent.id} new_session_per_run=true, starting new session`);
  }

  // Time-based reset: if last session ended more than resumeTimeout seconds ago, start fresh
  if (resumeTimeout > 0 && agent.session_id && agent.finished_at) {
    const finishedTime = new Date(agent.finished_at + (agent.finished_at.includes('Z') ? '' : 'Z')).getTime();
    const elapsed = (Date.now() - finishedTime) / 1000;
    if (elapsed > resumeTimeout) {
      shouldReset = true;
      logger.info(`Agent ${agent.id} session idle for ${Math.round(elapsed)}s (timeout=${resumeTimeout}s), starting new session`);
    }
  }

  // If time check didn't trigger reset, check token usage and run count independently
  if (!shouldReset && agent.session_id) {
    // Check cache token usage
    if (maxTokens > 0) {
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
      if (cacheTokens >= maxTokens) {
        shouldReset = true;
        logger.info(`Agent ${agent.id} cache tokens (${cacheTokens}) >= max (${maxTokens}), resetting session`);
      }
    }
    // Check run count (independent of token check)
    if (!shouldReset && runCount > maxRuns) {
      shouldReset = true;
      logger.info(`Agent ${agent.id} run count (${runCount}) > max (${maxRuns}), resetting session`);
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

  if (resolvedCommandType === 'claude') {
    const sessionFlag = existingSessionId ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
    command = `${toolPath} -p --output-format stream-json --verbose ${sessionFlag} --dangerously-skip-permissions --allowedTools "Bash Edit Read Write Glob Grep NotebookEdit WebFetch WebSearch Agent"`;
    useStreamJson = true;
  } else if (resolvedCommandType === 'codex') {
    const hasExplicitExec = /\bexec\b/.test(lowerTool);
    if (hasExplicitExec) {
      // Fully customized Codex command; respect the template as-is.
      command = toolPath;
      useStreamJson = toolPath.includes('--json');
    } else if (existingSessionId) {
      command = `${toolPath} exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${sessionId} -`;
      useStreamJson = true;
    } else {
      command = `${toolPath} exec --json --sandbox danger-full-access --skip-git-repo-check`;
      useStreamJson = true;
    }
  } else if (resolvedCommandType === 'gemini') {
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
    UPDATE agents SET status = 'running', last_prompt = ?, session_id = ?, started_at = datetime('now'), finished_at = NULL, pid = NULL
    WHERE id = ?
  `).run(fullPrompt, sessionId, agent.id);

  broadcastToProject(agent.project_id, {
    type: 'agent_status', projectId: agent.project_id,
    data: { agentId: agent.id, status: 'running' },
  });

  let cwd = agent.working_directory || process.cwd();
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2));
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      logger.warn(`Agent ${agent.id} working directory "${cwd}" is missing, falling back to process cwd "${process.cwd()}"`);
      cwd = process.cwd();
    }
  } catch {
    logger.warn(`Agent ${agent.id} working directory "${cwd}" is invalid, falling back to process cwd "${process.cwd()}"`);
    cwd = process.cwd();
  }

  // Use a login bash shell when available so agent wrappers like `cld`/`spc`
  // resolve consistently even when Agentopia itself was started with a minimal PATH.
  const shellPath = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const shellArgs = shellPath.endsWith('bash') ? ['-lc', 'exec ' + command] : ['-c', 'exec ' + command];
  const promptEnv = buildPromptEnvValue(fullPrompt);
  const childEnv = {
    ...process.env,
    no_proxy: [process.env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
    NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
    AGENTOPIA_PROMPT: promptEnv.value,
    AGENTOPIA_PROMPT_FILE: promptFile,
    AGENTOPIA_PROMPT_TRUNCATED: promptEnv.truncated ? '1' : '0',
    AGENTOPIA_SESSION_ID: sessionId,
    AGENTOPIA_AGENT_ID: agent.id,
    AGENTOPIA_RUN_ID: runId,
  } as NodeJS.ProcessEnv;

  if (promptEnv.truncated) {
    logger.warn(
      `Agent ${agent.id} prompt exceeded ${PROMPT_ENV_MAX_CHARS} chars; AGENTOPIA_PROMPT was truncated and full prompt is available via AGENTOPIA_PROMPT_FILE`
    );
  }

  // nvm aborts shell init when npm_config_prefix is preset, which prevents
  // login shells from restoring Node-based CLIs like `codex` into PATH.
  delete childEnv.npm_config_prefix;
  delete childEnv.NPM_CONFIG_PREFIX;

  const child = spawn(shellPath, shellArgs, {
    cwd,
    env: childEnv,
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
  const isCodex = resolvedCommandType === 'codex' && isStreamJson;
  const requiresCompletionSignal = isStreamJson && (
    isCodex ||
    resolvedCommandType === 'claude' ||
    resolvedCommandType === 'gemini'
  );
  let stdoutBuffer = '';
  let sawStdout = false;
  let stderrSample = '';
  let sawClosedStdinSessionError = false;
  let sawCompletionSignal = false;

  function logAndBroadcast(content: string, stream: string) {
    if (!content.trim()) return;
    if (shuttingDown || !isDatabaseOpen()) return;
    if (stream === 'stdout') {
      sawStdout = true;
    } else if (stream === 'stderr' && stderrSample.length < 2000) {
      stderrSample += content.slice(0, 2000 - stderrSample.length);
    }
    lastActivityTime.set(agent.id, Date.now());
    try {
      logStmt.run(agent.id, runId, content, stream);
    } catch (e: any) {
      logger.warn({ err: e }, `logAndBroadcast: failed to write log for agent ${agent.id}`);
      return;
    }
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
          if (isDatabaseOpen()) {
            db.prepare('UPDATE agents SET session_id = ? WHERE id = ?')
              .run(sessionId, agent.id);
          }
          logger.info(`Agent ${agent.id} Codex thread started: ${sessionId}`);
        } else if (obj.type === 'item.completed' && obj.item) {
          handled = true;
          if (obj.item.type === 'agent_message' && obj.item.text) {
            logAndBroadcast(obj.item.text + '\n', 'stdout');
          } else if (obj.item.type === 'tool_call') {
            logAndBroadcast(`[Tool: ${obj.item.name || 'unknown'}] ${JSON.stringify(obj.item).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT)}\n`, 'stdout');
          } else if (obj.item.type === 'tool_call_output') {
            const output = (obj.item.output || obj.item.text || '').slice(0, 500);
            logAndBroadcast(`[Result] ${output}\n`, 'stdout');
          }
        } else if (obj.type === 'turn.completed' && obj.usage) {
          handled = true;
          sawCompletionSignal = true;
          const input = obj.usage.input_tokens || 0;
          const output = obj.usage.output_tokens || 0;
          const cacheRead = obj.usage.cached_input_tokens || 0;
          // Codex doesn't report cache_creation separately; estimate as input - cached
          const cacheCreation = Math.max(0, input - cacheRead);
          // Try to extract real cost from Codex event; fall back to estimate from token counts
          const reportedCost = obj.cost_usd || obj.total_cost_usd || obj.usage?.cost_usd || obj.usage?.cost || 0;
          const costUsd = reportedCost > 0 ? reportedCost
            : (cacheRead * CODEX_CACHED_PRICE + cacheCreation * CODEX_INPUT_PRICE + output * CODEX_OUTPUT_PRICE);
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const costLabel = costUsd > 0 ? ` | Cost: $${costUsd.toFixed(4)}` : '';
          logAndBroadcast(`\n--- [${now}] Tokens: ${input} in, ${output} out, ${cacheRead} cache${costLabel} ---\n`, 'stdout');
          try {
            db.prepare("INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'cost')")
              .run(agent.id, runId, JSON.stringify({ cost_usd: costUsd, input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_creation: cacheCreation }));
          } catch {}
        } else if (obj.type === 'turn.started') {
          handled = true; // silently consume
        }
      }

      // --- Claude Code events ---
      if (!handled && obj.type === 'assistant' && obj.message?.content) {
        handled = true;
        let totalTextLen = 0;
        let hasToolUse = false;
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            totalTextLen += block.text.length;
            logAndBroadcast(block.text + '\n', 'stdout');
          } else if (block.type === 'tool_use') {
            hasToolUse = true;
            logAndBroadcast(`[Tool: ${block.name}] ${JSON.stringify(block.input).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT)}\n`, 'stdout');
          }
        }

        // No intra-session output policing — as long as an agent has assigned
        // issues, it should be allowed to run regardless of output length.
      } else if (!handled && obj.type === 'user' && obj.tool_use_result !== undefined) {
        handled = true;
        const raw = obj.tool_use_result;
        const result = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
        logAndBroadcast(`[Result] ${result}\n`, 'stdout');
      } else if (!handled && obj.type === 'result') {
        handled = true;
        sawCompletionSignal = true;
        // Mark that this agent has produced its final result — watchdog will force-kill
        // if the process doesn't exit within FINAL_RESULT_KILL_DELAY_MS (child curl stuck etc.)
        agentFinalResultTime.set(agent.id, Date.now());
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

    // Detect API connection failure in any output stream
    if (raw.includes('Unable to connect to API')) {
      agentLastErrorWasApiConnect.set(agent.id, true);
    }

    if (stream === 'stderr') {
      if (CLOSED_STDIN_SESSION_RE.test(raw)) {
        sawClosedStdinSessionError = true;
      }
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
    const hadFinalResult = agentFinalResultTime.has(agent.id);
    agentFinalResultTime.delete(agent.id);
    cleanupPromptFile(promptFile);

    // Skip DB writes if database is already closed (during shutdown)
    if (!isDatabaseOpen()) {
      logger.info(`Agent ${agent.id} close event after DB closed, skipping DB writes`);
      return;
    }

    // During shutdown, skip all DB writes and timer creation (retry, callback, etc.)
    if (shuttingDown) {
      logger.info(`Agent ${agent.id} close event during shutdown, skipping DB writes`);
      return;
    }

    // Check if this run had an API connection error
    const wasApiConnectError = agentLastErrorWasApiConnect.get(agent.id) || false;
    agentLastErrorWasApiConnect.delete(agent.id);

    const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agent.id) as { status: string } | undefined;
    // If already set to idle (e.g. by tail-kill), keep it
    if (currentAgent?.status === 'idle') {
      // skip classifyAgentExitStatus — already handled
    }
    const status = currentAgent?.status === 'idle' ? 'idle' : classifyAgentExitStatus({
      exitCode: code,
      requiresCompletionSignal,
      sawClosedStdinSessionError,
      sawCompletionSignal,
      hadFinalResult,
    });

    if (code === 0 && sawClosedStdinSessionError && !hadFinalResult) {
      logger.info(`Agent ${agent.id} exited with code 0 but had closed-stdin tool session errors; marking run as error`);
    }
    if (code === 0 && requiresCompletionSignal && !sawClosedStdinSessionError && !sawCompletionSignal && !hadFinalResult) {
      logger.info(`Agent ${agent.id} exited with code 0 but without a completion signal; marking run as error`);
      logAndBroadcast('Agentopia: agent exited without emitting a completion event; marking this run as error\n', 'stderr');
    }

    if (status === 'error' && existingSessionId && !sawStdout && RESUME_MISSING_FILE_RE.test(stderrSample)) {
      logger.info(`Agent ${agent.id} resume failed with missing file, retrying with a fresh session`);
      logAndBroadcast('Agentopia: 旧 session 恢复失败，自动改为新 session 重试...\n', 'stderr');
      db.prepare("UPDATE agents SET session_id = NULL, status = 'idle', pid = NULL WHERE id = ?").run(agent.id);
      const freshAgent = { ...agent, session_id: null };
      startAgentProcess(freshAgent, prompt, commandTemplate, systemPrompt);
      return;
    }

    if (status === 'error') {
      // Handle API connection error with auto-retry
      if (wasApiConnectError) {
        const apiErrCount = (agentApiConnectErrorCount.get(agent.id) || 0) + 1;
        agentApiConnectErrorCount.set(agent.id, apiErrCount);

        if (apiErrCount <= 1) {
          // First API connection failure: auto-retry after 5 minutes to avoid wasting tokens
          const retryDelayMs = 5 * 60 * 1000; // 5 minutes
          logger.info(`Agent ${agent.id} API connection failed (attempt ${apiErrCount}), auto-retrying in 5 minutes`);
          logAndBroadcast('Agentopia: API连接失败，5分钟后自动重试...\n', 'stderr');
          // Set status to 'waiting' during retry delay — visible in UI, prevents scheduler re-trigger
          db.prepare(`
            UPDATE agents SET status = 'waiting', pid = NULL, finished_at = datetime('now') WHERE id = ?
          `).run(agent.id);
          broadcastToProject(agent.project_id, {
            type: 'agent_status', projectId: agent.project_id,
            data: { agentId: agent.id, status: 'waiting' },
          });
          const retryTimer = setTimeout(() => {
            pendingRetryTimers.delete(agent.id);
            if (shuttingDown || !isDatabaseOpen()) return;
            const retryAgent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as Agent | undefined;
            if (retryAgent && (retryAgent.status === 'waiting' || retryAgent.status === 'running')) {
              logger.info(`Agent ${agent.id} auto-retrying after 5-minute API wait`);
              startAgentProcess(retryAgent, prompt, commandTemplate, systemPrompt);
            }
          }, retryDelayMs);
          pendingRetryTimers.set(agent.id, retryTimer);
          return;
        } else {
          // Second+ API connection failure: give up, report error
          logger.info(`Agent ${agent.id} API connection failed ${apiErrCount} times, giving up`);
          logAndBroadcast('Agentopia: API连接持续失败，请检查网络/API配置后手动重启agent\n', 'stderr');
          agentApiConnectErrorCount.delete(agent.id);
          // Fall through to normal error handling below
        }
      } else {
        // Non-API error: reset API error count
        agentApiConnectErrorCount.delete(agent.id);
      }

      // Clear session on error — avoid resuming a broken session repeatedly
      logger.info(`Agent ${agent.id} error, clearing session for fresh start on next run`);
      db.prepare(`
        UPDATE agents SET status = ?, pid = NULL, finished_at = datetime('now'), session_id = NULL WHERE id = ?
      `).run(status, agent.id);
      {
      }
    } else {
      // Success — reset error counts and record finish time for cooldown
      agentErrorCount.delete(agent.id);
      agentApiConnectErrorCount.delete(agent.id);

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
    logger.error(`Spawn error: ${err.message} code=${err.code} path=${err.path} syscall=${err.syscall} cwd=${cwd} shell=${shellPath}`);
    runningProcesses.delete(agent.id);
    lastActivityTime.delete(agent.id);
    childCpuSnapshots.delete(agent.id);
    agentFinalResultTime.delete(agent.id);
    cleanupPromptFile(promptFile);

    if (shuttingDown || !isDatabaseOpen()) {
      logger.info(`Agent ${agent.id} error event during shutdown/after DB closed, skipping DB writes`);
      return;
    }

    // If resume failed, retry with a fresh session
    if (existingSessionId && err.code === 'ENOENT') {
      logger.info(`Retrying agent ${agent.id} with fresh session (resume failed)`);
      const freshAgent = { ...agent, session_id: null };
      db.prepare("UPDATE agents SET session_id = NULL, status = 'idle' WHERE id = ?").run(agent.id);
      startAgentProcess(freshAgent, prompt, commandTemplate, systemPrompt);
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
  // Cancel any pending API retry timer for this agent
  const retryTimer = pendingRetryTimers.get(agentId);
  if (retryTimer) {
    clearTimeout(retryTimer);
    pendingRetryTimers.delete(agentId);
  }

  const child = runningProcesses.get(agentId);
  if (!child) return false;

  logger.info(`stopAgentProcess: sending SIGTERM to agent ${agentId} (pid=${child.pid})`);
  child.kill('SIGTERM');
  // Force kill after 5 seconds
  const killTimer = setTimeout(() => {
    pendingStopTimers.delete(killTimer);
    if (runningProcesses.has(agentId)) {
      logger.info(`stopAgentProcess: sending SIGKILL to agent ${agentId} (pid=${child.pid})`);
      child.kill('SIGKILL');
      detachChildProcessIo(child);
      // Force cleanup after 3 more seconds — grandchild processes may hold
      // stdio pipes open, preventing the 'close' event from ever firing.
      const cleanupTimer = setTimeout(() => {
        pendingStopTimers.delete(cleanupTimer);
        if (runningProcesses.has(agentId)) {
          logger.info(`Force cleanup: agent ${agentId} close event not fired after SIGKILL, cleaning up`);
          detachChildProcessIo(child);
          runningProcesses.delete(agentId);
          lastActivityTime.delete(agentId);
        }
      }, 3000);
      pendingStopTimers.add(cleanupTimer);
    }
  }, 5000);
  pendingStopTimers.add(killTimer);

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

export { DEFAULT_IDLE_TIMEOUT_MS, FINAL_RESULT_KILL_DELAY_MS, RESTART_COOLDOWN_MS };

/** Returns true if the agent recently finished and should not be auto-restarted yet.
 *  Uses extended cooldown (10 min) if the last run had very low output tokens,
 *  Currently disabled — agents restart immediately when they have assigned issues. */
export function isAgentInCooldown(_agentId: string): boolean {
  return false;
}

/**
 * Returns how many ms since the agent received its final result, or -1 if no final result yet.
 * Used by watchdog to force-kill agents whose child processes are stuck after completion.
 */
export function getAgentFinalResultAge(agentId: string): number {
  const t = agentFinalResultTime.get(agentId);
  return t ? Date.now() - t : -1;
}

export function getRunningAgentIds(): string[] {
  return Array.from(runningProcesses.keys());
}

export function stopAllProcesses(): Promise<void> {
  shuttingDown = true;

  // Cancel any pending API retry timers to prevent DB access after shutdown
  for (const timer of pendingRetryTimers.values()) {
    clearTimeout(timer);
  }
  pendingRetryTimers.clear();

  // Cancel any orphaned timers from previous stopAgentProcess calls
  for (const timer of pendingStopTimers) clearTimeout(timer);
  pendingStopTimers.clear();

  const agentIds = Array.from(runningProcesses.keys());
  if (agentIds.length === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let forceKillTimer: NodeJS.Timeout | null = null;
    let forceCleanupTimer: NodeJS.Timeout | null = null;

    function checkAllDone() {
      // Check if all processes we were stopping have exited
      const allDone = agentIds.every(id => !runningProcesses.has(id));
      if (allDone) {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (forceCleanupTimer) clearTimeout(forceCleanupTimer);
        // Clear any retry timers that close handlers may have created
        for (const timer of pendingRetryTimers.values()) clearTimeout(timer);
        pendingRetryTimers.clear();
        resolve();
      }
    }

    // Watch for processes exiting
    for (const agentId of agentIds) {
      const child = runningProcesses.get(agentId);
      if (!child) continue;
      logger.info(`Killing agent ${agentId} (pid: ${child.pid})`);
      child.kill('SIGTERM');
      child.once('close', () => checkAllDone());
    }

    // Force kill after 3 seconds if still running — also kill descendants
    // to ensure stdio pipes are closed and 'close' event fires promptly
    forceKillTimer = setTimeout(() => {
      for (const agentId of agentIds) {
        const child = runningProcesses.get(agentId);
        if (child && child.pid) {
          const descendants = getDescendantPids(child.pid);
          logger.info(`Force killing agent ${agentId} (pid=${child.pid}) and ${descendants.length} descendants: [${descendants.join(',')}]`);
          for (const dpid of descendants) {
            if (dpid === process.pid || dpid === process.ppid) {
              logger.error(`stopAllProcesses: refusing to kill PID ${dpid} — it is the Agentopia server (pid=${process.pid}, ppid=${process.ppid})`);
              continue;
            }
            try { process.kill(dpid, 'SIGKILL'); } catch {}
          }
          child.kill('SIGKILL');
          detachChildProcessIo(child);
        }
      }
    }, 3000);

    // Final cleanup after 6 seconds — resolve even if close events never fired
    forceCleanupTimer = setTimeout(() => {
      for (const agentId of agentIds) {
        if (runningProcesses.has(agentId)) {
          detachChildProcessIo(runningProcesses.get(agentId));
          logger.info(`Force cleanup: agent ${agentId} close event not fired during stopAll, cleaning up`);
          runningProcesses.delete(agentId);
          lastActivityTime.delete(agentId);
          childCpuSnapshots.delete(agentId);
          agentFinalResultTime.delete(agentId);
        }
      }
      // Clear any retry timers that close handlers may have created
      for (const timer of pendingRetryTimers.values()) clearTimeout(timer);
      pendingRetryTimers.clear();
      resolve();
    }, 6000);
  });
}
