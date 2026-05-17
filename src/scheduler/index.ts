import cron from 'node-cron';
import { config } from '../config';
import { getDatabase, isDatabaseOpen } from '../db/database';
import { cleanupConversationLogs } from '../db/maintenance';
import logger from '../logger';
import { runIssueRecoveryScan } from '../services/issue/recovery';
import { runAgentWatchdogScan, DEFAULT_IDLE_TIMEOUT_MS } from '../services/process-manager';

type ScheduledTaskName = 'logCleanup' | 'issueRecovery' | 'watchdog';

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

function startIssueRecovery(): void {
  scheduleTask('issueRecovery', '*/3 * * * *', () => {
    runIssueRecoveryScan(getDatabase(), logger);
  });
  logger.info('Worker scan scheduled: every 3 minutes');
}

function startWatchdog(): void {
  scheduleTask('watchdog', '*/5 * * * *', () => {
    runAgentWatchdogScan(getDatabase(), logger);
  });
  logger.info(`Watchdog scheduled: every 5 minutes, idle timeout ${DEFAULT_IDLE_TIMEOUT_MS / 60000} minutes`);
}

export function initializeScheduler(): void {
  startLogCleanup();
  startIssueRecovery();
  startWatchdog();

  logger.info('Scheduler initialized');
}

export function stopAllSchedulers(): void {
  for (const name of Object.keys(tasks) as ScheduledTaskName[]) {
    tasks[name]?.stop();
    delete tasks[name];
  }
  logger.info('All schedulers stopped');
}
