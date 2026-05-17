import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDatabase } from '../../db/database';
import { getRequestUser } from '../../services/auth/request';
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
  fetchRemoteProjects,
  findRemoteInstanceById,
  requestRemoteJsonPath,
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
} from '../../services/remote-instances';

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

function prefixRemoteAgentId(instanceId: string, remoteAgentId: unknown): string {
  return `remote-agent:${instanceId}:${String(remoteAgentId || '')}`;
}

function parseRemoteAgentCompositeId(value: unknown): { instanceId: string; remoteAgentId: string } | null {
  const match = /^remote-agent:([^:]+):(.+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    instanceId: match[1],
    remoteAgentId: match[2],
  };
}

function stripRemoteAgentId(value: unknown): string {
  const parsed = parseRemoteAgentCompositeId(value);
  return parsed ? parsed.remoteAgentId : String(value || '').trim();
}

function prefixRemoteApprovalId(instanceId: string, remoteApprovalId: unknown): string {
  return `remote-approval:${instanceId}:${String(remoteApprovalId || '')}`;
}

function prefixRemoteKnowledgeId(instanceId: string, remoteKnowledgeId: unknown): string {
  return `remote-knowledge:${instanceId}:${String(remoteKnowledgeId || '')}`;
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
    source_issue_id: relation?.source_issue_id ? prefixRemoteIssueId(instance.id, relation.source_issue_id) : relation?.source_issue_id,
    target_issue_id: relation?.target_issue_id ? prefixRemoteIssueId(instance.id, relation.target_issue_id) : relation?.target_issue_id,
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
    parent_id: issue?.parent_id ? prefixRemoteIssueId(instance.id, issue.parent_id) : issue?.parent_id,
    comments: Array.isArray(issue?.comments) ? issue.comments.map((comment: any) => ({
      ...comment,
      remote_comment_id: String(comment?.id || ''),
    })) : [],
    reactions: Array.isArray(issue?.reactions) ? issue.reactions : [],
    children: Array.isArray(issue?.children) ? issue.children.map((child: any) => ({
      ...child,
      id: child?.id ? prefixRemoteIssueId(instance.id, child.id) : child?.id,
      project_id: `remote:${instance.id}:${remoteProjectId}`,
    })) : [],
    blocks: Array.isArray(issue?.blocks) ? issue.blocks.map(decorateRelation) : [],
    blocked_by: Array.isArray(issue?.blocked_by) ? issue.blocked_by.map(decorateRelation) : [],
    related_to: Array.isArray(issue?.related_to) ? issue.related_to.map(decorateRelation) : [],
  };
}

function decorateRemoteAgent(instance: RemoteInstanceRecord, remoteProjectId: string, agent: any) {
  const actualRemoteProjectId = String(agent?.project_id || remoteProjectId || '');
  const remoteAgentId = String(agent?.id || '');
  return {
    ...agent,
    id: prefixRemoteAgentId(instance.id, remoteAgentId),
    remote_agent_id: remoteAgentId,
    project_id: `remote:${instance.id}:${actualRemoteProjectId}`,
    remote_project_id: actualRemoteProjectId,
    remote_instance_id: instance.id,
    remote_instance_name: instance.name,
    is_remote: true,
    parent_agent_id: agent?.parent_agent_id ? prefixRemoteAgentId(instance.id, agent.parent_agent_id) : null,
  };
}

function decorateRemoteIssueSummary(instance: RemoteInstanceRecord, remoteProjectId: string, issue: any) {
  return decorateRemoteNotificationIssue(instance, {
    ...issue,
    project_id: remoteProjectId || issue?.project_id || '',
  });
}

function decorateRemoteApproval(instance: RemoteInstanceRecord, remoteProjectId: string, approval: any) {
  const remoteIssueId = approval?.issue_id ? String(approval.issue_id) : '';
  return {
    ...approval,
    id: prefixRemoteApprovalId(instance.id, approval?.id || ''),
    remote_approval_id: String(approval?.id || ''),
    project_id: `remote:${instance.id}:${String(remoteProjectId || approval?.project_id || '')}`,
    remote_project_id: String(remoteProjectId || approval?.project_id || ''),
    issue_id: remoteIssueId ? prefixRemoteIssueId(instance.id, remoteIssueId) : null,
    remote_issue_id: remoteIssueId || null,
    remote_instance_id: instance.id,
    is_remote: true,
  };
}

