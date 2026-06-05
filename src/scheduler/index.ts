import cron from 'node-cron';
import { config } from '../config';
import { getDatabase, isDatabaseOpen } from '../db/database';
import { cleanupConversationLogs } from '../db/maintenance';
import logger from '../logger';
import { runTaskRunWatchdogScan, runTaskSchedulerTick } from '../services/tasks';
import { runScheduledCheckTick } from '../services/skills/builtins/scheduled-check';
import { runIssueRecoveryScan } from '../services/issue/recovery';
import { purgeOldEvents } from '../events/store';
import { markExpiredKnowledgeEntries } from '../services/knowledge/lifecycle';
import { eventBus } from '../events';

import { v4 as uuidv4 } from 'uuid';

type ScheduledTaskName = 'logCleanup' | 'taskRuntime' | 'issueRecovery' | 'eventLogCleanup' | 'knowledgeExpiry';

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
    eventBus.publish('scheduler.tick', {
      type: 'scheduler.tick',
      projectId: '',
      payload: { tickType: 'taskRuntime' },
      meta: { correlationId: uuidv4(), timestamp: Date.now(), source: 'scheduler/taskRuntime' },
    });
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
    runScheduledCheckTick();
  });
  scheduleTask('issueRecovery', '*/2 * * * *', () => {
    eventBus.publish('scheduler.tick', {
      type: 'scheduler.tick',
      projectId: '',
      payload: { tickType: 'issueRecovery' },
      meta: { correlationId: uuidv4(), timestamp: Date.now(), source: 'scheduler/issueRecovery' },
    });
    runIssueRecoveryScan(getDatabase(), logger);
  });

  scheduleTask('eventLogCleanup', '0 4 * * *', () => {
    const deletedCount = purgeOldEvents(30);
    if (deletedCount > 0) {
      logger.info(`Event log cleanup: deleted ${deletedCount} events older than 30 days`);
    }
  });

  scheduleTask('knowledgeExpiry', '0 * * * *', () => {
    const db = getDatabase();
    const projects = db.prepare("SELECT id FROM projects WHERE status = 'active'").all() as Array<{ id: string }>;
    let totalExpired = 0;
    for (const project of projects) {
      totalExpired += markExpiredKnowledgeEntries(db, project.id);
    }
    if (totalExpired > 0) {
      logger.info({ totalExpired }, 'knowledge.expiry.marked');
    }
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
