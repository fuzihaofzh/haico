import { getDatabase } from '../../db/database';
import { config } from '../../config';

// Thin key/value store over the `settings` table. Shared by system-status
// (read for display) and the admin settings route handlers (read/write).

export function getSetting(key: string, defaultValue: string): string {
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? defaultValue;
}

export function setSetting(key: string, value: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export interface AdminSettings {
  log_retention_days: number;
  event_log_enabled: boolean;
}

export function getAdminSettings(): AdminSettings {
  const logRetentionDays = parseInt(
    getSetting('log_retention_days', String(config.logRetentionDays)),
    10,
  );
  const eventLogEnabled =
    getSetting('event_log_enabled', config.eventLogEnabled ? 'true' : 'false') === 'true';
  return { log_retention_days: logRetentionDays, event_log_enabled: eventLogEnabled };
}

/** Clamp to [1, 365], persist, and mirror into the live config. Returns the stored value. */
export function applyLogRetention(days: unknown): number {
  const value = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  setSetting('log_retention_days', String(value));
  config.logRetentionDays = value;
  return value;
}

/** Persist and mirror into the live config. Returns the stored value. */
export function applyEventLogEnabled(enabled: unknown): boolean {
  const value = String(enabled).toLowerCase() === 'true' || enabled === true;
  setSetting('event_log_enabled', value ? 'true' : 'false');
  config.eventLogEnabled = value;
  return value;
}
