import type Database from 'better-sqlite3';
import { Issue } from '../../types';

function readyPendingFromClause(): string {
  return `
    LEFT JOIN (
      SELECT parent_id,
             SUM(CASE WHEN status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_children
      FROM issues
      WHERE project_id = ? AND parent_id IS NOT NULL
      GROUP BY parent_id
    ) child_stats ON child_stats.parent_id = i.id
    LEFT JOIN (
      SELECT r.to_issue_id AS issue_id,
             SUM(CASE WHEN blocker.status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_blockers
      FROM issue_relations r
      JOIN issues blocker ON blocker.id = r.from_issue_id
      JOIN issues blocked ON blocked.id = r.to_issue_id
      WHERE blocked.project_id = ? AND r.relation_type = 'blocks'
      GROUP BY r.to_issue_id
    ) blocker_stats ON blocker_stats.issue_id = i.id
  `;
}

function readyPendingPredicate(): string {
  return `
    i.status = 'pending'
    AND COALESCE(i.assigned_to, '') <> 'user'
    AND COALESCE(child_stats.active_children, 0) = 0
    AND COALESCE(blocker_stats.active_blockers, 0) = 0
  `;
}

export function getPendingDependencyState(
  db: Database.Database,
  projectId: string,
  issueId: string
): { activeChildren: number; activeBlockers: number } {
  const row = db.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM issues child
        WHERE child.project_id = ? AND child.parent_id = ? AND child.status NOT IN ('done', 'closed')
      ) AS active_children,
      (
        SELECT COUNT(*)
        FROM issue_relations r
        JOIN issues blocker ON blocker.id = r.from_issue_id
        JOIN issues blocked ON blocked.id = r.to_issue_id
        WHERE blocked.project_id = ?
          AND r.to_issue_id = ?
          AND r.relation_type = 'blocks'
          AND blocker.status NOT IN ('done', 'closed')
      ) AS active_blockers
  `).get(projectId, issueId, projectId, issueId) as { active_children: number; active_blockers: number } | undefined;

  return {
    activeChildren: row?.active_children ?? 0,
    activeBlockers: row?.active_blockers ?? 0,
  };
}

export function listDispatchableIssuesForAgent(
  db: Database.Database,
  projectId: string,
  agentId: string
): Issue[] {
  return db.prepare(`
    SELECT i.*
    FROM issues i
    ${readyPendingFromClause()}
    WHERE i.project_id = ?
      AND i.assigned_to = ?
      AND (
        i.status IN ('open', 'in_progress')
        OR (${readyPendingPredicate()})
      )
    ORDER BY i.priority DESC, i.created_at, i.number
  `).all(projectId, projectId, projectId, agentId) as Issue[];
}

export function listOrchestrationIssues(
  db: Database.Database,
  projectId: string,
  triggerIssueNumber?: number
): Issue[] {
  if (triggerIssueNumber !== undefined) {
    return db.prepare(`
      SELECT i.*
      FROM issues i
      ${readyPendingFromClause()}
      WHERE i.project_id = ?
        AND i.number = ?
        AND (
          i.status IN ('open', 'in_progress')
          OR (${readyPendingPredicate()})
        )
      ORDER BY i.priority DESC, i.created_at, i.number
    `).all(projectId, projectId, projectId, triggerIssueNumber) as Issue[];
  }

  return db.prepare(`
    SELECT i.*
    FROM issues i
    ${readyPendingFromClause()}
    WHERE i.project_id = ?
      AND (
        i.status IN ('open', 'in_progress')
        OR (${readyPendingPredicate()})
      )
    ORDER BY i.priority DESC, i.created_at, i.number
  `).all(projectId, projectId, projectId) as Issue[];
}

export function findControllerRecoveryIssue(
  db: Database.Database,
  projectId: string
): { number: number } | undefined {
  return db.prepare(`
    SELECT i.number
    FROM issues i
    ${readyPendingFromClause()}
    WHERE i.project_id = ?
      AND (
        (
          i.status IN ('open', 'in_progress')
          AND (
            i.assigned_to IS NULL
            OR i.assigned_to = 'all'
            OR i.assigned_to IN (
              SELECT id FROM agents WHERE project_id = ? AND is_controller = 1
            )
          )
        )
        OR (
          (${readyPendingPredicate()})
          AND (
            i.assigned_to IS NULL
            OR i.assigned_to = 'all'
            OR i.assigned_to IN (
              SELECT id FROM agents WHERE project_id = ? AND is_controller = 1
            )
          )
        )
      )
    ORDER BY i.priority DESC, i.updated_at ASC, i.created_at ASC
    LIMIT 1
  `).get(projectId, projectId, projectId, projectId, projectId) as { number: number } | undefined;
}

export function findReadyPendingIssue(
  db: Database.Database,
  projectId: string
): { number: number } | undefined {
  return db.prepare(`
    SELECT i.number
    FROM issues i
    ${readyPendingFromClause()}
    WHERE i.project_id = ?
      AND (${readyPendingPredicate()})
    ORDER BY i.priority DESC, i.updated_at ASC, i.created_at ASC
    LIMIT 1
  `).get(projectId, projectId, projectId) as { number: number } | undefined;
}
