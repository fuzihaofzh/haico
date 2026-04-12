import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDatabase } from '../db/database';
import { getRequestUser } from '../middleware/auth';
import {
  acknowledgeRemoteIssue,
  addRemoteIssueRelation,
  authenticateRemoteInstance,
  applyProbeToRemoteInstance,
  createRemoteIssueComment,
  deleteRemoteComment,
  deleteRemoteIssue,
  fetchRemoteIssue,
  fetchRemoteIssueComments,
  fetchRemoteNotifications,
  fetchRemoteProjectAgents,
  fetchRemoteProjects,
  findRemoteInstanceById,
  removeRemoteIssueRelation,
  resolveRemoteIssueByNumber,
  serializeRemoteInstanceOption,
  toggleRemoteReaction,
  updateRemoteComment,
  updateRemoteIssue,
  loadRemoteInstances,
  normalizeRemoteInstanceBaseUrl,
  normalizeRemoteInstanceName,
  probeRemoteInstance,
  RemoteInstanceRecord,
  saveRemoteInstances,
  serializeRemoteInstance,
} from '../services/remote-instances';

function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = getRequestUser(request);
  if (!user || user.role !== 'admin') {
    reply.status(403).send({ error: 'Admin access required' });
    return null;
  }
  return user;
}

function normalizeRemoteApiToken(value: unknown): string {
  return String(value || '').trim();
}

function parseRemoteProjectCompositeId(value: unknown): { instanceId: string; remoteProjectId: string } | null {
  const match = /^remote:([^:]+):(.+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    instanceId: match[1],
    remoteProjectId: match[2],
  };
}

function prefixRemoteIssueId(instanceId: string, remoteIssueId: unknown): string {
  return `remote-issue:${instanceId}:${String(remoteIssueId || '')}`;
}

function prefixRemoteCommentId(instanceId: string, remoteCommentId: unknown): string {
  return `remote-comment:${instanceId}:${String(remoteCommentId || '')}`;
}

function parseRemoteIssueCompositeId(value: unknown): { instanceId: string; remoteIssueId: string } | null {
  const match = /^remote-issue:([^:]+):(.+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    instanceId: match[1],
    remoteIssueId: match[2],
  };
}

function stripRemoteIssueId(value: unknown): string {
  const parsed = parseRemoteIssueCompositeId(value);
  return parsed ? parsed.remoteIssueId : String(value || '').trim();
}

function decorateRemoteNotificationIssue(instance: RemoteInstanceRecord, issue: any) {
  const remoteIssueId = String(issue?.id || '');
  const remoteProjectId = String(issue?.project_id || '');
  return {
    ...issue,
    id: prefixRemoteIssueId(instance.id, remoteIssueId),
    remote_issue_id: remoteIssueId,
    project_id: `remote:${instance.id}:${remoteProjectId}`,
    remote_project_id: remoteProjectId,
    remote_instance_id: instance.id,
    remote_instance_name: instance.name,
    remote_base_url: instance.base_url,
    remote_project_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}`,
    remote_issue_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}/issues/${encodeURIComponent(issue?.number || '')}`,
    is_remote: true,
    project_name: String(issue?.project_name || instance.name),
  };
}

function decorateRemoteNotificationComment(instance: RemoteInstanceRecord, comment: any) {
  return {
    ...comment,
    id: prefixRemoteCommentId(instance.id, comment?.id || ''),
    remote_comment_id: String(comment?.id || ''),
    issue_id: prefixRemoteIssueId(instance.id, comment?.issue_id || ''),
    remote_issue_id: String(comment?.issue_id || ''),
    project_id: comment?.project_id ? `remote:${instance.id}:${String(comment.project_id)}` : '',
    remote_project_id: String(comment?.project_id || ''),
    remote_instance_id: instance.id,
    is_remote: true,
  };
}

function decorateRemoteIssueDetail(instance: RemoteInstanceRecord, issue: any) {
  const remoteIssueId = String(issue?.id || '');
  const remoteProjectId = String(issue?.project_id || '');
  const decorateRelation = (relation: any) => ({
    ...relation,
    project_id: `remote:${instance.id}:${remoteProjectId}`,
  });
  return {
    ...issue,
    id: prefixRemoteIssueId(instance.id, remoteIssueId),
    remote_issue_id: remoteIssueId,
    project_id: `remote:${instance.id}:${remoteProjectId}`,
    remote_project_id: remoteProjectId,
    remote_instance_id: instance.id,
    remote_instance_name: instance.name,
    remote_base_url: instance.base_url,
    remote_project_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}`,
    remote_issue_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}/issues/${encodeURIComponent(issue?.number || '')}`,
    is_remote: true,
    comments: Array.isArray(issue?.comments) ? issue.comments.map((comment: any) => ({
      ...comment,
      remote_comment_id: String(comment?.id || ''),
    })) : [],
    reactions: Array.isArray(issue?.reactions) ? issue.reactions : [],
    children: Array.isArray(issue?.children) ? issue.children.map((child: any) => ({
      ...child,
      project_id: `remote:${instance.id}:${remoteProjectId}`,
    })) : [],
    blocks: Array.isArray(issue?.blocks) ? issue.blocks.map(decorateRelation) : [],
    blocked_by: Array.isArray(issue?.blocked_by) ? issue.blocked_by.map(decorateRelation) : [],
    related_to: Array.isArray(issue?.related_to) ? issue.related_to.map(decorateRelation) : [],
  };
}

