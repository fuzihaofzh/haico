/**
 * BaseCliAdapter — shared base for all CLI-based agent adapters.
 *
 * Provides: spawn, process management, prompt file, env construction,
 * session management, exit classification, output buffering, watchdog state.
 *
 * Subclasses override:
 *   - buildCommand(input) → { command, useStreamJson }
 *   - parseOutputLine(line, state) → AdapterRuntimeEvent[]
 *   - readonly requiresCompletionSignal
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDatabase, isDatabaseOpen } from '../../db/database';
import { broadcastToAgent } from '../../realtime';
import { eventBus } from '../../events';
import logger from '../../logger';
import { Agent, Project } from '../../types';
import { expandHomePath } from '../file-management';
import { CLOSED_STDIN_SESSION_RE, PROMPT_ENV_MAX_CHARS } from '../process-manager/policy';
import { completeTaskRun, failTaskRunSpawn } from '../tasks/completion';
import { ExecutorSnapshot } from '../executors/types';
import { classifyAgentExitStatus } from '../process-manager/exit-status';
import { getRunTracker } from './run-tracker';

import type {
  Adapter,
  AdapterStartInput,
  AdapterRunHandle,
  AdapterEventSink,
  AdapterRuntimeEvent,
} from './types';
import { resolveBinaryPath } from '../tool-readiness';
import type { ToolReadinessSummary, ToolAuthReadiness, ToolReadinessIssue } from '../tool-readiness';

// ── Shared state (previously in process-manager/state.ts) ──
import { agentFinalResultTime } from '../process-manager/shared-state';

const runningProcesses = new Map<string, ChildProcess>();
const lastActivityTime = new Map<string, number>();
const childCpuSnapshots = new Map<string, { totalCpuTime: number; staleCount: number }>();
const agentLastErrorWasApiConnect = new Map<string, boolean>();

let shuttingDown = false;

export function isAdapterShuttingDown(): boolean {
  return shuttingDown;
}

export function setAdapterShuttingDown(value: boolean): void {
  shuttingDown = value;
}

/** Expose for watchdog CPU checks (macOS returns 'no_children' anyway) */
export function getAdapterCpuSnapshots() {
  return childCpuSnapshots;
}

export function getRunningProcesses() {
  return runningProcesses;
}

export function getLastActivityTime() {
  return lastActivityTime;
}

export function getAgentFinalResultTime() {
  return agentFinalResultTime;
}

/** Reset all adapter global state (tests only) */
export function resetAdapterGlobalState(): void {
  runningProcesses.clear();
  lastActivityTime.clear();
  childCpuSnapshots.clear();
  agentFinalResultTime.clear();
  agentLastErrorWasApiConnect.clear();
  shuttingDown = false;
}

// ── Prompt file management ──

const PROMPT_DIR = path.join(os.tmpdir(), 'haico-prompts');

function writePromptFile(runId: string, prompt: string): string {
  try {
    if (!fs.existsSync(PROMPT_DIR)) {
      fs.mkdirSync(PROMPT_DIR, { recursive: true });
    }
  } catch {}
  const fp = path.join(PROMPT_DIR, `prompt-${runId}.txt`);
  fs.writeFileSync(fp, prompt, 'utf-8');
  return fp;
}

function cleanupPromptFile(fp: string): void {
  try { fs.unlinkSync(fp); } catch {}
}

// ── Shell invocation ──

function buildShellInvocation(command: string): { shellPath: string; shellArgs: string[] } {
  const shellPath = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { shellPath, shellArgs: ['-lc', command] };
}

// ── CWD resolution ──

