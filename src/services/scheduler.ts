import cron from 'node-cron';
import { getDatabase } from '../db/database';
import { Project } from '../types';
import { triggerControllerAgent } from './controller';
import { config } from '../config';
import logger from '../logger';

const scheduledTasks = new Map<string, cron.ScheduledTask>();
let logCleanupTask: cron.ScheduledTask | null = null;

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

export function initializeScheduler(): void {
  const db = getDatabase();
  const projects = db.prepare("SELECT * FROM projects WHERE status = 'active'").all() as Project[];

  for (const project of projects) {
    scheduleProject(project);
  }

  startLogCleanup();

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
  logger.info('All schedulers stopped');
}
