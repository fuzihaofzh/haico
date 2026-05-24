import { getDatabase } from '../db/database';
import { deriveAgentRuntimeStatus, summarizeAgentRuntimeStates } from './tasks/runtime-state';

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

  // Count pending issues whose children/blockers are no longer active.
  const stalePendingCount = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM issues p
     LEFT JOIN (
       SELECT parent_id,
              SUM(CASE WHEN status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_children
       FROM issues
       WHERE project_id = ? AND parent_id IS NOT NULL
       GROUP BY parent_id
     ) child_stats ON child_stats.parent_id = p.id
     LEFT JOIN (
       SELECT r.to_issue_id AS issue_id,
              SUM(CASE WHEN blocker.status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_blockers
       FROM issue_relations r
       JOIN issues blocker ON blocker.id = r.from_issue_id
       JOIN issues blocked ON blocked.id = r.to_issue_id
       WHERE blocked.project_id = ? AND r.relation_type = 'blocks'
       GROUP BY r.to_issue_id
     ) blocker_stats ON blocker_stats.issue_id = p.id
     WHERE p.project_id = ? AND p.status = 'pending'
       AND COALESCE(p.assigned_to, '') <> 'user'
       AND COALESCE(child_stats.active_children, 0) = 0
       AND COALESCE(blocker_stats.active_blockers, 0) = 0`
  ).get(projectId, projectId, projectId) as any;

  // Count done/closed issues (structural change when issues complete)
  const doneCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM issues
     WHERE project_id = ? AND status IN ('done', 'closed')`
  ).get(projectId) as any;

  const workerRows = db.prepare(
    `SELECT id, paused, constraints_json
     FROM agents
     WHERE project_id = ? AND is_controller = 0`
  ).all(projectId) as Array<{ id: string; paused: number | boolean | null; constraints_json?: string | null }>;
  const workerStats = summarizeAgentRuntimeStates(db, workerRows);

  // Error workers WITH active issues (the ones controller can actually help with)
  const errorWithIssuesCount = workerRows.filter((agent) => {
    if (deriveAgentRuntimeStatus(db, agent) !== 'error') return false;
    return Boolean(db.prepare(`
      SELECT 1
      FROM issues
      WHERE assigned_to = ? AND project_id = ? AND status IN ('open', 'in_progress')
      LIMIT 1
    `).get(agent.id, projectId));
  }).length;

  return [
    issueStats?.active_count ?? 0,
    issueStats?.unassigned_count ?? 0,
    issueStats?.user_waiting_count ?? 0,
    issueStats?.open_count ?? 0,
    issueStats?.in_progress_count ?? 0,
    stalePendingCount?.cnt ?? 0,
    doneCount?.cnt ?? 0,
    workerStats.idle_count,
    workerStats.running,
    workerStats.error_count,
    workerStats.paused_count,
    errorWithIssuesCount,
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
