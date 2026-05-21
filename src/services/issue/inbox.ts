import Database from 'better-sqlite3';
import { ProjectRequestContext, listAccessibleProjectIds } from '../project-access';
import {
  DEFAULT_INBOX_PAGE_LIMIT,
  MAX_INBOX_PAGE_LIMIT,
  USER_RELATED_ISSUE_WHERE,
  buildSqlPlaceholders,
  parseBoundedInt,
  previewSql,
} from './utils';

export interface InboxQuery {
  scope?: string;
  limit?: unknown;
  offset?: unknown;
  project_id?: string;
  since_updated_at?: string;
}

export function getIssueNotifications(
  db: Database.Database,
  context: ProjectRequestContext,
  query: InboxQuery
): any {
  const projectIds = listAccessibleProjectIds(db, context.user);
  const limit = parseBoundedInt(query?.limit, DEFAULT_INBOX_PAGE_LIMIT, 1, MAX_INBOX_PAGE_LIMIT);
  const offset = parseBoundedInt(query?.offset, 0, 0, 100000);

  const emptyResult = {
    user_issues: [],
    recent_comments: [],
    unread_count: 0,
    pagination: { limit, offset, total: 0, has_more: false },
  };
  if (projectIds.length === 0) return emptyResult;

  const requestedProjectId = typeof query?.project_id === 'string' ? query.project_id.trim() : '';
  const visibleProjectIds = requestedProjectId
    ? (projectIds.includes(requestedProjectId) ? [requestedProjectId] : [])
    : projectIds;
  if (visibleProjectIds.length === 0) return emptyResult;

  const scope = query?.scope === 'all' ? 'all' : 'user';
  const placeholders = buildSqlPlaceholders(visibleProjectIds);
  const visibilityWhere = scope === 'all'
    ? `i.project_id IN (${placeholders})`
    : `i.project_id IN (${placeholders})
       AND ${USER_RELATED_ISSUE_WHERE}`;
  const activeInboxStatusWhere = "i.status IN ('open', 'in_progress', 'pending', 'done')";
  const baseWhere = `${visibilityWhere} AND ${activeInboxStatusWhere}`;
  const sinceUpdatedAt = typeof query?.since_updated_at === 'string' ? query.since_updated_at.trim() : '';
  const incrementalWhere = sinceUpdatedAt ? 'AND i.updated_at >= ?' : '';
  const orderBy = `CASE WHEN i.assigned_to = 'user' AND i.acknowledged_at IS NULL THEN 1 ELSE 0 END DESC,
                   i.priority DESC,
                   i.updated_at DESC,
                   i.number DESC`;

  const total = (db.prepare(
    `SELECT COUNT(*) as count FROM issues i WHERE ${baseWhere}`
  ).get(...visibleProjectIds) as any).count as number;
  const unreadCount = (db.prepare(
    `SELECT COUNT(*) as count
     FROM issues i
     WHERE ${baseWhere}
       AND i.assigned_to = 'user'
       AND i.acknowledged_at IS NULL`
  ).get(...visibleProjectIds) as any).count as number;

  const userIssues = db.prepare(
    `WITH latest_comments AS (
       SELECT issue_id,
              ${previewSql('body')} as body,
              author_id,
              ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY created_at DESC) as rn
       FROM issue_comments
       WHERE (event_type IS NULL OR event_type = 'comment')
         AND issue_id IN (SELECT id FROM issues WHERE project_id IN (${placeholders}))
     )
     SELECT i.id, i.number, i.title, ${previewSql('i.body')} as body,
            i.status, i.project_id, i.assigned_to, i.created_by, i.priority, i.updated_at, i.acknowledged_at,
            p.name as project_name, p.color as project_color,
            CASE WHEN i.assigned_to = 'user' THEN 1 ELSE 0 END as is_actionable,
            lc.body as latest_comment_body,
            lc.author_id as latest_comment_author_id,
            lca.name as latest_comment_author_name,
            aa.name as assigned_agent_name
     FROM issues i
     JOIN projects p ON i.project_id = p.id
     LEFT JOIN latest_comments lc ON lc.issue_id = i.id AND lc.rn = 1
     LEFT JOIN agents lca ON lca.id = lc.author_id
     LEFT JOIN agents aa ON aa.id = i.assigned_to
     WHERE ${baseWhere}
       ${incrementalWhere}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`
  ).all(
    ...visibleProjectIds,
    ...visibleProjectIds,
    ...(sinceUpdatedAt ? [sinceUpdatedAt] : []),
    limit,
    sinceUpdatedAt ? 0 : offset
  ) as any[];

  const issueIds = userIssues.map((issue) => issue.id);
  let recentComments: any[] = [];
  if (issueIds.length > 0) {
    const issuePlaceholders = buildSqlPlaceholders(issueIds);
    recentComments = db.prepare(
      `SELECT c.id, c.issue_id, c.author_id, ${previewSql('c.body')} as body, c.created_at,
              i.title as issue_title, i.number as issue_number, i.project_id, p.name as project_name
       FROM issue_comments c
       JOIN issues i ON c.issue_id = i.id
       JOIN projects p ON i.project_id = p.id
       WHERE c.issue_id IN (${issuePlaceholders})
         AND c.author_id != 'user'
         AND (c.event_type IS NULL OR c.event_type = 'comment')
       ORDER BY c.created_at DESC
       LIMIT 50`
    ).all(...issueIds) as any[];
  }

  const removedIssueIds = sinceUpdatedAt
    ? (db.prepare(
      `SELECT i.id
       FROM issues i
       WHERE ${visibilityWhere}
         AND i.updated_at >= ?
         AND NOT (${activeInboxStatusWhere})`
    ).all(...visibleProjectIds, sinceUpdatedAt) as any[]).map((row) => row.id)
    : [];

  return {
    user_issues: userIssues,
    recent_comments: recentComments,
    removed_issue_ids: removedIssueIds,
    unread_count: unreadCount,
    pagination: {
      limit,
      offset: sinceUpdatedAt ? 0 : offset,
      total,
      has_more: sinceUpdatedAt ? userIssues.length >= limit : offset + userIssues.length < total,
      incremental: !!sinceUpdatedAt,
    },
  };
}

export function listMyIssues(db: Database.Database, context: ProjectRequestContext): any[] {
  const projectIds = listAccessibleProjectIds(db, context.user);
  if (projectIds.length === 0) return [];

  const placeholders = buildSqlPlaceholders(projectIds);
  return db.prepare(`
    SELECT DISTINCT i.*, p.name as project_name FROM issues i
    JOIN projects p ON i.project_id = p.id
    WHERE i.project_id IN (${placeholders})
      AND ${USER_RELATED_ISSUE_WHERE}
    ORDER BY i.updated_at DESC
    LIMIT 100
  `).all(...projectIds);
}

export function searchInboxIssues(db: Database.Database, context: ProjectRequestContext, query: string): any[] {
  const q = query.trim();
  if (!q) return [];

  const projectIds = listAccessibleProjectIds(db, context.user);
  if (projectIds.length === 0) return [];

  const placeholders = buildSqlPlaceholders(projectIds);
  const like = `%${q}%`;
  return db.prepare(
    `SELECT i.*, p.name as project_name
     FROM issues i
     JOIN projects p ON i.project_id = p.id
     WHERE i.project_id IN (${placeholders})
       AND (i.title LIKE ? OR i.body LIKE ? OR CAST(i.number AS TEXT) LIKE ?)
     ORDER BY i.updated_at DESC
     LIMIT 200`
  ).all(...projectIds, like, like, like);
}
