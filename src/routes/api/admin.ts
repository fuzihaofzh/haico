import { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import fs from 'fs';
import { getDatabase } from '../../db/database';
import { fixZeroSessionMaxTokens, resetStaleRunningAgents, upgradeOldSessionMaxTokens } from '../../db/maintenance';
import { purgeOldEvents } from '../../events/store';
import { requireAdminRolePrehandler } from '../prehandlers';
import { config } from '../../config';

interface SystemStatusResponse {
  total_users: number;
  total_projects: number;
  running_agents: number;
  db_size: string;
  uptime: string;
  log_retention_days: number;
  event_log_enabled: boolean;
}

interface AdminSettingsUpdateBody {
  log_retention_days?: number;
  event_log_enabled?: boolean;
}

interface MaintenanceResult {
  message: string;
}

function getSetting(key: string, defaultValue: string): string {
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

function setSetting(key: string, value: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
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

export function registerAdminRoutes(fastify: FastifyInstance): void {
  fastify.register(async (adminScope) => {
    adminScope.addHook('preHandler', requireAdminRolePrehandler());

    adminScope.get('/admin/system-status', async (): Promise<SystemStatusResponse> => {
      const db = getDatabase();

      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      const projectCount = db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number };
      const runningAgents = db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'").get() as { count: number };

      // better-sqlite3 exposes the file path via the .name property
      const dbPath = (db as Database & { name?: string }).name;
      let dbSize = 'unknown';
      if (dbPath) {
        try {
          const stat = fs.statSync(dbPath);
          dbSize = formatBytes(stat.size);
        } catch {
          dbSize = 'unknown';
        }
      }

      const logRetentionDays = parseInt(getSetting('log_retention_days', String(config.logRetentionDays)), 10);
      const eventLogEnabled = getSetting('event_log_enabled', config.eventLogEnabled ? 'true' : 'false') === 'true';

      return {
        total_users: userCount.count,
        total_projects: projectCount.count,
        running_agents: runningAgents.count,
        db_size: dbSize,
        uptime: formatUptime(process.uptime()),
        log_retention_days: logRetentionDays,
        event_log_enabled: eventLogEnabled,
      };
    });

    adminScope.get('/admin/settings', async () => {
      const logRetentionDays = parseInt(getSetting('log_retention_days', String(config.logRetentionDays)), 10);
      const eventLogEnabled = getSetting('event_log_enabled', config.eventLogEnabled ? 'true' : 'false') === 'true';
      return {
        log_retention_days: logRetentionDays,
        event_log_enabled: eventLogEnabled,
      };
    });

    adminScope.put('/admin/settings', async (request, reply) => {
      const body = request.body as AdminSettingsUpdateBody;
      const results: string[] = [];

      if (body.log_retention_days !== undefined) {
        const value = Math.max(1, Math.min(365, Math.floor(body.log_retention_days)));
        setSetting('log_retention_days', String(value));
        config.logRetentionDays = value;
        results.push(`log_retention_days=${value}`);
      }

      if (body.event_log_enabled !== undefined) {
        const value = body.event_log_enabled ? 'true' : 'false';
        setSetting('event_log_enabled', value);
        config.eventLogEnabled = body.event_log_enabled;
        results.push(`event_log_enabled=${body.event_log_enabled}`);
      }

      const logRetentionDays = parseInt(getSetting('log_retention_days', String(config.logRetentionDays)), 10);
      const eventLogEnabled = getSetting('event_log_enabled', config.eventLogEnabled ? 'true' : 'false') === 'true';

      return {
        log_retention_days: logRetentionDays,
        event_log_enabled: eventLogEnabled,
        updated: results,
      };
    });

    adminScope.post('/admin/reset-stuck-agents', async (): Promise<MaintenanceResult> => {
      const db = getDatabase();
      const before = db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'").get() as { count: number };
      resetStaleRunningAgents(db);
      const after = db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'").get() as { count: number };
      const resetCount = before.count - after.count;
      return { message: resetCount > 0 ? `Reset ${resetCount} stuck agent(s) to idle.` : 'No stuck agents found.' };
    });

    adminScope.post('/admin/run-maintenance', async (): Promise<MaintenanceResult> => {
      const db = getDatabase();
      const results: string[] = [];

      // Count zero-session agents before fix
      const zeroBefore = db.prepare("SELECT COUNT(*) as count FROM agents WHERE session_max_tokens = 0").get() as { count: number };
      fixZeroSessionMaxTokens(db);
      if (zeroBefore.count > 0) results.push(`Fixed ${zeroBefore.count} agent(s) with zero session_max_tokens`);

      // Count old-session agents before upgrade
      const oldBefore = db.prepare("SELECT COUNT(*) as count FROM agents WHERE session_max_tokens = 200000").get() as { count: number };
      upgradeOldSessionMaxTokens(db);
      if (oldBefore.count > 0) results.push(`Upgraded ${oldBefore.count} agent(s) from 200k to 400k session_max_tokens`);

      // Purge old events (30 days default)
      const retentionDays = config.logRetentionDays;
      const purged = purgeOldEvents(retentionDays);
      if (purged > 0) results.push(`Purged ${purged} event(s) older than ${retentionDays} days`);

      return {
        message: results.length > 0 ? results.join('; ') + '.' : 'All maintenance tasks passed with no changes needed.',
      };
    });
  });
}
