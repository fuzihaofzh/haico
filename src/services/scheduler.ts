import cron from 'node-cron';
import { getDatabase, isDatabaseOpen } from '../db/database';
import { Agent, Project } from '../types';
import { startAgentProcess, stopAgentProcess, isAgentRunning, getAgentIdleMs, resetAgentActivity, checkChildCpuActivity, clearCpuSnapshot, getAgentFinalResultAge, isAgentInCooldown, DEFAULT_IDLE_TIMEOUT_MS, FINAL_RESULT_KILL_DELAY_MS } from './process-manager';
import { getAgentIssueBatch, buildAssignedIssuesPrompt, markCurrentBatchInProgress } from './agent-issue-batch';
import { buildAgentWakeupSignature, getAgentWakeupDecision, recordAgentWakeup } from './agent-wakeup-guard';
import { buildSystemPrompt } from './system-prompt';
import { triggerControllerAgent } from './controller';
import { findControllerRecoveryIssue, listDispatchableIssuesForAgent } from './issue-dispatch';
import { config } from '../config';
import logger from '../logger';

let logCleanupTask: cron.ScheduledTask | null = null;
let issueScanTask: cron.ScheduledTask | null = null;
let watchdogTask: cron.ScheduledTask | null = null;
const pendingWatchdogTimers = new Set<NodeJS.Timeout>();

export function findStalePendingIssue(projectId: string): { number: number } | undefined {
  const db = getDatabase();
  return db.prepare(`
    SELECT i.number
    FROM issues i
    LEFT JOIN (
      SELECT parent_id,
             SUM(CASE WHEN status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_children
      FROM issues
      WHERE project_id = ? AND parent_id IS NOT NULL
      GROUP BY parent_id
    ) child_stats ON child_stats.parent_id = i.id
    LEFT JOIN (
      SELECT r.to_issue_id AS issue_id,
             SUM(CASE WHEN blocker.status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_blockers
      FROM issue_relations r
      JOIN issues blocker ON blocker.id = r.from_issue_id
      JOIN issues blocked ON blocked.id = r.to_issue_id
      WHERE blocked.project_id = ? AND r.relation_type = 'blocks'
      GROUP BY r.to_issue_id
    ) blocker_stats ON blocker_stats.issue_id = i.id
    WHERE i.project_id = ?
      AND i.status = 'pending'
      AND COALESCE(i.assigned_to, '') <> 'user'
      AND COALESCE(child_stats.active_children, 0) = 0
      AND COALESCE(blocker_stats.active_blockers, 0) = 0
    ORDER BY i.priority DESC, i.updated_at ASC, i.created_at ASC
    LIMIT 1
  `).get(projectId, projectId, projectId) as { number: number } | undefined;
}

function startLogCleanup(): void {
  // Run daily at 3:00 AM
  logCleanupTask = cron.schedule('0 3 * * *', () => {
    try {
      const db = getDatabase();
      const days = config.logRetentionDays;
      const result = db.prepare(
        "DELETE FROM conversation_logs WHERE created_at < datetime('now', ?)"
      ).run(`-${days} days`);
      if (result.changes > 0) {
        logger.info(`Log cleanup: deleted ${result.changes} log entries older than ${days} days`);
      }
    } catch (e) {
      logger.error(e, 'Log cleanup failed');
    }
  });
  logger.info(`Log cleanup scheduled: retain ${config.logRetentionDays} days`);
}

// Periodic recovery scan: every 3 minutes, revive idle/error workers that still have
// dispatchable issues and enqueue controller recovery for controller-owned work.
export function runIssueScanOnce(): void {
  const db = getDatabase();
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

      if (worker.status === 'error') {
        const recentErrors = db.prepare(
          "SELECT COUNT(DISTINCT NULLIF(run_id, '')) as cnt FROM conversation_logs WHERE agent_id = ? AND stream = 'stderr' AND created_at > datetime('now', '-10 minutes')"
        ).get(worker.id) as any;
        if (recentErrors.cnt >= 3) {
          const lastError = db.prepare(
            "SELECT created_at FROM conversation_logs WHERE agent_id = ? AND stream = 'stderr' ORDER BY created_at DESC LIMIT 1"
          ).get(worker.id) as any;
          const lastErrorAge = lastError ? Date.now() - new Date(lastError.created_at + 'Z').getTime() : Infinity;
          if (lastErrorAge < 60 * 60 * 1000) {
            logger.info(`Skipping auto-restart for errored agent "${worker.name}": ${recentErrors.cnt} error run(s) in last 10 min, backing off until 1h after last error`);
            continue;
          }
        }
      }

      try {
        const wakeDecision = getAgentWakeupDecision(worker, issues, {
          source: 'scheduler',
          allowStatuses: ['idle', 'error'],
        });
        if (!wakeDecision.allowed) {
          logger.info(`Issue scan: suppressed worker "${worker.name}" auto-start: ${wakeDecision.reason}`);
          continue;
        }

        const parts: string[] = [];
        if (worker.role) parts.push(`Role: ${worker.role}`);
        if (project.task_description) parts.push(`Task: ${project.task_description}`);
        const issueBatch = getAgentIssueBatch(issues);
        parts.push(buildAssignedIssuesPrompt(issueBatch));
        markCurrentBatchInProgress(db, issueBatch);

        const prompt = parts.join('\n\n');
        const commandTemplate = worker.command_template || project.command_template || config.defaultCommandTemplate;
        const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
        const systemPrompt = isRawShell ? undefined : buildSystemPrompt(worker, project);
        const recordedWakeup = buildAgentWakeupSignature(
          listDispatchableIssuesForAgent(db, project.id, worker.id)
        );

        logger.info(`Issue scan: auto-starting worker "${worker.name}" with ${issueBatch.currentBatch.length}/${issueBatch.activeIssues.length} dispatchable issue(s) for project "${project.name}"`);
        startAgentProcess(worker, prompt, commandTemplate, systemPrompt);
        recordAgentWakeup(worker.id, recordedWakeup.signature, 'scheduler', recordedWakeup.activityKey);
      } catch (e) {
        logger.error(e, `Issue scan: failed to auto-start worker "${worker.name}"`);
      }
    }

    const controllerRecovery = findControllerRecoveryIssue(db, project.id);
    if (controllerRecovery) {
      triggerControllerAgent(project, false, controllerRecovery.number);
    }
  }
}

