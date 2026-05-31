import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../../db/database';
import {
  loadRemoteInstances,
  fetchRemoteProjects,
  requestRemoteJsonPath,
  serializeRemoteInstance,
} from '../../../services/remote-instances';
import {
  decorateRemoteApproval,
  decorateRemoteActivityEvent,
  decorateRemoteWorkflowStatus,
  buildRemoteProxyPath,
} from '../../../services/remote-instances/decorators';
import { requireRemoteInstancePrehandler } from '../../prehandlers';

export function registerRemoteProjectProxyRoutes(fastify: FastifyInstance): void {
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

  fastify.register(async (scope) => {
    scope.addHook('preHandler', requireRemoteInstancePrehandler());

    scope.get<{
      Params: { instanceId: string; projectId: string };
    }>('/remote-projects/:instanceId/:projectId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

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

    scope.put<{
      Params: { instanceId: string; projectId: string };
      Body: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}`, {
        method: 'PUT',
        body: request.body || {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote project' });
      }
      return result.data || { ok: true };
    });

    scope.delete<{
      Params: { instanceId: string; projectId: string };
    }>('/remote-projects/:instanceId/:projectId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}`, {
        method: 'DELETE',
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote project' });
      }
      return result.data || { success: true };
    });

    scope.get<{
      Params: { instanceId: string; projectId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/costs', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(
        instance,
        buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/costs`, request.query)
      );
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote costs' });
      }
      return result.data || {};
    });

    scope.get<{
      Params: { instanceId: string; projectId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/activity', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
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

    scope.get<{
      Params: { instanceId: string; projectId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/git-log', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any[]>(
        instance,
        buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/git-log`, request.query)
      );
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote git log' });
      }
      return Array.isArray(result.data) ? result.data : [];
    });

    scope.get<{
      Params: { instanceId: string; projectId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/orchestration-runs', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any[]>(
        instance,
        buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/orchestration-runs`, request.query)
      );
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote orchestration runs' });
      }
      return Array.isArray(result.data) ? result.data : [];
    });

    scope.get<{
      Params: { instanceId: string; projectId: string };
    }>('/remote-projects/:instanceId/:projectId/workflow-status', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/workflow-status`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote workflow status' });
      }
      return decorateRemoteWorkflowStatus(instance, request.params.projectId, result.data || {});
    });

    scope.get<{
      Params: { instanceId: string; projectId: string };
    }>('/remote-projects/:instanceId/:projectId/members', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any[]>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/members`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote members' });
      }
      return Array.isArray(result.data) ? result.data : [];
    });

    scope.post<{
      Params: { instanceId: string; projectId: string };
      Body: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/members', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/members`, {
        method: 'POST',
        body: request.body || {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to add remote member' });
      }
      return result.data || { ok: true };
    });

    scope.patch<{
      Params: { instanceId: string; projectId: string; userId: string };
      Body: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/members/:userId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
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

    scope.delete<{
      Params: { instanceId: string; projectId: string; userId: string };
    }>('/remote-projects/:instanceId/:projectId/members/:userId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
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
  });
}
