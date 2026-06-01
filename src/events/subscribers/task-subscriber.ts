import { eventBus } from '../bus';
import { runIssueRecoveryScan } from '../../services/issue/recovery';
import { getDatabase } from '../../db/database';
import logger from '../../logger';
import type { TaskCompletedEvent } from '../events';

export function registerTaskSubscribers(): void {
  eventBus.subscribe('task.completed', (event) => {
    const p = event.payload as TaskCompletedEvent['payload'];
    const db = getDatabase();

    if (p.taskType === 'issue-work') {
      runIssueRecoveryScan(db, logger);
    }

    if (p.taskType === 'controller' && p.status === 'completed') {
      runIssueRecoveryScan(db, logger);
    }
  });
}