function decorateRemoteKnowledgeEntry(instance: RemoteInstanceRecord, remoteProjectId: string, entry: any) {
  return {
    ...entry,
    id: prefixRemoteKnowledgeId(instance.id, entry?.id || ''),
    remote_knowledge_id: String(entry?.id || ''),
    project_id: `remote:${instance.id}:${String(remoteProjectId || entry?.project_id || '')}`,
    remote_project_id: String(remoteProjectId || entry?.project_id || ''),
    remote_instance_id: instance.id,
    is_remote: true,
  };
}

function decorateRemoteActivityEvent(instance: RemoteInstanceRecord, remoteProjectId: string, event: any) {
  const decorated = {
    ...event,
    project_id: `remote:${instance.id}:${String(remoteProjectId || event?.project_id || '')}`,
    remote_project_id: String(remoteProjectId || event?.project_id || ''),
    remote_instance_id: instance.id,
    is_remote: true,
  };
  if (event?.event_type === 'issue' || event?.event_type === 'comment') {
    decorated.id = prefixRemoteIssueId(instance.id, event?.id || event?.issue_id || '');
  }
  if (event?.event_type === 'agent_run' && event?.object_id) {
    decorated.object_id = prefixRemoteAgentId(instance.id, event.object_id);
  }
  return decorated;
}

function decorateRemoteWorkflowStatus(instance: RemoteInstanceRecord, remoteProjectId: string, data: any) {
  return {
    ...data,
    agents: Array.isArray(data?.agents) ? data.agents.map((agent: any) => decorateRemoteAgent(instance, remoteProjectId, agent)) : [],
    recent_messages: Array.isArray(data?.recent_messages) ? data.recent_messages.map((message: any) => ({
      ...message,
      from_agent_id: message?.from_agent_id ? prefixRemoteAgentId(instance.id, message.from_agent_id) : '',
      to_agent_id: message?.to_agent_id ? prefixRemoteAgentId(instance.id, message.to_agent_id) : '',
      remote_instance_id: instance.id,
      is_remote: true,
    })) : [],
    pending_approvals: Array.isArray(data?.pending_approvals)
      ? data.pending_approvals.map((approval: any) => decorateRemoteApproval(instance, remoteProjectId, approval))
      : [],
  };
}

