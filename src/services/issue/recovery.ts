import type Database from 'better-sqlite3';
import { Agent, Project } from '../../types';
import { isAgentInCooldown, isAgentRunning } from '../process-manager';
import { triggerControllerAgent } from '../controller';
import { autoStartAgentForDispatchableIssues } from './agent-autostart';
import {
  findControllerRecoveryIssue,
  findReadyPendingIssue,
  listDispatchableIssuesForAgent,
} from './dispatch';

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

function shouldBackoffErroredWorker(
  db: Database.Database,
  project: Project,
  worker: Agent,
  log: IssueRecoveryLogger
): boolean {
  if (worker.status !== 'error') return false;

  const recentErrors = db.prepare(
    "SELECT COUNT(DISTINCT NULLIF(run_id, '')) as cnt FROM conversation_logs WHERE agent_id = ? AND stream = 'stderr' AND created_at > datetime('now', '-10 minutes')"
  ).get(worker.id) as { cnt: number };
  if (recentErrors.cnt < 3) return false;

  const lastError = db.prepare(
    "SELECT created_at FROM conversation_logs WHERE agent_id = ? AND stream = 'stderr' ORDER BY created_at DESC LIMIT 1"
  ).get(worker.id) as { created_at: string } | undefined;
  const lastErrorAge = lastError
    ? Date.now() - new Date(lastError.created_at + 'Z').getTime()
    : Infinity;

  if (lastErrorAge >= 60 * 60 * 1000) return false;

  log.debug({
    projectId: project.id,
    agentId: worker.id,
    recentErrorCount: recentErrors.cnt,
  }, 'issue.recovery.worker_autostart_skipped_error_backoff');
  return true;
}

export function runIssueRecoveryScan(
  db: Database.Database,
  log: IssueRecoveryLogger
): void {
  const projects = db.prepare("SELECT * FROM projects WHERE status = 'active'").all() as Project[];

  for (const project of projects) {
    const recoverableWorkers = db.prepare(`
      SELECT a.* FROM agents a
      WHERE a.project_id = ? AND a.is_controller = 0 AND a.status IN ('idle', 'error') AND a.paused = 0
    `).all(project.id) as Agent[];

    for (const worker of recoverableWorkers) {
      const issues = listDispatchableIssuesForAgent(db, project.id, worker.id);
      if (issues.length === 0) continue;
      if (isAgentRunning(worker.id)) continue;
      if (isAgentInCooldown(worker.id)) continue;
      if (shouldBackoffErroredWorker(db, project, worker, log)) continue;

      try {
        const result = autoStartAgentForDispatchableIssues(db, project, worker, {
          source: 'scheduler',
          allowStatuses: ['idle', 'error'],
          assignedIssues: issues,
        });

        if (result.started) {
          log.info({
            projectId: project.id,
            agentId: worker.id,
            runId: result.runId,
            currentBatchCount: result.currentBatchIssueNumbers.length,
            activeIssueCount: result.activeIssueCount,
          }, 'issue.recovery.worker_autostarted');
        } else {
          log.debug({
            projectId: project.id,
            agentId: worker.id,
            reason: result.reason,
            activeIssueCount: result.activeIssueCount,
          }, 'issue.recovery.worker_autostart_suppressed');
        }
      } catch (e) {
        log.error({ err: e, projectId: project.id, agentId: worker.id }, 'issue.recovery.worker_autostart_failed');
      }
    }

    const controllerRecovery = findControllerRecoveryIssue(db, project.id);
    if (!controllerRecovery) continue;

    try {
      triggerControllerAgent(project, false, controllerRecovery.number);
    } catch (e) {
      log.error({
        err: e,
        projectId: project.id,
        issueNumber: controllerRecovery.number,
      }, 'issue.recovery.controller_trigger_failed');
    }
  }
}
