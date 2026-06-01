import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDatabase, isDatabaseOpen } from '../../db/database';
import { broadcastToAgent, broadcastToProject } from '../../realtime';
import logger from '../../logger';
import { Agent } from '../../types';
import { expandHomePath } from '../git';
import { resolveCommandType } from '../command-profiles';
import {
  buildAgentProcessCommand,
  buildChildEnv,
  buildShellInvocation,
  cleanupPromptFile,
  writePromptFile,
} from '../process-manager/command';
import { createAgentOutputHandlers } from '../process-manager/output';
import {
  agentFinalResultTime,
  childCpuSnapshots,
  isShuttingDown,
  lastActivityTime,
  runningProcesses,
} from '../process-manager/state';
import { classifyAgentExitStatus } from '../process-manager';
import { completeTaskRun, failTaskRunSpawn } from '../tasks/completion';
import { StartCliTaskRunInput, StartCliTaskRunResult } from './types';
import { detachChildProcessIo } from '../process-manager/command';

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

export function startCliTaskRun(input: StartCliTaskRunInput): StartCliTaskRunResult {
  const db = getDatabase();
  const startedAtMs = Date.now();
  const commandTemplate = input.executor.command_template.trim();
  const resolvedCommandType = resolveCommandType(input.executor.command_type, commandTemplate);
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

  const { command, useStreamJson } = buildAgentProcessCommand({
    toolPath: commandTemplate,
    resolvedCommandType,
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
  db.prepare(`
    UPDATE task_runs
    SET status = 'running', pid = ?, session_id = ?, command_snapshot = ?, prompt_snapshot = ?, started_at = datetime('now')
    WHERE id = ?
  `).run(pid, sessionId, command, fullPrompt, input.taskRunId);

  db.prepare('UPDATE tasks SET status = ?, started_at = COALESCE(started_at, datetime(\'now\')), updated_at = datetime(\'now\') WHERE id = ?')
    .run('running', input.taskId);

  broadcastToProject(input.agent.project_id, {
    type: 'agent_status',
    projectId: input.agent.project_id,
    data: { agentId: input.agent.id, status: 'running', taskId: input.taskId, taskRunId: input.taskRunId },
  });

  logger.info({
    projectId: input.agent.project_id,
    agentId: input.agent.id,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    runId: input.runId,
    pid,
    commandType: resolvedCommandType,
    cwd,
  }, 'task.run.started');

  const logStmt = db.prepare(
    'INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, ?)'
  );
  logStmt.run(input.agent.id, input.runId, fullPrompt, 'stdin');

  const output = createAgentOutputHandlers({
    db,
    logStmt,
    agent: input.agent,
    runId: input.runId,
    isStreamJson: useStreamJson,
    isCodex: resolvedCommandType === 'codex' && useStreamJson,
    resolvedCommandType,
    persistSessionToAgent: false,
    activityKey: input.taskRunId,
    updateSessionId: (nextSessionId) => {
      upsertExecutorSession({
        agentId: input.agent.id,
        executorProfileId: input.executorProfileId,
        sessionId: nextSessionId,
        runCount: existingSession.runCount,
      });
    },
  });

  child.stdout?.on('data', output.handleData('stdout'));
  child.stderr?.on('data', output.handleData('stderr'));

  const requiresCompletionSignal = useStreamJson && (
    resolvedCommandType === 'codex' ||
    resolvedCommandType === 'claude' ||
    resolvedCommandType === 'gemini'
  );

  child.on('close', (code) => {
    runningProcesses.delete(input.taskRunId);
    lastActivityTime.delete(input.taskRunId);
    childCpuSnapshots.delete(input.taskRunId);
    const hadFinalResult = agentFinalResultTime.has(input.agent.id);
    agentFinalResultTime.delete(input.agent.id);
    cleanupPromptFile(promptFile);

    if (!isDatabaseOpen() || isShuttingDown()) return;

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
      requiresCompletionSignal,
      sawClosedStdinSessionError: output.state.sawClosedStdinSessionError,
      sawCompletionSignal: output.state.sawCompletionSignal,
      hadFinalResult,
    });
    const taskRunStatus = status === 'idle' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed';
    if (taskRunStatus === 'failed' && code === 0 && requiresCompletionSignal && !hadFinalResult) {
      output.logAndBroadcast('HAICO: agent exited without emitting a completion event; marking this task run as failed\n', 'stderr');
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
    broadcastToProject(input.agent.project_id, {
      type: 'agent_status',
      projectId: input.agent.project_id,
      data: { agentId: input.agent.id, status: taskRunStatus === 'completed' ? 'idle' : taskRunStatus },
    });
  });

  child.on('error', (err: any) => {
    runningProcesses.delete(input.taskRunId);
    lastActivityTime.delete(input.taskRunId);
    childCpuSnapshots.delete(input.taskRunId);
    agentFinalResultTime.delete(input.agent.id);
    cleanupPromptFile(promptFile);
    if (!isDatabaseOpen() || isShuttingDown()) return;
    failTaskRunSpawn(input.taskRunId, err?.message || String(err));
    logStmt.run(input.agent.id, input.runId, `Process error: ${err.message}`, 'stderr');
    broadcastToAgent(input.agent.id, { type: 'error', message: err.message, runId: input.runId });
  });

  return { runId: input.runId, pid, sessionId, command };
}

export function stopCliTaskRun(taskRunId: string): boolean {
  const child = runningProcesses.get(taskRunId);
  if (!child) return false;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (runningProcesses.has(taskRunId)) {
      child.kill('SIGKILL');
      detachChildProcessIo(child);
      runningProcesses.delete(taskRunId);
      lastActivityTime.delete(taskRunId);
      childCpuSnapshots.delete(taskRunId);
    }
  }, 5000);
  timer.unref?.();
  return true;
}

export function isCliTaskRunRunning(taskRunId: string): boolean {
  return runningProcesses.has(taskRunId);
}

export function getCliTaskRunIdleMs(taskRunId: string): number {
  const lastActivity = lastActivityTime.get(taskRunId);
  return lastActivity ? Date.now() - lastActivity : -1;
}

export function stopAllCliTaskRuns(): Promise<void> {
  const taskRunIds = Array.from(runningProcesses.keys());
  if (taskRunIds.length === 0) return Promise.resolve();
  for (const taskRunId of taskRunIds) {
    stopCliTaskRun(taskRunId);
  }
  return Promise.resolve();
}