function buildRemoteProxyPath(pathname: string, query: Record<string, unknown> | undefined): string {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    params.set(key, normalized);
  });
  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export function registerRemoteInstanceRoutes(fastify: FastifyInstance): void {
  fastify.get('/remote-instance-options', async () => {
    const db = getDatabase();
    return {
      instances: loadRemoteInstances(db)
        .filter((instance) => instance.enabled)
        .map(serializeRemoteInstanceOption),
    };
  });

  fastify.get('/remote-instances', async (request, reply) => {
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
  }>('/remote-instances', async (request, reply) => {
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
    const saved = nextInstances[nextInstances.length - 1];
    request.log.info({
      remoteInstanceId: saved.id,
      enabled: saved.enabled,
      probeOk: probe.ok,
      projectCount: probe.projectCount,
    }, 'remote_instance.created');

    return reply.status(201).send({
      instance: serializeRemoteInstance(saved),
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
  }>('/remote-instances/:id', async (request, reply) => {
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
    request.log.info({
      remoteInstanceId: finalInstance.id,
      enabled: finalInstance.enabled,
      probeOk: probe.ok,
      projectCount: probe.projectCount,
    }, 'remote_instance.updated');

    return {
      instance: serializeRemoteInstance(finalInstance),
      probe,
    };
  });

  fastify.post<{
    Params: { id: string };
  }>('/remote-instances/:id/check', async (request, reply) => {
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
    request.log.info({
      remoteInstanceId: checked.id,
      enabled: checked.enabled,
      probeOk: probe.ok,
      projectCount: probe.projectCount,
    }, 'remote_instance.checked');

    return {
      instance: serializeRemoteInstance(checked),
      probe,
    };
  });

  fastify.delete<{
    Params: { id: string };
  }>('/remote-instances/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const nextInstances = instances.filter((instance) => instance.id !== request.params.id);
    if (nextInstances.length === instances.length) {
      return reply.status(404).send({ error: 'Remote instance not found' });
    }
    saveRemoteInstances(db, nextInstances);
    request.log.info({ remoteInstanceId: request.params.id }, 'remote_instance.deleted');
    return { ok: true };
  });

  fastify.get('/remote-projects', async () => {
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
    Params: { instanceId: string; projectId: string };
  }>('/remote-projects/:instanceId/:projectId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote project' });
    }
    const project = result.data || {};
    return {
      ...project,
      id: `remote:${instance.id}:${String(project?.id || request.params.projectId)}`,
      remote_project_id: String(project?.id || request.params.projectId),
      remote_instance_id: instance.id,
      remote_instance_name: instance.name,
      remote_base_url: instance.base_url,
      remote_url: `${instance.base_url}/projects/${encodeURIComponent(String(project?.id || request.params.projectId))}`,
      is_remote: true,
      can_manage: Boolean(project?.can_manage),
      permission_level: typeof project?.permission_level === 'string' && project.permission_level.trim()
        ? project.permission_level.trim()
        : 'remote',
      owner: project?.owner && typeof project.owner === 'object' ? project.owner : null,
    };
  });

  fastify.put<{
    Params: { instanceId: string; projectId: string };
    Body: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}`, {
      method: 'PUT',
      body: request.body || {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote project' });
    }
    return result.data || { ok: true };
  });

  fastify.delete<{
    Params: { instanceId: string; projectId: string };
  }>('/remote-projects/:instanceId/:projectId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}`, {
      method: 'DELETE',
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote project' });
    }
    return result.data || { success: true };
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
  }>('/remote-projects/:instanceId/:projectId/agents', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await requestRemoteJsonPath<any[]>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/agents`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote agents' });
    }
    return Array.isArray(result.data)
      ? result.data.map((agent) => decorateRemoteAgent(instance, request.params.projectId, agent))
      : [];
  });

  fastify.post<{
    Params: { instanceId: string; projectId: string };
    Body: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/agents', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const nextBody = {
      ...(request.body || {}),
      parent_agent_id: request.body?.parent_agent_id ? stripRemoteAgentId(request.body.parent_agent_id) : null,
    };

    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/agents`, {
      method: 'POST',
      body: nextBody,
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to create remote agent' });
    }
    return decorateRemoteAgent(instance, request.params.projectId, result.data || {});
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
  }>('/remote-projects/:instanceId/:projectId/issues/counts', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/issues/counts`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote issue counts' });
    }
    return result.data || {};
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/issues', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await requestRemoteJsonPath<any>(
      instance,
      buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/issues`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote issues' });
    }
    const payload = result.data || {};
    return {
      ...payload,
      issues: Array.isArray(payload.issues)
        ? payload.issues.map((issue: any) => decorateRemoteIssueSummary(instance, request.params.projectId, issue))
        : [],
    };
  });

  fastify.post<{
    Params: { instanceId: string; projectId: string };
    Body: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/issues', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });

    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/issues`, {
      method: 'POST',
      body: request.body || {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to create remote issue' });
    }
    return decorateRemoteIssueSummary(instance, request.params.projectId, result.data || {});
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/costs', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(
      instance,
      buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/costs`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote costs' });
    }
    return result.data || {};
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/activity', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any[]>(
      instance,
      buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/activity`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote activity' });
    }
    return Array.isArray(result.data)
      ? result.data.map((event) => decorateRemoteActivityEvent(instance, request.params.projectId, event))
      : [];
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/git-log', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any[]>(
      instance,
      buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/git-log`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote git log' });
    }
    return Array.isArray(result.data) ? result.data : [];
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/orchestration-runs', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any[]>(
      instance,
      buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/orchestration-runs`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote orchestration runs' });
    }
    return Array.isArray(result.data) ? result.data : [];
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
  }>('/remote-projects/:instanceId/:projectId/workflow-status', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/workflow-status`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote workflow status' });
    }
    return decorateRemoteWorkflowStatus(instance, request.params.projectId, result.data || {});
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/approvals', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any[]>(
      instance,
      buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/approvals`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote approvals' });
    }
    return Array.isArray(result.data)
      ? result.data.map((approval) => decorateRemoteApproval(instance, request.params.projectId, approval))
      : [];
  });

  fastify.put<{
    Params: { instanceId: string; approvalId: string };
    Body: Record<string, unknown>;
  }>('/remote-approvals/:instanceId/:approvalId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/approvals/${encodeURIComponent(request.params.approvalId)}`, {
      method: 'PUT',
      body: request.body || {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote approval' });
    }
    return result.data || { ok: true };
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
  }>('/remote-projects/:instanceId/:projectId/members', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any[]>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/members`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote members' });
    }
    return Array.isArray(result.data) ? result.data : [];
  });

  fastify.post<{
    Params: { instanceId: string; projectId: string };
    Body: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/members', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/members`, {
      method: 'POST',
      body: request.body || {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to add remote member' });
    }
    return result.data || { ok: true };
  });

  fastify.patch<{
    Params: { instanceId: string; projectId: string; userId: string };
    Body: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/members/:userId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(
      instance,
      `/api/projects/${encodeURIComponent(request.params.projectId)}/members/${encodeURIComponent(request.params.userId)}`,
      { method: 'PATCH', body: request.body || {} }
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote member' });
    }
    return result.data || { ok: true };
  });

  fastify.delete<{
    Params: { instanceId: string; projectId: string; userId: string };
  }>('/remote-projects/:instanceId/:projectId/members/:userId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(
      instance,
      `/api/projects/${encodeURIComponent(request.params.projectId)}/members/${encodeURIComponent(request.params.userId)}`,
      { method: 'DELETE' }
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to remove remote member' });
    }
    return result.data || { success: true };
  });

  fastify.get<{
    Params: { instanceId: string; projectId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/knowledge', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(
      instance,
      buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/knowledge`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote knowledge' });
    }
    const payload = result.data || {};
    return {
      ...payload,
      entries: Array.isArray(payload.entries)
        ? payload.entries.map((entry: any) => decorateRemoteKnowledgeEntry(instance, request.params.projectId, entry))
        : [],
    };
  });

  fastify.post<{
    Params: { instanceId: string; projectId: string };
    Body: Record<string, unknown>;
  }>('/remote-projects/:instanceId/:projectId/knowledge', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/knowledge`, {
      method: 'POST',
      body: request.body || {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to create remote knowledge' });
    }
    return decorateRemoteKnowledgeEntry(instance, request.params.projectId, result.data || {});
  });

  fastify.get<{
    Params: { instanceId: string; knowledgeId: string };
  }>('/remote-knowledge/:instanceId/:knowledgeId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/knowledge/${encodeURIComponent(request.params.knowledgeId)}`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote knowledge entry' });
    }
    return decorateRemoteKnowledgeEntry(instance, '', result.data || {});
  });

  fastify.put<{
    Params: { instanceId: string; knowledgeId: string };
    Body: Record<string, unknown>;
  }>('/remote-knowledge/:instanceId/:knowledgeId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/knowledge/${encodeURIComponent(request.params.knowledgeId)}`, {
      method: 'PUT',
      body: request.body || {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote knowledge entry' });
    }
    return result.data || { ok: true };
  });

  fastify.delete<{
    Params: { instanceId: string; knowledgeId: string };
  }>('/remote-knowledge/:instanceId/:knowledgeId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/knowledge/${encodeURIComponent(request.params.knowledgeId)}`, {
      method: 'DELETE',
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote knowledge entry' });
    }
    return result.data || { success: true };
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote agent' });
    }
    return decorateRemoteAgent(instance, String(result.data?.project_id || ''), result.data || {});
  });

  fastify.put<{
    Params: { instanceId: string; agentId: string };
    Body: Record<string, unknown>;
  }>('/remote-agents/:instanceId/:agentId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const nextBody = {
      ...(request.body || {}),
    };
    if (Object.prototype.hasOwnProperty.call(request.body || {}, 'parent_agent_id')) {
      nextBody.parent_agent_id = request.body?.parent_agent_id ? stripRemoteAgentId(request.body.parent_agent_id) : null;
    }

    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}`, {
      method: 'PUT',
      body: nextBody,
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote agent' });
    }
    return decorateRemoteAgent(instance, String(result.data?.project_id || ''), result.data || {});
  });

  fastify.delete<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}`, {
      method: 'DELETE',
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote agent' });
    }
    return result.data || { success: true };
  });

  fastify.post<{
    Params: { instanceId: string; agentId: string };
    Body: Record<string, unknown>;
  }>('/remote-agents/:instanceId/:agentId/start', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/start`, {
      method: 'POST',
      body: request.body || {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to start remote agent' });
    }
    return result.data || { success: true };
  });

  fastify.post<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/retry', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/retry`, {
      method: 'POST',
      body: {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to retry remote agent' });
    }
    return result.data || { success: true };
  });

  fastify.post<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/stop', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/stop`, {
      method: 'POST',
      body: {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to stop remote agent' });
    }
    return result.data || { success: true };
  });

  fastify.post<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/pause', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/pause`, {
      method: 'POST',
      body: {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to pause remote agent' });
    }
    return result.data || { success: true };
  });

  fastify.post<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/unpause', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/unpause`, {
      method: 'POST',
      body: {},
    });
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to unpause remote agent' });
    }
    return result.data || { success: true };
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/status', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/status`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote agent status' });
    }
    return result.data || {};
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/system-prompt', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/system-prompt`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote system prompt' });
    }
    return result.data || {};
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-agents/:instanceId/:agentId/logs', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any[]>(
      instance,
      buildRemoteProxyPath(`/api/agents/${encodeURIComponent(request.params.agentId)}/logs`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote logs' });
    }
    return Array.isArray(result.data) ? result.data : [];
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/costs', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/costs`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote costs' });
    }
    return result.data || {};
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string };
  }>('/remote-agents/:instanceId/:agentId/git-status', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/git-status`);
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote git status' });
    }
    return result.data || {};
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string };
    Querystring: Record<string, unknown>;
  }>('/remote-agents/:instanceId/:agentId/runs', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any[]>(
      instance,
      buildRemoteProxyPath(`/api/agents/${encodeURIComponent(request.params.agentId)}/runs`, request.query)
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote runs' });
    }
    return Array.isArray(result.data) ? result.data : [];
  });

  fastify.get<{
    Params: { instanceId: string; agentId: string; runId: string };
  }>('/remote-agents/:instanceId/:agentId/runs/:runId/report', async (request, reply) => {
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, request.params.instanceId);
    if (!instance) return reply.status(404).send({ error: 'Remote instance not found' });
    const result = await requestRemoteJsonPath<any>(
      instance,
      `/api/agents/${encodeURIComponent(request.params.agentId)}/runs/${encodeURIComponent(request.params.runId)}/report`
    );
    if (!result.ok) {
      return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote run report' });
    }
    return result.data || {};
  });

  fastify.get<{
    Querystring: {
      scope?: string;
      limit?: string;
      offset?: string;
      project_id?: string;
      since_updated_at?: string;
    };
  }>('/remote-notifications', async (request) => {
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
  }>('/remote-issues/:instanceId/:issueId', async (request, reply) => {
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
  }>('/remote-issues/:instanceId/:issueId/acknowledge', async (request, reply) => {
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
  }>('/remote-issues/:instanceId/:issueId', async (request, reply) => {
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
  }>('/remote-issues/:instanceId/:issueId', async (request, reply) => {
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
  }>('/remote-issues/:instanceId/:issueId/comments', async (request, reply) => {
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
  }>('/remote-issues/:instanceId/:issueId/comments', async (request, reply) => {
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
  }>('/remote-comments/:instanceId/:commentId', async (request, reply) => {
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
  }>('/remote-comments/:instanceId/:commentId', async (request, reply) => {
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
  }>('/remote-reactions/:instanceId/:type/:id', async (request, reply) => {
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
    Params: { instanceId: string; projectId: string; num: string };
  }>('/remote-projects/:instanceId/:projectId/issues/number/:num', async (request, reply) => {
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
  }>('/remote-issues/:instanceId/:issueId/relations', async (request, reply) => {
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
  }>('/remote-issues/:instanceId/:issueId/relations/:relationId', async (request, reply) => {
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
