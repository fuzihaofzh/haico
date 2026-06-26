import { getDatabase } from '../../db/database';
import {
  fixZeroSessionMaxTokens,
  resetStaleRunningAgents,
  upgradeOldSessionMaxTokens,
} from '../../db/maintenance';
import { purgeOldEvents } from '../../events/store';
import { config } from '../../config';

export interface MaintenanceResult {
  message: string;
}

export function resetStuckAgents(): MaintenanceResult {
  const db = getDatabase();
  const before = db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'")
    .get() as { count: number };
  resetStaleRunningAgents(db);
  const after = db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'")
    .get() as { count: number };
  const resetCount = before.count - after.count;
  return {
    message: resetCount > 0 ? `Reset ${resetCount} stuck agent(s) to idle.` : 'No stuck agents found.',
  };
}

export function runMaintenance(): MaintenanceResult {
  const db = getDatabase();
  const results: string[] = [];

  const zeroBefore = db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE session_max_tokens = 0")
    .get() as { count: number };
  fixZeroSessionMaxTokens(db);
  if (zeroBefore.count > 0) results.push(`Fixed ${zeroBefore.count} agent(s) with zero session_max_tokens`);

  const oldBefore = db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE session_max_tokens = 200000")
    .get() as { count: number };
  upgradeOldSessionMaxTokens(db);
  if (oldBefore.count > 0)
    results.push(`Upgraded ${oldBefore.count} agent(s) from 200k to 400k session_max_tokens`);

  const purged = purgeOldEvents(config.logRetentionDays);
  if (purged > 0) results.push(`Purged ${purged} event(s) older than ${config.logRetentionDays} days`);

  return {
    message:
      results.length > 0
        ? results.join('; ') + '.'
        : 'All maintenance tasks passed with no changes needed.',
  };
}