function startIssueScan(): void {
  issueScanTask = cron.schedule('*/3 * * * *', () => {
    try {
      runIssueScanOnce();
    } catch (e) {
      logger.error(e, 'Worker scan failed');
    }
  });
  logger.info('Worker scan scheduled: every 3 minutes');
}

// hasActiveChildren removed — replaced by CPU activity detection in process-manager.ts

// Watchdog: detect agents stuck in 'running' state.
// Two checks:
// 1. Process tracked in-memory: kill if idle (no output) for > IDLE_TIMEOUT
// 2. DB says 'running' but no in-memory process: orphaned state, reset to idle
function startWatchdog(): void {
  watchdogTask = cron.schedule('*/5 * * * *', () => {
    try {
      const db = getDatabase();
      const runningAgents = db.prepare(
        "SELECT * FROM agents WHERE status = 'running'"
      ).all() as Agent[];

      for (const agent of runningAgents) {
        if (isAgentRunning(agent.id)) {
          // Check if agent already produced Final Result but process hasn't exited
          // (e.g., child curl stuck on a network request after completion)
          const finalResultAge = getAgentFinalResultAge(agent.id);
          if (finalResultAge >= FINAL_RESULT_KILL_DELAY_MS) {
            const ageMin = Math.round(finalResultAge / 60000);
            logger.warn(`Watchdog: agent "${agent.name}" produced Final Result ${ageMin} min ago but process still running, force-killing`);
            db.prepare(
              "INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'stderr')"
            ).run(agent.id, '', `[HAICO] Watchdog: process force-killed — Final Result received ${ageMin} min ago but child process stuck`);
            clearCpuSnapshot(agent.id);
            db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);
            stopAgentProcess(agent.id);
            continue;
          }

          // Process exists in-memory — check if it's been silent too long
          const idleMs = getAgentIdleMs(agent.id);
          if (idleMs >= DEFAULT_IDLE_TIMEOUT_MS) {
            // Before killing, check child process CPU activity to distinguish
            // "running a long Bash command" from "truly stuck".
            if (agent.pid) {
              const cpuStatus = checkChildCpuActivity(agent.id, agent.pid);
              if (cpuStatus === 'active') {
                logger.info(`Watchdog: agent "${agent.name}" idle for ${Math.round(idleMs / 60000)} min but child processes are CPU-active, resetting timer`);
                resetAgentActivity(agent.id);
                continue;
              }
              if (cpuStatus === 'warming') {
                logger.info(`Watchdog: agent "${agent.name}" idle for ${Math.round(idleMs / 60000)} min, child CPU unchanged but below stale threshold, waiting`);
                resetAgentActivity(agent.id);
                continue;
              }
              // cpuStatus === 'stale' or 'no_children' → proceed to kill
              if (cpuStatus === 'stale') {
                logger.warn(`Watchdog: agent "${agent.name}" child processes exist but CPU stale for multiple scans, killing`);
              }
            }
            clearCpuSnapshot(agent.id);
            const idleMin = Math.round(idleMs / 60000);
            logger.warn(`Watchdog: agent "${agent.name}" has no output for ${idleMin} min, killing (pid=${agent.pid})`);
            db.prepare(
              "INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'stderr')"
            ).run(agent.id, '', `[HAICO] Watchdog: process killed after ${idleMin} minutes with no output`);
            db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);
            stopAgentProcess(agent.id);
          }
        } else {
          // DB says running but process is gone — orphaned state (e.g., HAICO restarted)
          const startedAt = agent.started_at
            ? new Date(agent.started_at + (agent.started_at.includes('Z') ? '' : 'Z')).getTime()
            : 0;
          const runtimeMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : '?';
          logger.warn(`Watchdog: agent "${agent.name}" marked running for ${runtimeMin} min but process is gone, resetting to idle`);
          db.prepare("UPDATE agents SET status = 'idle', pid = NULL, finished_at = datetime('now') WHERE id = ?")
            .run(agent.id);
        }
      }
    } catch (e) {
      logger.error(e, 'Watchdog scan failed');
    }
  });
  logger.info(`Watchdog scheduled: every 5 minutes, idle timeout ${DEFAULT_IDLE_TIMEOUT_MS / 60000} minutes`);
}

export function initializeScheduler(): void {
  startLogCleanup();
  startIssueScan();
  startWatchdog();

  logger.info('Scheduler initialized');
}

export function stopAllSchedulers(): void {
  if (logCleanupTask) {
    logCleanupTask.stop();
    logCleanupTask = null;
  }
  if (issueScanTask) {
    issueScanTask.stop();
    issueScanTask = null;
  }
  if (watchdogTask) {
    watchdogTask.stop();
    watchdogTask = null;
  }
  // Cancel any pending watchdog setTimeout timers
  for (const timer of pendingWatchdogTimers) clearTimeout(timer);
  pendingWatchdogTimers.clear();
  logger.info('All schedulers stopped');
}
