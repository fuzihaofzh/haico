import cron from 'node-cron';
import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { triggerControllerAgent } from './controller';
import { stopAgentProcess, isAgentRunning, getAgentIdleMs, DEFAULT_IDLE_TIMEOUT_MS } from './process-manager';
import { config } from '../config';
import logger from '../logger';

const scheduledTasks = new Map<string, cron.ScheduledTask>();
let logCleanupTask: cron.ScheduledTask | null = null;
let issueScanTask: cron.ScheduledTask | null = null;
let watchdogTask: cron.ScheduledTask | null = null;

export function scheduleProject(project: Project): void {
  // Remove existing schedule if any
  unscheduleProject(project.id);

  if (project.status !== 'active') return;

  const interval = project.controller_interval_min;
  if (!interval || interval <= 0) {
    logger.info(`Project "${project.name}" uses on-demand mode (interval=0), no cron scheduled`);
    return;
  }
  const cronExpr = `*/${interval} * * * *`;

  logger.info(`Scheduling project "${project.name}" every ${interval} minutes`);

  const task = cron.schedule(cronExpr, () => {
    // Re-fetch project to check current status
    const db = getDatabase();
    const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Project | undefined;
    if (current && current.status === 'active') {
      // Check schedule_hours (e.g., "9-18" means only run 9am-6pm)
      if (current.schedule_hours) {
        const now = new Date();
        const hour = now.getHours();
        const match = current.schedule_hours.match(/(\d+)\s*-\s*(\d+)/);
        if (match) {
          const start = parseInt(match[1]);
          const end = parseInt(match[2]);
          if (start <= end ? (hour < start || hour >= end) : (hour >= end && hour < start)) {
            return; // Outside schedule
          }
        }
      }

      // Wake-on-issue mode: only trigger if controller has assigned open/in_progress issues
      if (current.controller_interval_min === 0) {
        const controller = db.prepare(
          'SELECT id FROM agents WHERE project_id = ? AND is_controller = 1'
        ).get(current.id) as { id: string } | undefined;
        if (controller) {
          const hasIssues = db.prepare(
            "SELECT 1 FROM issues WHERE project_id = ? AND assigned_to = ? AND status IN ('open', 'in_progress') LIMIT 1"
          ).get(current.id, controller.id);
          if (!hasIssues) {
            // Also check for unassigned issues (controller should handle them)
            const hasUnassigned = db.prepare(
              "SELECT 1 FROM issues WHERE project_id = ? AND assigned_to IS NULL AND status IN ('open', 'in_progress') LIMIT 1"
            ).get(current.id);
            if (!hasUnassigned) {
              logger.info(`Wake-on-issue: no relevant issues for project "${current.name}", skipping controller trigger`);
              return;
            }
          }
        }
      }

      triggerControllerAgent(current);
    }
  });

  scheduledTasks.set(project.id, task);
}

export function unscheduleProject(projectId: string): void {
  const task = scheduledTasks.get(projectId);
  if (task) {
    task.stop();
    scheduledTasks.delete(projectId);
  }
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
        // Check schedule_hours
        if (project.schedule_hours) {
          const now = new Date();
          const hour = now.getHours();
          const match = project.schedule_hours.match(/(\d+)\s*-\s*(\d+)/);
          if (match) {
            const start = parseInt(match[1]);
            const end = parseInt(match[2]);
            if (start <= end ? (hour < start || hour >= end) : (hour >= end && hour < start)) {
              continue; // Outside schedule
            }
          }
        }

        // Check if there are any open/in_progress issues in this project
        const hasOpenIssues = db.prepare(
          "SELECT 1 FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress') LIMIT 1"
        ).get(project.id);

        if (!hasOpenIssues) continue;

        // Check if any idle (non-paused) worker agents have assigned open issues
        const idleWorkersWithIssues = db.prepare(`
          SELECT a.id FROM agents a
          WHERE a.project_id = ? AND a.is_controller = 0 AND a.status = 'idle' AND a.paused = 0
          AND EXISTS (
            SELECT 1 FROM issues i
            WHERE i.project_id = ? AND i.assigned_to = a.id AND i.status IN ('open', 'in_progress')
          )
          LIMIT 1
        `).get(project.id, project.id);

        // Check for unassigned open issues
        const hasUnassigned = db.prepare(
          "SELECT 1 FROM issues WHERE project_id = ? AND assigned_to IS NULL AND status IN ('open', 'in_progress') LIMIT 1"
        ).get(project.id);

        if (idleWorkersWithIssues || hasUnassigned) {
          logger.info(`Issue scan: found open issues needing attention in project "${project.name}", triggering controller`);
          triggerControllerAgent(project);
          continue; // Already triggering controller for this project
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
          logger.info(`Issue scan: stale in_progress issue #${staleIssue.number} with idle agent in project "${project.name}", re-triggering controller`);
          triggerControllerAgent(project, false, staleIssue.number);
        }
      }
    } catch (e) {
      logger.error(e, 'Issue scan failed');
    }
  });
  logger.info('Issue scan scheduled: every 1 minute');
}

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
          // Process exists in-memory — check if it's been silent too long
          const idleMs = getAgentIdleMs(agent.id);
          if (idleMs >= DEFAULT_IDLE_TIMEOUT_MS) {
            const idleMin = Math.round(idleMs / 60000);
            logger.warn(`Watchdog: agent "${agent.name}" has no output for ${idleMin} min, killing (pid=${agent.pid})`);
            db.prepare(
              "INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'stderr')"
            ).run(agent.id, '', `[Argus] Watchdog: process killed after ${idleMin} minutes with no output`);
            stopAgentProcess(agent.id);
          }
        } else {
          // DB says running but process is gone — orphaned state (e.g., Argus restarted)
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
  const db = getDatabase();
  const projects = db.prepare("SELECT * FROM projects WHERE status = 'active'").all() as Project[];

  for (const project of projects) {
    scheduleProject(project);
  }

  startLogCleanup();
  startIssueScan();
  startWatchdog();

  logger.info(`Initialized scheduler with ${projects.length} active project(s)`);
}

export function stopAllSchedulers(): void {
  for (const [id, task] of scheduledTasks) {
    task.stop();
  }
  scheduledTasks.clear();
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
  logger.info('All schedulers stopped');
}
