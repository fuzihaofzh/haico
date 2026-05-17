import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, isDatabaseOpen } from '../../db/database';
import { Agent } from '../../types';
import { broadcastToAgent, broadcastToProject } from '../../realtime';
import logger from '../../logger';
import {
  buildAgentProcessCommand,
  buildChildEnv,
  buildShellInvocation,
  cleanupPromptFile,
  resolveAgentCwd,
  resolveProcessCommandConfig,
  writePromptFile,
} from './command';
import { createAgentOutputHandlers } from './output';
import { RESUME_MISSING_FILE_RE } from './policy';
import {
  agentApiConnectErrorCount,
  agentFinalResultTime,
  agentLastErrorWasApiConnect,
  childCpuSnapshots,
  isShuttingDown,
  lastActivityTime,
  pendingRetryTimers,
  runningProcesses,
} from './state';
import { AgentExitStatus, OnAgentFinishCallback } from './types';

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
}): AgentExitStatus {
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
  const startedAtMs = Date.now();

  const commandConfig = resolveProcessCommandConfig(db, agent, commandTemplate);
  const toolPath = commandConfig.commandTemplate;
  const resolvedCommandType = commandConfig.commandType;
  const resumeTimeout = (agent as any).session_resume_timeout ?? 300;
  const maxTokens = (agent as any).session_max_tokens || 400000;
  const maxRuns = (agent as any).session_max_runs || 10;
  const runCount = ((agent as any).session_run_count || 0) + 1;
  const newSessionPerRun = !!(agent as any).new_session_per_run;
  let shouldReset = false;

  if (newSessionPerRun) {
    shouldReset = true;
    logger.debug({ agentId: agent.id, reason: 'new_session_per_run' }, 'agent.session.reset');
  }

  if (resumeTimeout > 0 && agent.session_id && agent.finished_at) {
    const finishedTime = new Date(agent.finished_at + (agent.finished_at.includes('Z') ? '' : 'Z')).getTime();
    const elapsed = (Date.now() - finishedTime) / 1000;
    if (elapsed > resumeTimeout) {
      shouldReset = true;
      logger.debug({
        agentId: agent.id,
        elapsedSeconds: Math.round(elapsed),
        resumeTimeoutSeconds: resumeTimeout,
        reason: 'idle_timeout',
      }, 'agent.session.reset');
    }
  }

  if (!shouldReset && agent.session_id) {
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
        logger.debug({
          agentId: agent.id,
          cacheTokens,
          maxTokens,
          reason: 'cache_token_limit',
        }, 'agent.session.reset');
      }
    }

    if (!shouldReset && runCount > maxRuns) {
      shouldReset = true;
      logger.debug({
        agentId: agent.id,
        runCount,
        maxRuns,
        reason: 'run_count_limit',
      }, 'agent.session.reset');
    }
  }

  const existingSessionId = shouldReset ? null : agent.session_id;
  let sessionId = existingSessionId || uuidv4();

  db.prepare('UPDATE agents SET session_run_count = ? WHERE id = ?')
    .run(shouldReset ? 1 : runCount, agent.id);

  const { command, useStreamJson } = buildAgentProcessCommand({
    toolPath,
    resolvedCommandType,
    sessionId,
    existingSessionId,
  });

  const fullPrompt = (existingSessionId || !systemPrompt) ? prompt : systemPrompt + prompt;
  const promptFile = writePromptFile(runId, fullPrompt);

  if (existingSessionId && systemPrompt) {
    logger.debug({
      agentId: agent.id,
      sessionId,
      savedChars: systemPrompt.length,
    }, 'agent.session.resumed');
  }

  db.prepare(`
    UPDATE agents SET status = 'running', last_prompt = ?, session_id = ?, started_at = datetime('now'), finished_at = NULL, pid = NULL
    WHERE id = ?
  `).run(fullPrompt, sessionId, agent.id);

  broadcastToProject(agent.project_id, {
    type: 'agent_status', projectId: agent.project_id,
    data: { agentId: agent.id, status: 'running' },
  });

  const cwd = resolveAgentCwd(agent);
  const { shellPath, shellArgs } = buildShellInvocation(command);
  const childEnv = buildChildEnv({ agent, runId, sessionId, fullPrompt, promptFile });
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
  runningProcesses.set(agent.id, child);
  lastActivityTime.set(agent.id, Date.now());
  db.prepare('UPDATE agents SET pid = ? WHERE id = ?').run(pid, agent.id);

  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    runId,
    pid,
    commandType: resolvedCommandType,
    sessionId,
    resumedSession: Boolean(existingSessionId),
    cwd,
  }, 'agent.run.started');

  const logStmt = db.prepare(
    'INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, ?)'
  );
  logStmt.run(agent.id, runId, fullPrompt, 'stdin');

  const isStreamJson = useStreamJson;
  const isCodex = resolvedCommandType === 'codex' && isStreamJson;
  const requiresCompletionSignal = isStreamJson && (
    isCodex ||
    resolvedCommandType === 'claude' ||
    resolvedCommandType === 'gemini'
  );

  const output = createAgentOutputHandlers({
    db,
    logStmt,
    agent,
    runId,
    isStreamJson,
    isCodex,
    resolvedCommandType,
    updateSessionId: (nextSessionId) => {
      sessionId = nextSessionId;
    },
  });

  child.stdout?.on('data', output.handleData('stdout'));
  child.stderr?.on('data', output.handleData('stderr'));

  child.on('close', (code) => {
    runningProcesses.delete(agent.id);
    lastActivityTime.delete(agent.id);
    childCpuSnapshots.delete(agent.id);
    const hadFinalResult = agentFinalResultTime.has(agent.id);
    agentFinalResultTime.delete(agent.id);
    cleanupPromptFile(promptFile);

    if (!isDatabaseOpen()) {
      logger.info(`Agent ${agent.id} close event after DB closed, skipping DB writes`);
      return;
    }

    if (isShuttingDown()) {
      logger.info(`Agent ${agent.id} close event during shutdown, skipping DB writes`);
      return;
    }

    const wasApiConnectError = agentLastErrorWasApiConnect.get(agent.id) || false;
    agentLastErrorWasApiConnect.delete(agent.id);

    const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agent.id) as { status: string } | undefined;
    const status = currentAgent?.status === 'idle' ? 'idle' : classifyAgentExitStatus({
      exitCode: code,
      requiresCompletionSignal,
      sawClosedStdinSessionError: output.state.sawClosedStdinSessionError,
      sawCompletionSignal: output.state.sawCompletionSignal,
      hadFinalResult,
    });

    if (code === 0 && output.state.sawClosedStdinSessionError && !hadFinalResult) {
      logger.warn({
        projectId: agent.project_id,
        agentId: agent.id,
        runId,
        exitCode: code,
      }, 'agent.run.closed_stdin_error');
    }
    if (
      code === 0 &&
      requiresCompletionSignal &&
      !output.state.sawClosedStdinSessionError &&
      !output.state.sawCompletionSignal &&
      !hadFinalResult
    ) {
      logger.warn({
        projectId: agent.project_id,
        agentId: agent.id,
        runId,
        exitCode: code,
      }, 'agent.run.missing_completion_signal');
      output.logAndBroadcast('HAICO: agent exited without emitting a completion event; marking this run as error\n', 'stderr');
    }

    logger.info({
      projectId: agent.project_id,
      agentId: agent.id,
      runId,
      status,
      exitCode: code,
      durationMs: Date.now() - startedAtMs,
      pid,
      hadFinalResult,
      sawCompletionSignal: output.state.sawCompletionSignal,
    }, 'agent.run.completed');

    if (status === 'error' && existingSessionId && !output.state.sawStdout && RESUME_MISSING_FILE_RE.test(output.state.stderrSample)) {
      logger.warn({
        projectId: agent.project_id,
        agentId: agent.id,
        runId,
      }, 'agent.run.resume_missing_file');
      output.logAndBroadcast('HAICO: 旧 session 恢复失败，自动改为新 session 重试...\n', 'stderr');
      db.prepare("UPDATE agents SET session_id = NULL, status = 'idle', pid = NULL WHERE id = ?").run(agent.id);
      const freshAgent = { ...agent, session_id: null };
      startAgentProcess(freshAgent, prompt, commandTemplate, systemPrompt);
      return;
    }

    if (status === 'error') {
      if (wasApiConnectError) {
        const apiErrCount = (agentApiConnectErrorCount.get(agent.id) || 0) + 1;
        agentApiConnectErrorCount.set(agent.id, apiErrCount);

        if (apiErrCount <= 1) {
          const retryDelayMs = 5 * 60 * 1000;
          logger.warn({
            projectId: agent.project_id,
            agentId: agent.id,
            runId,
            attempt: apiErrCount,
            retryDelayMs,
          }, 'agent.run.api_connection_retry_scheduled');
          output.logAndBroadcast('HAICO: API连接失败，5分钟后自动重试...\n', 'stderr');
          db.prepare(`
            UPDATE agents SET status = 'waiting', pid = NULL, finished_at = datetime('now') WHERE id = ?
          `).run(agent.id);
          broadcastToProject(agent.project_id, {
            type: 'agent_status', projectId: agent.project_id,
            data: { agentId: agent.id, status: 'waiting' },
          });
          const retryTimer = setTimeout(() => {
            pendingRetryTimers.delete(agent.id);
            if (isShuttingDown() || !isDatabaseOpen()) return;
            const retryAgent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as Agent | undefined;
            if (retryAgent && (retryAgent.status === 'waiting' || retryAgent.status === 'running')) {
              logger.info({
                projectId: agent.project_id,
                agentId: agent.id,
                previousRunId: runId,
              }, 'agent.run.api_connection_retrying');
              startAgentProcess(retryAgent, prompt, commandTemplate, systemPrompt);
            }
          }, retryDelayMs);
          pendingRetryTimers.set(agent.id, retryTimer);
          return;
        }

        logger.error({
          projectId: agent.project_id,
          agentId: agent.id,
          runId,
          attempts: apiErrCount,
        }, 'agent.run.api_connection_failed');
        output.logAndBroadcast('HAICO: API连接持续失败，请检查网络/API配置后手动重启agent\n', 'stderr');
        agentApiConnectErrorCount.delete(agent.id);
      } else {
        agentApiConnectErrorCount.delete(agent.id);
      }

      logger.debug({
        projectId: agent.project_id,
        agentId: agent.id,
        runId,
        reason: 'error',
      }, 'agent.session.cleared');
      db.prepare(`
        UPDATE agents SET status = ?, pid = NULL, finished_at = datetime('now'), session_id = NULL WHERE id = ?
      `).run(status, agent.id);
    } else {
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

    if (onAgentFinish) {
      const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as Agent;
      if (updated) {
        onAgentFinish(updated, code);
      }
    }
  });

  child.on('error', (err: any) => {
    logger.error({
      err,
      projectId: agent.project_id,
      agentId: agent.id,
      runId,
      cwd,
      shell: shellPath,
      durationMs: Date.now() - startedAtMs,
    }, 'agent.run.spawn_failed');
    runningProcesses.delete(agent.id);
    lastActivityTime.delete(agent.id);
    childCpuSnapshots.delete(agent.id);
    agentFinalResultTime.delete(agent.id);
    cleanupPromptFile(promptFile);

    if (isShuttingDown() || !isDatabaseOpen()) {
      logger.info(`Agent ${agent.id} error event during shutdown/after DB closed, skipping DB writes`);
      return;
    }

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

