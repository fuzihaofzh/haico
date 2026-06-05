import Database from 'better-sqlite3';
import logger from '../../logger';
import { DEFAULT_IDLE_TIMEOUT_MS, FINAL_RESULT_KILL_DELAY_MS, getAgentFinalResultAge } from '../process-manager';
import { getRunTracker } from '../adapters/run-tracker';
import { handleTaskRunExit } from './completion';

type LogMethod = {
  (message: string, ...args: unknown[]): void;
  (payload: unknown, message?: string, ...args: unknown[]): void;
};

export interface TaskRunWatchdogLogger {
  debug: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

export interface TaskRunWatchdogResult {
  scanned: number;
  failedMissingProcess: number;
  failedIdle: number;
  completedAfterFinalResult: number;
}

export function runTaskRunWatchdogScan(
  db: Database.Database,
  log: TaskRunWatchdogLogger = logger
): TaskRunWatchdogResult {
  const rows = db.prepare(`
    SELECT tr.id, tr.task_id, tr.agent_id, tr.project_id, tr.pid, tr.status, a.name AS agent_name
    FROM task_runs tr
    JOIN agents a ON a.id = tr.agent_id
    WHERE tr.status IN ('starting', 'running')
    ORDER BY tr.started_at ASC, tr.created_at ASC
  `).all() as Array<{
    id: string;
    task_id: string;
    agent_id: string;
    project_id: string;
    pid: number | null;
    status: string;
    agent_name: string;
  }>;

  const result: TaskRunWatchdogResult = {
    scanned: rows.length,
    failedMissingProcess: 0,
    failedIdle: 0,
    completedAfterFinalResult: 0,
  };

  for (const row of rows) {
    if (!getRunTracker().isRunning(row.id)) {
      handleTaskRunExit({
        taskRunId: row.id,
        status: 'failed',
        exitCode: null,
        failureKind: 'process_missing',
        failureMessage: 'TaskRun is active in DB but no child process is registered',
      });
      result.failedMissingProcess += 1;
      log.warn({
        projectId: row.project_id,
        agentId: row.agent_id,
        taskId: row.task_id,
        taskRunId: row.id,
      }, 'task.watchdog.process_missing');
      continue;
    }

    const finalResultAgeMs = getAgentFinalResultAge(row.agent_id);
    if (finalResultAgeMs >= FINAL_RESULT_KILL_DELAY_MS) {
      handleTaskRunExit({
        taskRunId: row.id,
        status: 'completed',
        exitCode: null,
        failureKind: null,
        failureMessage: null,
      });
      result.completedAfterFinalResult += 1;
      log.warn({
        projectId: row.project_id,
        agentId: row.agent_id,
        taskId: row.task_id,
        taskRunId: row.id,
        finalResultAgeMs,
      }, 'task.watchdog.final_result_timeout_completed');
      continue;
    }

    const idleMs = getRunTracker().getIdleMs(row.id);
    if (idleMs >= 0 && idleMs >= DEFAULT_IDLE_TIMEOUT_MS) {
      handleTaskRunExit({
        taskRunId: row.id,
        status: 'failed',
        exitCode: null,
        failureKind: 'task_run_idle_timeout',
        failureMessage: `TaskRun produced no output for ${Math.round(idleMs / 60000)} minute(s)`,
      });
      result.failedIdle += 1;
      log.warn({
        projectId: row.project_id,
        agentId: row.agent_id,
        taskId: row.task_id,
        taskRunId: row.id,
        idleMs,
      }, 'task.watchdog.idle_timeout');
    }
  }

  return result;
}
