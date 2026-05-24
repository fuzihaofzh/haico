import type Database from 'better-sqlite3';
import { findReadyPendingIssue } from './dispatch';
import { autoStartAgentForDispatchableIssues } from './agent-autostart';
import { triggerControllerOnDemand } from './automation';
import { Agent, Project } from '../../types';

type LogMethod = {
  (message: string, ...args: unknown[]): void;
  (payload: unknown, message?: string, ...args: unknown[]): void;
};

export interface IssueRecoveryLogger {
  debug: LogMethod;
  info: LogMethod;
  error: LogMethod;
}

export function findStalePendingIssue(
  db: Database.Database,
  projectId: string
): { number: number } | undefined {
  return findReadyPendingIssue(db, projectId);
}

export function runIssueRecoveryScan(
  db: Database.Database,
  log: IssueRecoveryLogger
): void {
  const projects = db.prepare("SELECT * FROM projects WHERE status = 'active'").all() as Project[];
  let queuedCount = 0;

  for (const project of projects) {
    const agents = db.prepare(
      'SELECT * FROM agents WHERE project_id = ? AND is_controller = 0'
    ).all(project.id) as Agent[];

    for (const agent of agents) {
      const result = autoStartAgentForDispatchableIssues(db, project, agent, { source: 'issue-recovery' });
      if (result.started) queuedCount += 1;
    }

    const readyPending = findStalePendingIssue(db, project.id);
    if (readyPending) {
      triggerControllerOnDemand(db, project.id, readyPending.number, 'system', {
        reason: 'issue-recovery-ready-pending',
        forceUrgent: true,
      });
      queuedCount += 1;
    }
  }

  if (queuedCount > 0) {
    log.info({ queuedCount }, 'issue.recovery.task_producers_queued');
  }
}
