import { eventBus } from '../bus';
import { autoStartAgentForDispatchableIssues } from '../../services/issue/agent-autostart';
import { getDatabase } from '../../db/database';
import logger from '../../logger';
import type { TaskCompletedEvent } from '../events';

export function registerTaskSubscribers(): void {
  eventBus.subscribe('task.completed', (event) => {
    const p = event.payload as TaskCompletedEvent['payload'];
    const db = getDatabase();

    if (p.taskType === 'issue-work') {
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(p.agentId) as any;
      const project = agent ? db.prepare("SELECT * FROM projects WHERE id = ? AND status = 'active'").get(agent.project_id) as any : null;
      if (agent && project) {
        autoStartAgentForDispatchableIssues(db, project, agent, { source: 'task-completion-recovery' });
      }
    }

    if (p.taskType === 'controller' && p.status === 'completed') {
      const { runIssueRecoveryScan } = require('../../services/issue/recovery');
      runIssueRecoveryScan(db, logger);
    }
  });
}
