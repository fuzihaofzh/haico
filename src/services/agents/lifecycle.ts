import { getDatabase } from '../../db/database';
import { buildSystemPrompt } from '../system-prompt';
import { eventBus } from '../../events';
import logger from '../../logger';
import {
  AgentAlreadyPausedError,
  AgentNotPausedError,
  AgentPausedError,
} from './errors';
import { getAgentOrThrow, getProjectOrThrow } from './core';
import { AgentStopLogger, StartAgentServiceInput } from './types';
import {
  cancelActiveTaskForAgent,
  getAgentRuntimeState,
  retryLastTaskRunForAgent,
  startManualAgentTask,
} from '../tasks';

export function startAgent(
  agentId: string,
  input: StartAgentServiceInput = {}
): { success: true; task_id: string; task_run_id: string; run_id: string; pid: number } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  if (agent.paused || getAgentRuntimeState(agent.id).status === 'paused') {
    throw new AgentPausedError();
  }

  const result = startManualAgentTask(agent.id, {
    prompt: input.prompt,
    priority: input.priority,
    force_new_session: Boolean(input.force_new_session),
    metadata: {
      force_new_session: Boolean(input.force_new_session),
      ...(input.metadata || {}),
    },
  });

  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    taskId: result.task_id,
    taskRunId: result.task_run_id,
    runId: result.run_id,
    pid: result.pid,
    forceNewSession: Boolean(input.force_new_session),
  }, 'agent.started');

  return result;
}

export function retryAgent(
  agentId: string,
  input: { force_new_session?: boolean } = {}
): { success: true; task_id: string; task_run_id: string; run_id: string; pid: number } {
  const result = retryLastTaskRunForAgent(agentId, input);
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    taskId: result.task_id,
    taskRunId: result.task_run_id,
    runId: result.run_id,
    pid: result.pid,
    forceNewSession: Boolean(input.force_new_session),
  }, 'agent.retried');

  return result;
}

export function stopAgent(agentId: string, _requestLogger?: AgentStopLogger): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);
  const result = cancelActiveTaskForAgent(agent.id);

  eventBus.publish('agent.status_changed', {
    type: 'agent.status_changed',
    projectId: agent.project_id,
    payload: { agentId: agent.id, status: 'idle' },
    meta: { correlationId: agent.id, timestamp: Date.now(), source: 'agents/lifecycle.stopAgent' },
  });

  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    taskRuntime: true,
  }, 'agent.stopped');

  return result;
}

export function pauseAgent(agentId: string): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  if (agent.paused) {
    throw new AgentAlreadyPausedError();
  }

  const runtimeState = getAgentRuntimeState(agent.id);
  cancelActiveTaskForAgent(agent.id);

  db.prepare("UPDATE agents SET paused = 1, status = 'idle' WHERE id = ?").run(agent.id);

  eventBus.publish('agent.status_changed', {
    type: 'agent.status_changed',
    projectId: agent.project_id,
    payload: { agentId: agent.id, status: 'paused', paused: true },
    meta: { correlationId: agent.id, timestamp: Date.now(), source: 'agents/lifecycle.pauseAgent' },
  });

  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    wasRunning: Boolean(runtimeState.active_task_run_id),
  }, 'agent.paused');

  return { success: true };
}

export function unpauseAgent(agentId: string): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  if (!agent.paused) {
    throw new AgentNotPausedError();
  }

  db.prepare("UPDATE agents SET paused = 0, status = 'idle' WHERE id = ?").run(agent.id);

  eventBus.publish('agent.status_changed', {
    type: 'agent.status_changed',
    projectId: agent.project_id,
    payload: { agentId: agent.id, status: 'idle', paused: false },
    meta: { correlationId: agent.id, timestamp: Date.now(), source: 'agents/lifecycle.unpauseAgent' },
  });

  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
  }, 'agent.unpaused');

  return { success: true };
}

export function getAgentStatus(agentId: string): any {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);
  const runtimeState = getAgentRuntimeState(agent.id);

  let lastError: string | null = null;
  if (runtimeState.status === 'error') {
    const latestRun = db.prepare(
      "SELECT run_id FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT 1"
    ).get(agent.id) as { run_id: string } | undefined;

    if (latestRun?.run_id) {
      const errLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stderr' AND trim(content) != '' ORDER BY id DESC LIMIT 1"
      ).get(agent.id, latestRun.run_id) as { content: string } | undefined;
      lastError = errLog?.content || null;

      if (!lastError) {
        const anyLog = db.prepare(
          "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream != 'cost' AND trim(content) != '' AND content NOT LIKE '--- [%] Cost:%' ORDER BY id DESC LIMIT 1"
        ).get(agent.id, latestRun.run_id) as { content: string } | undefined;
        lastError = anyLog?.content || null;
      }
    }
  }

  return {
    id: agent.id,
    name: agent.name,
    status: runtimeState.status,
    paused: !!agent.paused,
    pid: null,
    is_running: runtimeState.status === 'running',
    started_at: null,
    finished_at: null,
    runtime_state: runtimeState,
    active_task_id: runtimeState.active_task_id,
    active_task_run_id: runtimeState.active_task_run_id,
    last_error: lastError,
  };
}

export function getAgentSystemPrompt(agentId: string): { prompt: string } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);
  const project = getProjectOrThrow(db, agent.project_id);
  return { prompt: buildSystemPrompt(agent, project) };
}
