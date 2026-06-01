import { getDatabase } from '../../db/database';
import logger from '../../logger';
import { Agent, Project, Task, TaskRunStatus } from '../../types';
import { broadcastToProject } from '../../realtime';
import { eventBus } from '../../events';
import { v4 as uuidv4 } from 'uuid';

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractIssueNumbers(task: Task): number[] {
  const metadata = safeJsonParse<Record<string, any>>(task.metadata_json, {});
  const numbers = new Set<number>();
  for (const key of ['issue_number', 'trigger_issue_number']) {
    if (typeof metadata[key] === 'number') numbers.add(metadata[key]);
  }
  const batch = metadata.current_batch_issue_numbers;
  if (Array.isArray(batch)) {
    for (const value of batch) {
      if (typeof value === 'number') numbers.add(value);
    }
  }
  return [...numbers];
}

function routeTaskCompletion(task: Task, input: {
  taskRunId: string;
  status: Extract<TaskRunStatus, 'completed' | 'failed' | 'cancelled'>;
}): void {
  const db = getDatabase();
  const agent = task.target_agent_id
    ? db.prepare('SELECT * FROM agents WHERE id = ?').get(task.target_agent_id) as Agent | undefined
    : undefined;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) as Project | undefined;
  if (!project || project.status === 'paused') return;

  if (task.task_type === 'issue-work') {
    eventBus.publish('task.completed', {
      type: 'task.completed',
      projectId: task.project_id,
      payload: {
        taskId: task.id,
        taskRunId: input.taskRunId,
        agentId: agent?.id || 'system',
        taskType: task.task_type,
        status: input.status,
        issueNumbers: extractIssueNumbers(task),
      },
      meta: { correlationId: uuidv4(), timestamp: Date.now(), source: 'tasks/completion' },
    });
  }

  if (task.task_type === 'controller' && input.status === 'completed') {
    eventBus.publish('task.completed', {
      type: 'task.completed',
      projectId: task.project_id,
      payload: {
        taskId: task.id,
        taskRunId: input.taskRunId,
        agentId: agent?.id || 'system',
        taskType: task.task_type,
        status: input.status,
        issueNumbers: [],
      },
      meta: { correlationId: uuidv4(), timestamp: Date.now(), source: 'tasks/completion' },
    });
  }

  if (task.task_type === 'message' && input.status === 'completed' && task.source_ref && agent) {
    db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ? AND to_agent_id = ?")
      .run(task.source_ref, agent.id);
    const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(task.source_ref);
    if (!message) return;
    broadcastToProject(task.project_id, {
      type: 'agent_message',
      projectId: task.project_id,
      data: { message, status: 'read' },
    });
  }
}

export function completeTaskRun(input: {
  taskRunId: string;
  status: Extract<TaskRunStatus, 'completed' | 'failed' | 'cancelled'>;
  exitCode: number | null;
  failureKind?: string | null;
  failureMessage?: string | null;
}): void {
  const db = getDatabase();
  const taskRun = db.prepare('SELECT task_id, agent_id, project_id, status, finished_at FROM task_runs WHERE id = ?').get(input.taskRunId) as
    | { task_id: string; agent_id: string; project_id: string; status: string; finished_at: string | null }
    | undefined;
  if (!taskRun) return;
  if (taskRun.finished_at || !['starting', 'running'].includes(taskRun.status)) return;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskRun.task_id) as Task | undefined;
  if (!task) return;

  const taskStatus = input.status === 'completed'
    ? 'completed'
    : input.status === 'cancelled'
      ? 'cancelled'
      : 'failed';

  db.transaction(() => {
    db.prepare(`
      UPDATE task_runs
      SET status = ?, exit_code = ?, failure_kind = ?, failure_message = ?, finished_at = datetime('now')
      WHERE id = ?
    `).run(
      input.status,
      input.exitCode,
      input.failureKind || null,
      input.failureMessage || null,
      input.taskRunId
    );

    db.prepare(`
      UPDATE tasks
      SET status = ?, finished_at = datetime('now'), updated_at = datetime('now'), failure_kind = ?, failure_message = ?
      WHERE id = ?
    `).run(
      taskStatus,
      input.failureKind || null,
      input.failureMessage || null,
      taskRun.task_id
    );
  })();

  logger.debug({
    projectId: taskRun.project_id,
    agentId: taskRun.agent_id,
    taskId: taskRun.task_id,
    taskRunId: input.taskRunId,
    status: taskStatus,
  }, 'task.completion.routed');
  try {
    routeTaskCompletion(task, {
      taskRunId: input.taskRunId,
      status: input.status,
    });
  } catch (err) {
    logger.warn({ err, taskId: task.id, taskRunId: input.taskRunId }, 'task.completion.route_failed');
  }
}

export function failTaskRunSpawn(taskRunId: string, message: string): void {
  completeTaskRun({
    taskRunId,
    status: 'failed',
    exitCode: null,
    failureKind: 'spawn_failed',
    failureMessage: message,
  });
}
