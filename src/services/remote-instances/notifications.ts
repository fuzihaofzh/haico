import Database from 'better-sqlite3';
import { loadRemoteInstances } from './core';
import { fetchRemoteNotifications } from './proxy';
import { parseRemoteProjectCompositeId, prefixRemoteIssueId, decorateRemoteNotificationIssue, decorateRemoteNotificationComment } from './decorators';

export interface GetRemoteNotificationsInput {
  projectId?: string;
  limit?: number;
  offset?: number;
  scope?: string;
  sinceUpdatedAt?: string;
}

export async function getRemoteNotifications(
  db: Database.Database,
  input: GetRemoteNotificationsInput
) {
  const requestedLimit = Number.isFinite(Number(input.limit)) ? Math.max(1, Math.min(input.limit!, 200)) : 20;
  const requestedOffset = Number.isFinite(Number(input.offset)) ? Math.max(0, input.offset!) : 0;
  const limit = requestedLimit;
  const offset = requestedOffset;
  const scope = input.scope === 'all' ? 'all' : 'user';
  const sinceUpdatedAt = typeof input.sinceUpdatedAt === 'string' ? input.sinceUpdatedAt.trim() : '';

  const parsedProject = input.projectId ? parseRemoteProjectCompositeId(input.projectId) : null;
  if (input.projectId && !parsedProject) {
    return {
      user_issues: [],
      recent_comments: [],
      removed_issue_ids: [],
      unread_count: 0,
      pagination: { limit, offset: 0, total: 0, has_more: false },
    };
  }

  const instances = loadRemoteInstances(db)
    .filter((instance) => instance.enabled)
    .filter((instance) => !parsedProject || instance.id === parsedProject.instanceId);

  const results = await Promise.all(
    instances.map(async (instance) => {
      const result = await fetchRemoteNotifications(instance, {
        scope,
        limit,
        offset,
        since_updated_at: sinceUpdatedAt || undefined,
        project_id: parsedProject ? parsedProject.remoteProjectId : undefined,
      });
      return { instance, result };
    })
  );

  const userIssues = results.flatMap(({ instance, result }) =>
    result.ok && Array.isArray(result.data?.user_issues)
      ? result.data!.user_issues.map((issue: any) => decorateRemoteNotificationIssue(instance, issue))
      : []
  );
  const recentComments = results.flatMap(({ instance, result }) =>
    result.ok && Array.isArray(result.data?.recent_comments)
      ? result.data!.recent_comments.map((comment: any) => decorateRemoteNotificationComment(instance, comment))
      : []
  );
  const removedIssueIds = results.flatMap(({ instance, result }) =>
    result.ok && Array.isArray(result.data?.removed_issue_ids)
      ? result.data!.removed_issue_ids.map((remoteIssueId: string) => prefixRemoteIssueId(instance.id, remoteIssueId))
      : []
  );
  const unreadCount = results.reduce((sum, { result }) =>
    sum + (result.ok ? Number(result.data?.unread_count || 0) : 0), 0
  );
  const total = results.reduce((sum, { result }) =>
    sum + (result.ok ? Number(result.data?.pagination?.total || result.data?.user_issues?.length || 0) : 0), 0
  );

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