export function registerRemoteInstanceRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/remote-instance-options', async () => {
    const db = getDatabase();
    return {
      instances: loadRemoteInstances(db)
        .filter((instance) => instance.enabled)
        .map(serializeRemoteInstanceOption),
    };
  });

  fastify.get('/api/remote-instances', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const db = getDatabase();
    return {
      instances: loadRemoteInstances(db).map(serializeRemoteInstance),
    };
  });

  fastify.post<{
    Body: {
      name?: string;
      base_url?: string;
      api_token?: string;
      remote_username?: string;
      remote_password?: string;
      enabled?: boolean;
    };
  }>('/api/remote-instances', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const name = normalizeRemoteInstanceName(request.body?.name);
    const apiToken = normalizeRemoteApiToken(request.body?.api_token);
    const remoteUsername = normalizeRemoteInstanceName(request.body?.remote_username);
    const remotePassword = normalizeRemoteApiToken(request.body?.remote_password);
    let baseUrl = '';

    try {
      baseUrl = normalizeRemoteInstanceBaseUrl(request.body?.base_url);
    } catch (error: any) {
      return reply.status(400).send({ error: error?.message || 'Invalid remote instance URL' });
    }

    if (!name) return reply.status(400).send({ error: 'name is required' });
    if (!baseUrl) return reply.status(400).send({ error: 'base_url is required' });

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    if (instances.some((instance) => instance.base_url === baseUrl)) {
      return reply.status(409).send({ error: 'A remote instance with this URL already exists' });
    }

    const now = new Date().toISOString();
    let resolvedToken = apiToken;
    if (remotePassword) {
      try {
        const auth = await authenticateRemoteInstance({
          baseUrl,
          username: remoteUsername || undefined,
          password: remotePassword,
        });
        resolvedToken = auth.token;
      } catch (error: any) {
        return reply.status(400).send({ error: error?.message || 'Failed to log into remote instance' });
      }
    }

    const candidate: RemoteInstanceRecord = {
      id: randomUUID(),
      name,
      base_url: baseUrl,
      api_token: resolvedToken,
      enabled: request.body?.enabled !== false,
      created_at: now,
      updated_at: now,
      last_checked_at: null,
      last_status: 'unknown',
      last_error: '',
    };
    const probe = await probeRemoteInstance(candidate);
    const nextInstances = instances.concat(applyProbeToRemoteInstance(candidate, probe));
    saveRemoteInstances(db, nextInstances);

    return reply.status(201).send({
      instance: serializeRemoteInstance(nextInstances[nextInstances.length - 1]),
      probe,
    });
  });

  fastify.put<{
    Params: { id: string };
    Body: {
      name?: string;
      base_url?: string;
      api_token?: string;
      remote_username?: string;
      remote_password?: string;
      enabled?: boolean;
    };
  }>('/api/remote-instances/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const existing = instances.find((instance) => instance.id === request.params.id);
    if (!existing) return reply.status(404).send({ error: 'Remote instance not found' });

    const hasName = Object.prototype.hasOwnProperty.call(request.body || {}, 'name');
    const hasBaseUrl = Object.prototype.hasOwnProperty.call(request.body || {}, 'base_url');
    const hasApiToken = Object.prototype.hasOwnProperty.call(request.body || {}, 'api_token');
    const hasRemoteUsername = Object.prototype.hasOwnProperty.call(request.body || {}, 'remote_username');
    const hasRemotePassword = Object.prototype.hasOwnProperty.call(request.body || {}, 'remote_password');
    const hasEnabled = Object.prototype.hasOwnProperty.call(request.body || {}, 'enabled');

    const name = hasName ? normalizeRemoteInstanceName(request.body?.name) : existing.name;
    const apiToken = hasApiToken ? normalizeRemoteApiToken(request.body?.api_token) : existing.api_token;
    const enabled = hasEnabled ? request.body?.enabled !== false : existing.enabled;
    const remoteUsername = hasRemoteUsername ? normalizeRemoteInstanceName(request.body?.remote_username) : '';
    const remotePassword = hasRemotePassword ? normalizeRemoteApiToken(request.body?.remote_password) : '';
    let baseUrl = existing.base_url;

    if (hasBaseUrl) {
      try {
        baseUrl = normalizeRemoteInstanceBaseUrl(request.body?.base_url);
      } catch (error: any) {
        return reply.status(400).send({ error: error?.message || 'Invalid remote instance URL' });
      }
    }

    if (!name) return reply.status(400).send({ error: 'name is required' });
    if (!baseUrl) return reply.status(400).send({ error: 'base_url is required' });
    if (instances.some((instance) => instance.id !== existing.id && instance.base_url === baseUrl)) {
      return reply.status(409).send({ error: 'A remote instance with this URL already exists' });
    }

    let resolvedToken = apiToken;
    if (remotePassword) {
      try {
        const auth = await authenticateRemoteInstance({
          baseUrl,
          username: remoteUsername || undefined,
          password: remotePassword,
        });
        resolvedToken = auth.token;
      } catch (error: any) {
        return reply.status(400).send({ error: error?.message || 'Failed to log into remote instance' });
      }
    }

    const updated: RemoteInstanceRecord = {
      ...existing,
      name,
      base_url: baseUrl,
      api_token: resolvedToken,
      enabled,
      updated_at: new Date().toISOString(),
    };
    const probe = await probeRemoteInstance(updated);
    const finalInstance = applyProbeToRemoteInstance(updated, probe);
    saveRemoteInstances(
      db,
      instances.map((instance) => (instance.id === existing.id ? finalInstance : instance))
    );

    return {
      instance: serializeRemoteInstance(finalInstance),
      probe,
    };
  });

  fastify.post<{
    Params: { id: string };
  }>('/api/remote-instances/:id/check', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const existing = instances.find((instance) => instance.id === request.params.id);
    if (!existing) return reply.status(404).send({ error: 'Remote instance not found' });

    const probe = await probeRemoteInstance(existing);
    const checked = applyProbeToRemoteInstance(existing, probe);
    saveRemoteInstances(
      db,
      instances.map((instance) => (instance.id === existing.id ? checked : instance))
    );

    return {
      instance: serializeRemoteInstance(checked),
      probe,
    };
  });

  fastify.delete<{
    Params: { id: string };
  }>('/api/remote-instances/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const nextInstances = instances.filter((instance) => instance.id !== request.params.id);
    if (nextInstances.length === instances.length) {
      return reply.status(404).send({ error: 'Remote instance not found' });
    }
    saveRemoteInstances(db, nextInstances);
    return { ok: true };
  });

  fastify.get('/api/remote-projects', async () => {
    const db = getDatabase();
    const instances = loadRemoteInstances(db).filter((instance) => instance.enabled);
    const results = await Promise.all(
      instances.map(async (instance) => {
        const result = await fetchRemoteProjects(instance);
        return {
          instance: {
            ...serializeRemoteInstance(instance),
            runtime_status: result.status,
            runtime_error: result.error,
            project_count: result.projects.length,
          },
          projects: result.projects,
        };
      })
    );

    return {
      instances: results.map((result) => result.instance),
      projects: results.flatMap((result) => result.projects),
    };
  });

  fastify.get<{
    Querystring: {
      scope?: string;
      limit?: string;
      offset?: string;
      project_id?: string;
      since_updated_at?: string;
    };
  }>('/api/remote-notifications', async (request) => {
    const db = getDatabase();
    const requestedProjectId = typeof request.query?.project_id === 'string' ? request.query.project_id.trim() : '';
    const requestedLimit = Number.parseInt(String(request.query?.limit || '20'), 10);
    const requestedOffset = Number.parseInt(String(request.query?.offset || '0'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 20;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
    const scope = request.query?.scope === 'all' ? 'all' : 'user';
    const sinceUpdatedAt = typeof request.query?.since_updated_at === 'string' ? request.query.since_updated_at.trim() : '';

    const parsedProject = requestedProjectId ? parseRemoteProjectCompositeId(requestedProjectId) : null;
    if (requestedProjectId && !parsedProject) {
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
        ? result.data!.user_issues.map((issue) => decorateRemoteNotificationIssue(instance, issue))
        : []
    );
    const recentComments = results.flatMap(({ instance, result }) =>
      result.ok && Array.isArray(result.data?.recent_comments)
        ? result.data!.recent_comments.map((comment) => decorateRemoteNotificationComment(instance, comment))
        : []
    );
    const removedIssueIds = results.flatMap(({ instance, result }) =>
      result.ok && Array.isArray(result.data?.removed_issue_ids)
        ? result.data!.removed_issue_ids.map((remoteIssueId) => prefixRemoteIssueId(instance.id, remoteIssueId))
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
  });

  fastify.get<{
    Params: { instanceId: string; issueId: string };
  }>('/api/remote-issues/:instanceId/:issueId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await fetchRemoteIssue(instance, request.params.issueId);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote issue' });
    }
    return decorateRemoteIssueDetail(instance, result.data || {});
  });

  fastify.post<{
    Params: { instanceId: string; issueId: string };
  }>('/api/remote-issues/:instanceId/:issueId/acknowledge', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await acknowledgeRemoteIssue(instance, request.params.issueId);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to acknowledge remote issue' });
    }
    return result.data || { ok: true };
  });

  fastify.put<{
    Params: { instanceId: string; issueId: string };
    Body: Record<string, unknown>;
  }>('/api/remote-issues/:instanceId/:issueId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await updateRemoteIssue(instance, request.params.issueId, request.body || {});
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote issue' });
    }
    return result.data || { ok: true };
  });

  fastify.delete<{
    Params: { instanceId: string; issueId: string };
  }>('/api/remote-issues/:instanceId/:issueId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await deleteRemoteIssue(instance, request.params.issueId);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote issue' });
    }
    return result.data || { success: true };
  });

  fastify.get<{
    Params: { instanceId: string; issueId: string };
    Querystring: { since_created_at?: string };
  }>('/api/remote-issues/:instanceId/:issueId/comments', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await fetchRemoteIssueComments(instance, request.params.issueId, {
      since_created_at: typeof request.query?.since_created_at === 'string' ? request.query.since_created_at.trim() : '',
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote comments' });
    }
    return Array.isArray(result.data)
      ? result.data.map((comment) => ({
          ...comment,
          remote_comment_id: String(comment?.id || ''),
        }))
      : [];
  });

  fastify.post<{
    Params: { instanceId: string; issueId: string };
    Body: { author_id: string; body: string };
  }>('/api/remote-issues/:instanceId/:issueId/comments', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await createRemoteIssueComment(instance, request.params.issueId, request.body);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to add remote comment' });
    }
    return result.data ? {
      ...result.data,
      remote_comment_id: String((result.data as any)?.id || ''),
    } : { ok: true };
  });

  fastify.put<{
    Params: { instanceId: string; commentId: string };
    Body: { body: string };
  }>('/api/remote-comments/:instanceId/:commentId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await updateRemoteComment(instance, request.params.commentId, request.body);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote comment' });
    }
    return result.data || { ok: true };
  });

  fastify.delete<{
    Params: { instanceId: string; commentId: string };
  }>('/api/remote-comments/:instanceId/:commentId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await deleteRemoteComment(instance, request.params.commentId);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote comment' });
    }
    return result.data || { success: true };
  });

  fastify.post<{
    Params: { instanceId: string; type: string; id: string };
    Body: { user_id: string; emoji: string };
  }>('/api/remote-reactions/:instanceId/:type/:id', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await toggleRemoteReaction(instance, request.params.type, request.params.id, request.body);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote reaction' });
    }
    return result.data || { ok: true };
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
  }>('/api/remote-projects/:instanceId/:projectId/agents', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await fetchRemoteProjectAgents(instance, request.params.projectId);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote agents' });
    }
    return Array.isArray(result.data) ? result.data : [];
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string; num: string };
  }>('/api/remote-projects/:instanceId/:projectId/issues/number/:num', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await resolveRemoteIssueByNumber(instance, request.params.projectId, request.params.num);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to resolve remote issue' });
    }
    return decorateRemoteIssueDetail(instance, result.data || {});
  });

  fastify.post<{
    Params: { instanceId: string; issueId: string };
    Body: { type: string; target_issue_id: string; actor?: string };
  }>('/api/remote-issues/:instanceId/:issueId/relations', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await addRemoteIssueRelation(instance, request.params.issueId, {
      ...request.body,
      target_issue_id: stripRemoteIssueId(request.body?.target_issue_id),
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to add remote relation' });
    }
    return result.data || { ok: true };
  });

  fastify.delete<{
    Params: { instanceId: string; issueId: string; relationId: string };
  }>('/api/remote-issues/:instanceId/:issueId/relations/:relationId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await removeRemoteIssueRelation(instance, request.params.issueId, request.params.relationId);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote relation' });
    }
    return result.data || { success: true };
  });
}
