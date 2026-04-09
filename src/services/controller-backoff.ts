import { getDatabase } from '../db/database';

export type ControllerBackoffSource = 'waiting_user' | 'idle' | 'controller_error';

export interface ControllerBackoffState {
  source: ControllerBackoffSource;
  snapshot: string;
  reason: string;
  untilMs: number;
  label: string;
}

const controllerBackoffs = new Map<string, ControllerBackoffState>();

export function buildControllerActivitySnapshot(projectId: string): string {
  const db = getDatabase();

  // Structural snapshot only — NO timestamps.
  // Timestamps change on every worker action and defeat dedup/backoff.
  // We only care about structural changes: issue counts, assignment distribution, worker states.

  const issueStats = db.prepare(
    `SELECT
      COUNT(*) AS active_count,
      SUM(CASE WHEN assigned_to IS NULL OR assigned_to = 'all' THEN 1 ELSE 0 END) AS unassigned_count,
      SUM(CASE WHEN assigned_to = 'user' THEN 1 ELSE 0 END) AS user_waiting_count,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count
    FROM issues
    WHERE project_id = ? AND status IN ('open', 'in_progress')`
  ).get(projectId) as any;

  // Count pending issues with all children done (stale pending)
  const stalePendingCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM issues p
     WHERE p.project_id = ? AND p.status = 'pending'
     AND EXISTS (SELECT 1 FROM issues c WHERE c.parent_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM issues c WHERE c.parent_id = p.id AND c.status NOT IN ('done','closed'))`
  ).get(projectId) as any;

  // Count done/closed issues (structural change when issues complete)
  const doneCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM issues
     WHERE project_id = ? AND status IN ('done', 'closed')`
  ).get(projectId) as any;

  const workerStats = db.prepare(
    `SELECT
      SUM(CASE WHEN status = 'idle' AND paused = 0 THEN 1 ELSE 0 END) AS idle_count,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN status = 'error' AND paused = 0 THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN paused = 1 THEN 1 ELSE 0 END) AS paused_count
    FROM agents
    WHERE project_id = ? AND is_controller = 0`
  ).get(projectId) as any;

  // Error workers WITH active issues (the ones controller can actually help with)
  const errorWithIssues = db.prepare(
    `SELECT COUNT(*) AS cnt FROM agents a
     WHERE a.project_id = ? AND a.is_controller = 0 AND a.status = 'error' AND a.paused = 0
     AND EXISTS (
       SELECT 1 FROM issues i WHERE i.assigned_to = a.id AND i.project_id = ? AND i.status IN ('open', 'in_progress')
     )`
  ).get(projectId, projectId) as any;

  return [
    issueStats?.active_count ?? 0,
    issueStats?.unassigned_count ?? 0,
    issueStats?.user_waiting_count ?? 0,
    issueStats?.open_count ?? 0,
    issueStats?.in_progress_count ?? 0,
    stalePendingCount?.cnt ?? 0,
    doneCount?.cnt ?? 0,
    workerStats?.idle_count ?? 0,
    workerStats?.running_count ?? 0,
    workerStats?.error_count ?? 0,
    workerStats?.paused_count ?? 0,
    errorWithIssues?.cnt ?? 0,
  ].join('|');
}

export function setControllerBackoff(projectId: string, state: ControllerBackoffState): ControllerBackoffState {
  controllerBackoffs.set(projectId, state);
  return state;
}

export function applyControllerBackoff(
  projectId: string,
  input: {
    source: ControllerBackoffSource;
    snapshot: string;
    ms: number;
    reason: string;
    label?: string;
  }
): ControllerBackoffState {
  return setControllerBackoff(projectId, {
    source: input.source,
    snapshot: input.snapshot,
    reason: input.reason,
    untilMs: Date.now() + Math.max(0, input.ms),
    label: input.label || input.source,
  });
}

export function getControllerBackoff(projectId: string): ControllerBackoffState | undefined {
  const state = controllerBackoffs.get(projectId);
  if (!state) return undefined;
  if (state.untilMs <= Date.now()) {
    controllerBackoffs.delete(projectId);
    return undefined;
  }
  return state;
}

export function clearControllerBackoff(projectId: string): void {
  controllerBackoffs.delete(projectId);
}

export function getRemainingBackoffMs(projectId: string): number {
  const state = getControllerBackoff(projectId);
  return state ? Math.max(0, state.untilMs - Date.now()) : 0;
}

export function formatBackoffDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`;
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
  return `${Math.round(ms / 1000)}s`;
}
