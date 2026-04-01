import cron from 'node-cron';
import { getDatabase, isDatabaseOpen } from '../db/database';
import { Agent, Project } from '../types';
import { triggerControllerAgent } from './controller';
import { tryHandleWithoutLLM } from './pre-controller';
import { startAgentProcess, stopAgentProcess, isAgentRunning, getAgentIdleMs, resetAgentActivity, checkChildCpuActivity, clearCpuSnapshot, getAgentFinalResultAge, isAgentInCooldown, DEFAULT_IDLE_TIMEOUT_MS, FINAL_RESULT_KILL_DELAY_MS } from './process-manager';
import { getAgentIssueBatch, buildAssignedIssuesPrompt, markCurrentBatchInProgress } from './agent-issue-batch';
import { buildSystemPrompt } from './system-prompt';
import { config } from '../config';
import logger from '../logger';

let logCleanupTask: cron.ScheduledTask | null = null;
let issueScanTask: cron.ScheduledTask | null = null;
let watchdogTask: cron.ScheduledTask | null = null;
const pendingWatchdogTimers = new Set<NodeJS.Timeout>();

// Pending issues should normally be waiting on child issues or active blockers.
// If neither exists anymore, the issue is stale and needs controller review.
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

// Periodic issue scan: every minute, check all active projects for open issues
// and trigger controller if there are issues needing attention
function startIssueScan(): void {
  issueScanTask = cron.schedule('* * * * *', () => {
    try {
      const db = getDatabase();
      const projects = db.prepare("SELECT * FROM projects WHERE status = 'active'").all() as Project[];

      for (const project of projects) {
        let controllerTriggered = false;

        // Check if there are any open/in_progress issues in this project
        const hasOpenIssues = db.prepare(
          "SELECT 1 FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress') LIMIT 1"
        ).get(project.id);
        const stalePendingIssue = findStalePendingIssue(project.id);

        if (!hasOpenIssues && !stalePendingIssue) continue;

        // Directly start idle workers that have assigned open/in_progress issues
        const idleWorkersWithIssues = db.prepare(`
          SELECT a.* FROM agents a
          WHERE a.project_id = ? AND a.is_controller = 0 AND a.status = 'idle' AND a.paused = 0
          AND EXISTS (
            SELECT 1 FROM issues i
            WHERE i.project_id = ? AND i.assigned_to = a.id AND i.status IN ('open', 'in_progress')
          )
        `).all(project.id, project.id) as Agent[];

        for (const worker of idleWorkersWithIssues) {
          if (isAgentRunning(worker.id)) continue;
          // Cooldown: skip agents that just finished to avoid low-output tail restarts
          if (isAgentInCooldown(worker.id)) continue;
          // Skip agents with consecutive low-output runs (tail request avoidance)
          try {
            // Build prompt same as /api/agents/:id/start
            const parts: string[] = [];
            if (worker.role) parts.push(`Role: ${worker.role}`);
            if (project.task_description) parts.push(`Task: ${project.task_description}`);
            const issues = db.prepare(
              "SELECT * FROM issues WHERE project_id = ? AND assigned_to = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
            ).all(project.id, worker.id) as any[];
            if (issues.length > 0) {
              const issueBatch = getAgentIssueBatch(issues);
              parts.push(buildAssignedIssuesPrompt(issueBatch));
              markCurrentBatchInProgress(db, issueBatch);
            }
            const prompt = parts.join('\n\n');
            if (!prompt) continue;
            const commandTemplate = worker.command_template || project.command_template || config.defaultCommandTemplate;
            const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
            const systemPrompt = isRawShell ? undefined : buildSystemPrompt(worker, project);
            const issueBatch = getAgentIssueBatch(issues);
            logger.info(`Issue scan: auto-starting idle worker "${worker.name}" with ${issueBatch.currentBatch.length}/${issueBatch.activeIssues.length} assigned issue(s) in current batch for project "${project.name}"`);
            startAgentProcess(worker, prompt, commandTemplate, systemPrompt);
          } catch (e) {
            logger.error(e, `Issue scan: failed to auto-start worker "${worker.name}"`);
          }
        }

        // Trigger controller for unassigned issues that need controller to assign
        const needsController = db.prepare(
          `SELECT 1 FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress')
           AND (assigned_to IS NULL OR assigned_to = 'all')
           LIMIT 1`
        ).get(project.id);

        if (needsController) {
          logger.info(`Issue scan: issues needing controller attention in project "${project.name}", triggering controller`);
          triggerControllerAgent(project);
          controllerTriggered = true;
          continue;
        }

        // Check for stale in_progress issues: assigned agent is idle (not paused),
        // issue not updated for 5+ minutes. This catches cases where agent crashed
        // or controller was interrupted mid-assignment.
        // Exclude issues assigned to the controller itself to avoid self-trigger loops.
        const staleIssue = db.prepare(`
          SELECT i.number FROM issues i
          JOIN agents a ON i.assigned_to = a.id
          WHERE i.project_id = ? AND i.status = 'in_progress'
            AND a.status = 'idle' AND a.paused = 0 AND a.is_controller = 0
            AND i.updated_at < datetime('now', '-5 minutes')
          ORDER BY i.priority DESC
          LIMIT 1
        `).get(project.id) as { number: number } | undefined;

        if (staleIssue) {
          // Try pre-controller first to restart idle worker directly (avoid expensive LLM controller call)
          if (tryHandleWithoutLLM(project.id, staleIssue.number)) {
            logger.info(`Issue scan: stale issue #${staleIssue.number} handled by pre-controller (direct worker restart)`);
          } else {
            logger.info(`Issue scan: stale in_progress issue #${staleIssue.number} with idle agent in project "${project.name}", re-triggering controller`);
            triggerControllerAgent(project, false, staleIssue.number);
            controllerTriggered = true;
          }
        }

        if (stalePendingIssue && !controllerTriggered) {
          logger.info(`Issue scan: stale pending issue #${stalePendingIssue.number} in project "${project.name}", forcing controller review`);
          triggerControllerAgent(project, true, stalePendingIssue.number);
        }
      }
    } catch (e) {
      logger.error(e, 'Issue scan failed');
    }
  });
  logger.info('Issue scan scheduled: every 1 minute');
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
            ).run(agent.id, '', `[Agentopia] Watchdog: process force-killed — Final Result received ${ageMin} min ago but child process stuck`);
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
            ).run(agent.id, '', `[Agentopia] Watchdog: process killed after ${idleMin} minutes with no output`);
            db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);
            stopAgentProcess(agent.id);
          }
        } else {
          // DB says running but process is gone — orphaned state (e.g., Agentopia restarted)
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
