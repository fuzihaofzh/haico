import Database from 'better-sqlite3';
import logger from '../logger';

/**
 * Reset any agents stuck in 'running' status from a previous crash.
 * Should run on every startup since a crash may leave agents in a stale state.
 */
export function resetStaleRunningAgents(db: Database.Database): void {
  const reset = db.prepare("UPDATE agents SET status = 'idle', pid = NULL WHERE status = 'running'");
  const changes = reset.run();
  if (changes.changes > 0) {
    logger.info(`Reset ${changes.changes} agent(s) from 'running' to 'idle' (stale from previous run)`);
  }
}

/**
 * Fix agents with session_max_tokens = 0 (should be 400000).
 * Idempotent — only updates rows that match the condition.
 */
export function fixZeroSessionMaxTokens(db: Database.Database): void {
  const updated = db.prepare("UPDATE agents SET session_max_tokens = 400000 WHERE session_max_tokens = 0").run();
  if (updated.changes > 0) {
    logger.info(`Migration: updated session_max_tokens from 0 to 400000 for ${updated.changes} agent(s)`);
  }
}

/**
 * Upgrade agents with session_max_tokens = 200000 to 400000 (cost optimization).
 * Idempotent — only updates rows that match the condition.
 */
export function upgradeOldSessionMaxTokens(db: Database.Database): void {
  const upgraded = db.prepare("UPDATE agents SET session_max_tokens = 400000 WHERE session_max_tokens = 200000").run();
  if (upgraded.changes > 0) {
    logger.info(`Migration: upgraded session_max_tokens from 200000 to 400000 for ${upgraded.changes} agent(s)`);
  }
}

export function cleanupConversationLogs(
  db: Database.Database,
  retentionDays: number
): number {
  const result = db.prepare(
    "DELETE FROM conversation_logs WHERE created_at < datetime('now', ?)"
  ).run(`-${retentionDays} days`);
  return result.changes;
}

/**
 * Run all startup maintenance tasks.
 * These are idempotent operations that should execute on every server start.
 */
export function runStartupMaintenance(db: Database.Database): void {
  fixZeroSessionMaxTokens(db);
  upgradeOldSessionMaxTokens(db);
  resetStaleRunningAgents(db);
}
