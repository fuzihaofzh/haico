import type { Database } from 'better-sqlite3';
import fs from 'fs';
import { getDatabase } from '../../db/database';
import { config } from '../../config';
import { getSetting } from './settings';

export interface SystemStatus {
  total_users: number;
  total_projects: number;
  running_agents: number;
  db_size: string;
  uptime: string;
  log_retention_days: number;
  event_log_enabled: boolean;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function getSystemStatus(): SystemStatus {
  const db = getDatabase();

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  const projectCount = db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number };
  const runningAgents = db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'")
    .get() as { count: number };

  // better-sqlite3 exposes the file path via the .name property
  const dbPath = (db as Database & { name?: string }).name;
  let dbSize = 'unknown';
  if (dbPath) {
    try {
      dbSize = formatBytes(fs.statSync(dbPath).size);
    } catch {
      dbSize = 'unknown';
    }
  }

  const logRetentionDays = parseInt(
    getSetting('log_retention_days', String(config.logRetentionDays)),
    10,
  );
  const eventLogEnabled =
    getSetting('event_log_enabled', config.eventLogEnabled ? 'true' : 'false') === 'true';

  return {
    total_users: userCount.count,
    total_projects: projectCount.count,
    running_agents: runningAgents.count,
    db_size: dbSize,
    uptime: formatUptime(process.uptime()),
    log_retention_days: logRetentionDays,
    event_log_enabled: eventLogEnabled,
  };
}
