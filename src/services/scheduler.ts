import cron from 'node-cron';
import { getDatabase } from '../db/database';
import { Project } from '../types';
import { triggerControllerAgent } from './controller';
import logger from '../logger';

const scheduledTasks = new Map<string, cron.ScheduledTask>();

export function scheduleProject(project: Project): void {
  // Remove existing schedule if any
  unscheduleProject(project.id);

  if (project.status !== 'active') return;

  const interval = project.controller_interval_min || 5;
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

export function initializeScheduler(): void {
  const db = getDatabase();
  const projects = db.prepare("SELECT * FROM projects WHERE status = 'active'").all() as Project[];

  for (const project of projects) {
    scheduleProject(project);
  }

  logger.info(`Initialized scheduler with ${projects.length} active project(s)`);
}

export function stopAllSchedulers(): void {
  for (const [id, task] of scheduledTasks) {
    task.stop();
  }
  scheduledTasks.clear();
  logger.info('All schedulers stopped');
}
