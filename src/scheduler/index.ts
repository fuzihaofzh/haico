import cron from 'node-cron';
import { config } from '../config';
import { getDatabase, isDatabaseOpen } from '../db/database';
import { cleanupConversationLogs } from '../db/maintenance';
import logger from '../logger';
import { runTaskRunWatchdogScan, runTaskSchedulerTick } from '../services/tasks';
import { runIssueRecoveryScan } from '../services/issue/recovery';

type ScheduledTaskName = 'logCleanup' | 'taskRuntime' | 'issueRecovery';

const tasks: Partial<Record<ScheduledTaskName, cron.ScheduledTask>> = {};

function scheduleTask(
  name: ScheduledTaskName,
  expression: string,
  run: () => void
): void {
  tasks[name]?.stop();
  tasks[name] = cron.schedule(expression, () => {
    if (!isDatabaseOpen()) return;

    try {
      run();
    } catch (e) {
      logger.error({ err: e }, `scheduler.${name}_failed`);
    }
  });
}

function startLogCleanup(): void {
  scheduleTask('logCleanup', '0 3 * * *', () => {
    const days = config.logRetentionDays;
    const deletedCount = cleanupConversationLogs(getDatabase(), days);
    if (deletedCount > 0) {
      logger.info(`Log cleanup: deleted ${deletedCount} log entries older than ${days} days`);
    }
  });
  logger.info(`Log cleanup scheduled: retain ${config.logRetentionDays} days`);
}

export function initializeScheduler(): void {
  startLogCleanup();
  scheduleTask('taskRuntime', '*/1 * * * *', () => {
    const watchdog = runTaskRunWatchdogScan(getDatabase(), logger);
    const result = runTaskSchedulerTick(10);
    if (
      watchdog.failedMissingProcess > 0 ||
      watchdog.failedIdle > 0 ||
      watchdog.completedAfterFinalResult > 0 ||
      result.started > 0 ||
      result.blocked > 0 ||
      result.failed > 0
    ) {
      logger.info({ watchdog, scheduler: result }, 'task.runtime.tick');
    }
  });
  scheduleTask('issueRecovery', '*/2 * * * *', () => {
    runIssueRecoveryScan(getDatabase(), logger);
  });

  logger.info('Scheduler initialized');
}

export function stopAllSchedulers(): void {
  for (const name of Object.keys(tasks) as ScheduledTaskName[]) {
    tasks[name]?.stop();
    delete tasks[name];
  }
  logger.info('All schedulers stopped');
}