function resolveTaskCwd(agent: Agent, configuredCwd: string | null): string {
  let cwd = configuredCwd || agent.working_directory || process.cwd();
  if (cwd.startsWith('~/')) cwd = expandHomePath(cwd);
  try {
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  logger.warn({
    projectId: agent.project_id,
    agentId: agent.id,
    cwd,
    fallbackCwd: process.cwd(),
  }, 'task.executor.working_directory_fallback');
  return process.cwd();
}

export function resolveAgentCwd(agent: Agent): string {
  let cwd = agent.working_directory || process.cwd();
  if (cwd.startsWith('~/')) cwd = expandHomePath(cwd);
  try {
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return process.cwd();
}

// ── Environment construction ──

function buildPromptEnvValue(prompt: string): { value: string; truncated: boolean } {
  if (prompt.length <= PROMPT_ENV_MAX_CHARS) {
    return { value: prompt, truncated: false };
  }
  const notice = '\n...[truncated; read HAICO_PROMPT_FILE for full prompt]...\n';
  const remaining = Math.max(0, PROMPT_ENV_MAX_CHARS - notice.length);
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  return {
    value: prompt.slice(0, headLength) + notice + prompt.slice(Math.max(0, prompt.length - tailLength)),
    truncated: true,
  };
}

function buildChildEnv(input: {
  agent: Agent;
  runId: string;
  sessionId: string;
  fullPrompt: string;
  promptFile: string;
}): NodeJS.ProcessEnv {
  const promptEnv = buildPromptEnvValue(input.fullPrompt);
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HAICO_AGENT_ID: input.agent.id,
    HAICO_PROJECT_ID: input.agent.project_id,
    HAICO_RUN_ID: input.runId,
    HAICO_SESSION_ID: input.sessionId,
    HAICO_PROMPT: promptEnv.value,
    HAICO_PROMPT_FILE: input.promptFile,
    no_proxy: [process.env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
    NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
  };
  if (promptEnv.truncated) {
    childEnv.HAICO_PROMPT_TRUNCATED = '1';
  }
  const port = process.env.HAICO_PORT;
  if (port) {
    childEnv.HAICO_PORT = port;
    childEnv.HAICO_BASE_URL = `http://localhost:${port}`;
  }
  // nvm aborts shell init when npm_config_prefix is preset, preventing Node CLIs from restoring PATH.
  delete childEnv.npm_config_prefix;
  delete childEnv.NPM_CONFIG_PREFIX;
  return childEnv as NodeJS.ProcessEnv;
}

// ── Session management ──

function upsertExecutorSession(input: {
  agentId: string;
  executorProfileId: string | null;
  sessionId: string;
  runCount?: number;
  resetReason?: string;
}): void {
  if (!input.executorProfileId) return;
  const db = getDatabase();
  const existing = db.prepare(
    'SELECT id, run_count FROM executor_sessions WHERE agent_id = ? AND executor_profile_id = ?'
  ).get(input.agentId, input.executorProfileId) as { id: string; run_count: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE executor_sessions
      SET session_id = ?, run_count = COALESCE(?, run_count), reset_reason = ?, last_used_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(input.sessionId, input.runCount ?? null, input.resetReason || '', existing.id);
    return;
  }
  db.prepare(`
    INSERT INTO executor_sessions (id, agent_id, executor_profile_id, session_id, run_count, reset_reason)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
  `).run(input.agentId, input.executorProfileId, input.sessionId, input.runCount || 1, input.resetReason || '');
}

function getExistingExecutorSession(input: {
  agent: Agent;
  executorProfileId: string | null;
  resumeTimeoutSeconds: number;
}): { sessionId: string | null; runCount: number; resetReason: string } {
  if (!input.executorProfileId) return { sessionId: null, runCount: 1, resetReason: 'no_executor_profile' };
  const db = getDatabase();
  const existing = db.prepare(
    'SELECT session_id, run_count, last_used_at FROM executor_sessions WHERE agent_id = ? AND executor_profile_id = ?'
  ).get(input.agent.id, input.executorProfileId) as { session_id: string; run_count: number; last_used_at: string } | undefined;
  if (!existing) return { sessionId: null, runCount: 1, resetReason: 'new_session' };
  if (input.resumeTimeoutSeconds > 0 && existing.last_used_at) {
    const elapsed = Date.now() - new Date(existing.last_used_at + (existing.last_used_at.includes('Z') ? '' : 'Z')).getTime();
    if (elapsed > input.resumeTimeoutSeconds * 1000) {
      return { sessionId: null, runCount: 1, resetReason: 'idle_timeout' };
    }
  }
  return { sessionId: existing.session_id, runCount: (existing.run_count || 0) + 1, resetReason: '' };
}

// ── Output buffering (shared by all CLI adapters) ──

export interface CliOutputState {
  stdoutBuffer: string;
  sawStdout: boolean;
  stderrSample: string;
  sawClosedStdinSessionError: boolean;
  sawCompletionSignal: boolean;
}

// ── Abstract base ──

export abstract class BaseCliAdapter implements Adapter {
  abstract readonly type: string;
  abstract readonly requiresCompletionSignal: boolean;
  readonly chatTimeoutMs: number = 120000;

  /**
   * Build the CLI command for this adapter type.
   * Returns the full command string and whether to use stream-json parsing.
   */
  protected abstract buildCommand(input: {
    commandTemplate: string;
    sessionId: string;
    existingSessionId: string | null;
    commandProfileConfigJson: string;
  }): { command: string; useStreamJson: boolean };

  /**
   * Parse a single line of stream-json output.
   * Return an array of runtime events; the base class handles buffering.
   */
  protected abstract parseOutputLine(
    line: string,
    state: CliOutputState,
    input: {
      agent: Agent;
      runId: string;
      sink: AdapterEventSink;
    },
  ): void;

  // ── Adapter interface (default implementations for CLI adapters) ──

  start(input: AdapterStartInput, sink: AdapterEventSink): AdapterRunHandle {
    const db = getDatabase();
    const startedAtMs = Date.now();
    const commandTemplate = input.executor.command_template.trim();
    const sessionPolicy = input.executor.session_policy;
    const existingSession = sessionPolicy.new_session_per_run
      ? { sessionId: null, runCount: 1, resetReason: 'new_session_per_run' }
      : getExistingExecutorSession({
          agent: input.agent,
          executorProfileId: input.executorProfileId,
          resumeTimeoutSeconds: sessionPolicy.resume_timeout,
        });
    const sessionId = existingSession.sessionId || input.runId;

    upsertExecutorSession({
      agentId: input.agent.id,
      executorProfileId: input.executorProfileId,
      sessionId,
      runCount: existingSession.runCount,
      resetReason: existingSession.resetReason,
    });

    const { command, useStreamJson } = this.buildCommand({
      commandTemplate,
      sessionId,
      existingSessionId: existingSession.sessionId,
      commandProfileConfigJson: input.executor.command_profile_config_json,
    });

    const fullPrompt = (existingSession.sessionId || !input.systemPrompt)
      ? input.prompt
      : input.systemPrompt + input.prompt;
    const promptFile = writePromptFile(input.runId, fullPrompt);
    const cwd = resolveTaskCwd(input.agent, input.executor.working_directory);
    const { shellPath, shellArgs } = buildShellInvocation(command);
    const childEnv = {
      ...buildChildEnv({
        agent: input.agent,
        runId: input.runId,
        sessionId,
        fullPrompt,
        promptFile,
      }),
      ...input.executor.env,
    };

    const child = spawn(shellPath, shellArgs, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.stdin) {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    }

    const pid = child.pid || 0;
    runningProcesses.set(input.taskRunId, child);
    lastActivityTime.set(input.taskRunId, Date.now());

    // Register with run tracker
    getRunTracker().register(input.taskRunId, this);

    db.prepare(`
      UPDATE task_runs
      SET status = 'running', pid = ?, session_id = ?, command_snapshot = ?, prompt_snapshot = ?, started_at = datetime('now')
      WHERE id = ?
    `).run(pid, sessionId, command, fullPrompt, input.taskRunId);

    db.prepare('UPDATE tasks SET status = ?, started_at = COALESCE(started_at, datetime(\'now\')), updated_at = datetime(\'now\') WHERE id = ?')
      .run('running', input.taskId);

    eventBus.publish('agent.status_changed', {
      type: 'agent.status_changed',
      projectId: input.agent.project_id,
      payload: { agentId: input.agent.id, status: 'running', taskId: input.taskId, taskRunId: input.taskRunId },
      meta: { correlationId: input.taskRunId, timestamp: Date.now(), source: `adapters/${this.type}.start` },
    });

    logger.info({
      projectId: input.agent.project_id,
      agentId: input.agent.id,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      runId: input.runId,
      pid,
      commandType: this.type,
      cwd,
    }, 'task.run.started');

    // ── Output handling ──
    const outputState: CliOutputState = {
      stdoutBuffer: '',
      sawStdout: false,
      stderrSample: '',
      sawClosedStdinSessionError: false,
      sawCompletionSignal: false,
    };

    const logStmt = db.prepare(
      'INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, ?)'
    );
    logStmt.run(input.agent.id, input.runId, fullPrompt, 'stdin');

    const logAndBroadcast = (content: string, stream: 'stdout' | 'stderr') => {
      if (!content.trim()) return;
      if (shuttingDown || !isDatabaseOpen()) return;
      if (stream === 'stdout') {
        outputState.sawStdout = true;
      } else if (stream === 'stderr' && outputState.stderrSample.length < 2000) {
        outputState.stderrSample += content.slice(0, 2000 - outputState.stderrSample.length);
      }
      lastActivityTime.set(input.taskRunId, Date.now());
      try {
        logStmt.run(input.agent.id, input.runId, content, stream);
      } catch (e: any) {
        logger.warn({ err: e }, `logAndBroadcast: failed to write log for agent ${input.agent.id}`);
      }
      broadcastToAgent(input.agent.id, { type: 'output', stream, content, runId: input.runId });
    };

    const parseCtx = { agent: input.agent, runId: input.runId, sink };

    const handleData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
      const raw = data.toString();

      if (raw.includes('Unable to connect to API')) {
        agentLastErrorWasApiConnect.set(input.agent.id, true);
      }

      if (stream === 'stderr') {
        if (CLOSED_STDIN_SESSION_RE.test(raw)) {
          outputState.sawClosedStdinSessionError = true;
        }
        if (!raw.includes('proxychains')) {
          logAndBroadcast(raw, 'stderr');
        }
        return;
      }

      if (!useStreamJson) {
        logAndBroadcast(raw, 'stdout');
        return;
      }

      outputState.stdoutBuffer += raw;
      const lines = outputState.stdoutBuffer.split('\n');
      outputState.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          this.parseOutputLine(line.trim(), outputState, {
            ...parseCtx,
            // Pass logAndBroadcast and helpers through a context that parseOutputLine can use
            logAndBroadcast,
            logStmt,
            db,
            updateSessionId: (nextSessionId: string) => {
              upsertExecutorSession({
                agentId: input.agent.id,
                executorProfileId: input.executorProfileId,
                sessionId: nextSessionId,
                runCount: existingSession.runCount,
              });
            },
          } as any);
        }
      }
    };

    child.stdout?.on('data', handleData('stdout'));
    child.stderr?.on('data', handleData('stderr'));

    // ── Exit handling ──
    child.on('close', (code) => {
      runningProcesses.delete(input.taskRunId);
      lastActivityTime.delete(input.taskRunId);
      childCpuSnapshots.delete(input.taskRunId);
      getRunTracker().unregister(input.taskRunId);
      const hadFinalResult = agentFinalResultTime.has(input.agent.id);
      agentFinalResultTime.delete(input.agent.id);
      cleanupPromptFile(promptFile);

      if (!isDatabaseOpen() || shuttingDown) return;

      const currentTaskRun = db.prepare('SELECT status FROM task_runs WHERE id = ?').get(input.taskRunId) as
        | { status: string }
        | undefined;
      if (currentTaskRun?.status === 'cancelled') {
        logger.debug({
          projectId: input.agent.project_id,
          agentId: input.agent.id,
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          runId: input.runId,
        }, 'task.run.close_after_cancel_ignored');
        return;
      }

      const status = classifyAgentExitStatus({
        exitCode: code,
        requiresCompletionSignal: this.requiresCompletionSignal,
        sawClosedStdinSessionError: outputState.sawClosedStdinSessionError,
        sawCompletionSignal: outputState.sawCompletionSignal,
        hadFinalResult,
      });
      const taskRunStatus = status === 'idle' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed';
      if (taskRunStatus === 'failed' && code === 0 && this.requiresCompletionSignal && !hadFinalResult) {
        logAndBroadcast('HAICO: agent exited without emitting a completion event; marking this task run as failed\n', 'stderr');
      }

      completeTaskRun({
        taskRunId: input.taskRunId,
        exitCode: code,
        status: taskRunStatus,
        failureKind: taskRunStatus === 'failed' ? 'process_error' : null,
        failureMessage: taskRunStatus === 'failed' ? `process exited with code ${code ?? 'null'}` : null,
      });

      logger.info({
        projectId: input.agent.project_id,
        agentId: input.agent.id,
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        runId: input.runId,
        status: taskRunStatus,
        exitCode: code,
        durationMs: Date.now() - startedAtMs,
      }, 'task.run.completed');

      broadcastToAgent(input.agent.id, { type: 'exit', code, runId: input.runId });
      eventBus.publish('agent.status_changed', {
        type: 'agent.status_changed',
        projectId: input.agent.project_id,
        payload: { agentId: input.agent.id, status: taskRunStatus === 'completed' ? 'idle' : taskRunStatus },
        meta: { correlationId: input.taskRunId, timestamp: Date.now(), source: `adapters/${this.type}.childClose` },
      });
    });

    child.on('error', (err: any) => {
      runningProcesses.delete(input.taskRunId);
      lastActivityTime.delete(input.taskRunId);
      childCpuSnapshots.delete(input.taskRunId);
      getRunTracker().unregister(input.taskRunId);
      agentFinalResultTime.delete(input.agent.id);
      cleanupPromptFile(promptFile);
      if (!isDatabaseOpen() || shuttingDown) return;
      failTaskRunSpawn(input.taskRunId, err?.message || String(err));
      logStmt.run(input.agent.id, input.runId, `Process error: ${err.message}`, 'stderr');
      broadcastToAgent(input.agent.id, { type: 'error', message: err.message, runId: input.runId });
    });

    return { runId: input.runId, pid, sessionId, command };
  }

  stop(taskRunId: string): boolean {
    const child = runningProcesses.get(taskRunId);
    if (!child) return false;
    child.kill('SIGTERM');
    return true;
  }

  isRunning(taskRunId: string): boolean {
    return runningProcesses.has(taskRunId);
  }

  getIdleMs(taskRunId: string): number {
    const lastActivity = lastActivityTime.get(taskRunId);
    return lastActivity ? Date.now() - lastActivity : -1;
  }

  async stopAll(): Promise<void> {
    const taskRunIds = Array.from(runningProcesses.keys());
    for (const id of taskRunIds) {
      this.stop(id);
    }
  }

  // ── Default implementations for secondary consumers ──
  // Subclasses override as needed.

  buildSystemPromptSection(_agent: Agent, _project: Project): string {
    return '';
  }

  buildPtyArgs(commandTemplate: string, _sessionId?: string): {
    command: string;
    args: string[];
    useShell: boolean;
  } {
    const parts = commandTemplate.trim().split(/\s+/);
    return { command: parts[0] || commandTemplate, args: parts.slice(1), useShell: false };
  }

  buildMetadataCommand(commandTemplate: string): string {
    return commandTemplate;
  }

  buildChatCommand(commandTemplate: string): { command: string; binary: string } {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    return { command: commandTemplate, binary };
  }

  inspectReadiness(commandTemplate: string): ToolReadinessSummary {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    const resolved = resolveBinaryPath(binary);
    const binaryFound = !!resolved;
    const auth: ToolAuthReadiness = { status: 'unknown', confidence: 'unknown', message: '', action_command: null };
    return {
      command: commandTemplate,
      command_type: null,
      tool_label: this.type,
      binary,
      binary_found: binaryFound,
      binary_path: resolved,
      ready: binaryFound,
      issues: binaryFound ? [] : [{
        code: 'missing_cli',
        severity: 'blocking',
        title: `${this.type} CLI not found`,
        detail: `Could not find "${binary}" on this system.`,
        action_label: null,
        action_command: null,
      }],
      auth,
    };
  }

  /** Default: return template as-is. Claude adapter overrides to append --model. */
  buildControllerCommand(commandTemplate: string, _commandProfileConfigJson?: string | Record<string, unknown> | null): string {
    return commandTemplate;
  }

  /** Public wrapper around protected buildCommand — replaces buildAgentProcessCommand. */
  buildProcessCommand(input: {
    commandTemplate: string;
    sessionId: string;
    existingSessionId: string | null;
    commandProfileConfigJson: string;
  }): { command: string; useStreamJson: boolean } {
    return this.buildCommand(input);
  }
}