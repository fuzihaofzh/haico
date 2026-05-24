import logger from '../../logger';
import { AgentAlreadyRunningError, AgentPausedError } from '../agents/errors';
import { getDatabase } from '../../db/database';
import { runTaskImmediately, TaskDependencyBlockedError } from './core';

export interface TaskSchedulerTickResult {
  scanned: number;
  started: number;
  blocked: number;
  failed: number;
  taskIds: string[];
}

function blockTask(taskId: string, failureKind: string, failureMessage: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE tasks
    SET status = 'blocked', failure_kind = ?, failure_message = ?, updated_at = datetime('now')
    WHERE id = ? AND status IN ('pending', 'blocked')
  `).run(failureKind, failureMessage, taskId);
}

export function runTaskSchedulerTick(limit = 10): TaskSchedulerTickResult {
  const db = getDatabase();
  const tasks = db.prepare(`
    SELECT id
    FROM tasks
    WHERE status IN ('pending', 'blocked')
      AND (scheduled_at IS NULL OR scheduled_at <= strftime('%Y-%m-%d %H:%M:%f', 'now'))
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(Math.max(1, limit)) as Array<{ id: string }>;

  const result: TaskSchedulerTickResult = {
    scanned: tasks.length,
    started: 0,
    blocked: 0,
    failed: 0,
    taskIds: [],
  };

  for (const task of tasks) {
    try {
      const started = runTaskImmediately(task.id);
      result.started += 1;
      result.taskIds.push(started.task_id);
    } catch (err) {
      if (err instanceof AgentAlreadyRunningError) {
        blockTask(task.id, 'agent_busy', err.message);
        result.blocked += 1;
        continue;
      }
      if (err instanceof AgentPausedError) {
        blockTask(task.id, 'agent_paused', err.message);
        result.blocked += 1;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.debug({ err, taskId: task.id }, 'task.scheduler.task_not_started');
      if (err instanceof TaskDependencyBlockedError) {
        result.blocked += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}
