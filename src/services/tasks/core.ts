import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../../db/database';
import { Agent, Project, Task, TaskRun } from '../../types';
import { buildSystemPrompt } from '../system-prompt';
import { getAgentOrThrow, getProjectOrThrow } from '../agents/core';
import { AgentAlreadyRunningError, AgentPausedError, AgentPromptUnavailableError, AgentRetryPromptMissingError } from '../agents/errors';
import { resolveExecutorProfile, snapshotExecutorConfig } from '../executors/profiles';
import { startCliTaskRun } from '../executors/cli-executor';
import { handleTaskRunExit } from './completion';
import { getAgentRuntimeState } from './runtime-state';

export interface StartManualTaskInput {
  prompt?: string;
  priority?: number;
  force_new_session?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunTaskImmediatelyOptions {
  forceNewSession?: boolean;
}

export interface CreateAgentTaskInput {
  prompt: string;
  source: string;
  source_ref?: string | null;
  task_type?: string;
  reason: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  force_new_session?: boolean;
  scheduled_at?: string | null;
  dedupe_key?: string | null;
  enforce_agent_available?: boolean;
}

export class TaskDependencyBlockedError extends Error {
  constructor() {
    super('Task dependency is not completed');
  }
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function isRawShell(commandTemplate: string): boolean {
  return /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
}

function getActiveTaskRunForAgent(agentId: string): TaskRun | undefined {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM task_runs
    WHERE agent_id = ? AND status IN ('starting', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(agentId) as TaskRun | undefined;
}

export function createAgentTask(agentId: string, input: CreateAgentTaskInput): Task {
  return createAgentTaskWithId(uuidv4(), agentId, input);
}

export function createAgentTaskWithId(taskId: string, agentId: string, input: CreateAgentTaskInput): Task {
  const db = getDatabase();
  if (input.dedupe_key) {
    const existing = db.prepare(`
      SELECT *
      FROM tasks
      WHERE dedupe_key = ? AND status IN ('pending', 'blocked', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(input.dedupe_key) as Task | undefined;
    if (existing) return existing;
  }

  const agent = getAgentOrThrow(db, agentId);
  const project = getProjectOrThrow(db, agent.project_id, 'Project not found for this agent');
  const prompt = (input.prompt || '').trim();
  if (!prompt) throw new AgentPromptUnavailableError();
  if (input.enforce_agent_available && getAgentRuntimeState(agentId).status === 'paused') {
    throw new AgentPausedError();
  }

  const executorProfile = resolveExecutorProfile(db, project, agent);
  const executorSnapshot = snapshotExecutorConfig(db, executorProfile, agent, project);
  if (input.force_new_session || input.metadata?.force_new_session) {
    executorSnapshot.session_policy.new_session_per_run = true;
  }
  const systemPrompt = isRawShell(executorSnapshot.command_template)
    ? null
    : buildSystemPrompt(agent, project);
  const contextSnapshot = {
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      is_controller: Boolean(agent.is_controller),
      custom_instructions: agent.custom_instructions || '',
      constraints: safeJsonParse(agent.constraints_json, {}),
      context: safeJsonParse(agent.context_json, {}),
      capabilities: safeJsonParse(agent.capabilities_json, {}),
      executor_preferences: safeJsonParse(agent.executor_preferences_json, {}),
    },
    project: {
      id: project.id,
      name: project.name,
      task_description: project.task_description,
    },
  };

  db.prepare(`
    INSERT INTO tasks (
      id, project_id, target_agent_id, source, source_ref, task_type, reason,
      prompt, system_prompt, priority, status, scheduled_at, executor_profile_id,
      executor_snapshot_json, context_snapshot_json, metadata_json, dedupe_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', COALESCE(?, strftime('%Y-%m-%d %H:%M:%f', 'now')), ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
  `).run(
    taskId,
    project.id,
    agent.id,
    input.source,
    input.source_ref || null,
    input.task_type || 'internal',
    input.reason,
    prompt,
    systemPrompt,
    input.priority ?? 10,
    input.scheduled_at || null,
    executorProfile.id,
    json(executorSnapshot),
    json(contextSnapshot),
    json(input.metadata || {}),
    input.dedupe_key || null
  );

  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task;
}

export function createManualAgentTask(agentId: string, input: StartManualTaskInput = {}): Task {
  return createAgentTask(agentId, {
    prompt: input.prompt || '',
    source: 'user-manual',
    source_ref: null,
    task_type: 'manual',
    reason: 'Manual agent start',
    priority: input.priority ?? 10,
    metadata: input.metadata || {},
    force_new_session: input.force_new_session,
    enforce_agent_available: true,
  });
}

function assertTaskRunnable(db: ReturnType<typeof getDatabase>, task: Task, agent: Agent): void {
  const runtime = getAgentRuntimeState(agent.id);
  if (runtime.status === 'paused') throw new AgentPausedError();
  if (runtime.active_task_run_id) throw new AgentAlreadyRunningError();

  const blockedDependency = db.prepare(`
    SELECT 1
    FROM task_dependencies td
    JOIN tasks dep ON dep.id = td.depends_on_task_id
    WHERE td.task_id = ? AND dep.status <> 'completed'
    LIMIT 1
  `).get(task.id);
  if (blockedDependency) {
    throw new TaskDependencyBlockedError();
  }
}

function markTaskBlocked(taskId: string, failureKind: string, failureMessage: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE tasks
    SET status = 'blocked', failure_kind = ?, failure_message = ?, updated_at = datetime('now')
    WHERE id = ? AND status IN ('pending', 'blocked')
  `).run(failureKind, failureMessage, taskId);
}

export function runTaskImmediately(
  taskId: string,
  options: RunTaskImmediatelyOptions = {}
): { success: true; task_id: string; task_run_id: string; run_id: string; pid: number } {
  const db = getDatabase();
  let claimed: {
    task: Task;
    agent: Agent;
    taskRunId: string;
    runId: string;
    executorSnapshot: unknown;
  };
  try {
    claimed = db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
    if (!task) throw new Error('Task not found');
    if (task.status !== 'pending' && task.status !== 'blocked') {
      throw new Error(`Task is not runnable: ${task.status}`);
    }
    const agent = getAgentOrThrow(db, task.target_agent_id || '');
    const project = getProjectOrThrow(db, task.project_id);
    assertTaskRunnable(db, task, agent);

    const updated = db.prepare(`
      UPDATE tasks
      SET status = 'running', claimed_at = datetime('now'), started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'blocked')
    `).run(task.id);
    if (updated.changes !== 1) throw new Error('Task claim failed');

    const taskRunId = uuidv4();
    const runId = uuidv4();
    const attempt = (db.prepare('SELECT COUNT(*) AS count FROM task_runs WHERE task_id = ?').get(task.id) as { count: number }).count + 1;
    const executorSnapshot = safeJsonParse(task.executor_snapshot_json, {}) as any;
    if (options.forceNewSession && executorSnapshot?.session_policy) {
      executorSnapshot.session_policy.new_session_per_run = true;
    }
    const commandSnapshot = (executorSnapshot as any).command_template || '';
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, project_id, agent_id, executor_profile_id, run_id, attempt,
        status, prompt_snapshot, command_snapshot, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
    `).run(
      taskRunId,
      task.id,
      project.id,
      agent.id,
      task.executor_profile_id,
      runId,
      attempt,
      task.prompt,
      commandSnapshot
    );
    db.prepare('UPDATE tasks SET current_task_run_id = ? WHERE id = ?').run(taskRunId, task.id);

    return { task, agent, taskRunId, runId, executorSnapshot };
    })();
  } catch (err) {
    if (err instanceof TaskDependencyBlockedError) {
      markTaskBlocked(taskId, 'dependency_blocked', err.message);
    }
    throw err;
  }

  const result = startCliTaskRun({
    agent: claimed.agent,
    taskId: claimed.task.id,
    taskRunId: claimed.taskRunId,
    executorProfileId: claimed.task.executor_profile_id,
    runId: claimed.runId,
    prompt: claimed.task.prompt,
    systemPrompt: claimed.task.system_prompt,
    executor: claimed.executorSnapshot as any,
  });

  return {
    success: true,
    task_id: claimed.task.id,
    task_run_id: claimed.taskRunId,
    run_id: result.runId,
    pid: result.pid,
  };
}

export function startManualAgentTask(agentId: string, input: StartManualTaskInput = {}): { success: true; task_id: string; task_run_id: string; run_id: string; pid: number } {
  const task = createManualAgentTask(agentId, input);
  try {
    return runTaskImmediately(task.id);
  } catch (err) {
    const db = getDatabase();
    if (err instanceof AgentAlreadyRunningError || err instanceof AgentPausedError) {
      db.prepare(`
        UPDATE tasks
        SET status = 'cancelled', failure_kind = ?, failure_message = ?, finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(
        err instanceof AgentAlreadyRunningError ? 'agent_busy' : 'agent_paused',
        err.message,
        task.id
      );
    }
    throw err;
  }
}

export function retryLastTaskRunForAgent(
  agentId: string,
  input: { force_new_session?: boolean } = {}
): { success: true; task_id: string; task_run_id: string; run_id: string; pid: number } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);
  const runtime = getAgentRuntimeState(agent.id);
  if (runtime.status === 'paused') throw new AgentPausedError();
  if (runtime.active_task_run_id) throw new AgentAlreadyRunningError();

  const latest = db.prepare(`
    SELECT tr.id AS task_run_id, tr.task_id, tr.status AS task_run_status, t.status AS task_status
    FROM task_runs tr
    JOIN tasks t ON t.id = tr.task_id
    WHERE tr.agent_id = ?
    ORDER BY tr.created_at DESC
    LIMIT 1
  `).get(agent.id) as
    | { task_run_id: string; task_id: string; task_run_status: string; task_status: string }
    | undefined;

  if (!latest || !['failed', 'cancelled'].includes(latest.task_run_status)) {
    throw new AgentRetryPromptMissingError();
  }

  db.prepare(`
    UPDATE tasks
    SET status = 'pending',
        claimed_at = NULL,
        started_at = NULL,
        finished_at = NULL,
        failure_kind = NULL,
        failure_message = NULL,
        updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(latest.task_id);

  return runTaskImmediately(latest.task_id, {
    forceNewSession: Boolean(input.force_new_session),
  });
}

export function cancelActiveTaskForAgent(agentId: string): { success: true } {
  const db = getDatabase();
  const active = getActiveTaskRunForAgent(agentId);
  if (!active) return { success: true };
  handleTaskRunExit({
    taskRunId: active.id,
    status: 'cancelled',
    exitCode: null,
    failureKind: 'user_stopped',
    failureMessage: 'Task run stopped by user',
  });
  return { success: true };
}
