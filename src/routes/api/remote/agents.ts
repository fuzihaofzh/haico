import { FastifyInstance } from 'fastify';
import { requestRemoteJsonPath } from '../../../services/remote-instances';
import { decorateRemoteAgent, buildRemoteProxyPath, stripRemoteAgentId } from '../../../services/remote-instances/decorators';
import { requireRemoteInstancePrehandler } from '../../prehandlers';

export function registerRemoteAgentProxyRoutes(fastify: FastifyInstance): void {
  fastify.register(async (scope) => {
    scope.addHook('preHandler', requireRemoteInstancePrehandler());

    scope.get<{
      Params: { instanceId: string; projectId: string };
    }>('/remote-projects/:instanceId/:projectId/agents', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await requestRemoteJsonPath<any[]>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/agents`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote agents' });
      }
      return Array.isArray(result.data)
        ? result.data.map((agent) => decorateRemoteAgent(instance, request.params.projectId, agent))
        : [];
    });

    scope.post<{
      Params: { instanceId: string; projectId: string };
      Body: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/agents', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

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

    scope.get<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote agent' });
      }
      return decorateRemoteAgent(instance, String(result.data?.project_id || ''), result.data || {});
    });

    scope.put<{
      Params: { instanceId: string; agentId: string };
      Body: Record<string, unknown>;
    }>('/remote-agents/:instanceId/:agentId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
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

    scope.delete<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}`, {
        method: 'DELETE',
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote agent' });
      }
      return result.data || { success: true };
    });

    scope.post<{
      Params: { instanceId: string; agentId: string };
      Body: Record<string, unknown>;
    }>('/remote-agents/:instanceId/:agentId/start', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/start`, {
        method: 'POST',
        body: request.body || {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to start remote agent' });
      }
      return result.data || { success: true };
    });

    scope.post<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/retry', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/retry`, {
        method: 'POST',
        body: {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to retry remote agent' });
      }
      return result.data || { success: true };
    });

    scope.post<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/stop', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/stop`, {
        method: 'POST',
        body: {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to stop remote agent' });
      }
      return result.data || { success: true };
    });

    scope.post<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/pause', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/pause`, {
        method: 'POST',
        body: {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to pause remote agent' });
      }
      return result.data || { success: true };
    });

    scope.post<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/unpause', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/unpause`, {
        method: 'POST',
        body: {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to unpause remote agent' });
      }
      return result.data || { success: true };
    });

    scope.get<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/status', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/status`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote agent status' });
      }
      return result.data || {};
    });

    scope.get<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/system-prompt', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/system-prompt`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote system prompt' });
      }
      return result.data || {};
    });

    scope.get<{
      Params: { instanceId: string; agentId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-agents/:instanceId/:agentId/logs', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any[]>(
        instance,
        buildRemoteProxyPath(`/api/agents/${encodeURIComponent(request.params.agentId)}/logs`, request.query)
      );
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote logs' });
      }
      return Array.isArray(result.data) ? result.data : [];
    });

    scope.get<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/costs', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/costs`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote costs' });
      }
      return result.data || {};
    });

    scope.get<{
      Params: { instanceId: string; agentId: string };
    }>('/remote-agents/:instanceId/:agentId/git-status', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/agents/${encodeURIComponent(request.params.agentId)}/git-status`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote git status' });
      }
      return result.data || {};
    });

    scope.get<{
      Params: { instanceId: string; agentId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-agents/:instanceId/:agentId/runs', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any[]>(
        instance,
        buildRemoteProxyPath(`/api/agents/${encodeURIComponent(request.params.agentId)}/runs`, request.query)
      );
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote runs' });
      }
      return Array.isArray(result.data) ? result.data : [];
    });

    scope.get<{
      Params: { instanceId: string; agentId: string; runId: string };
    }>('/remote-agents/:instanceId/:agentId/runs/:runId/report', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/agents/${encodeURIComponent(request.params.agentId)}/runs/${encodeURIComponent(request.params.runId)}/report`
      );
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote run report' });
      }
      return result.data || {};
    });
  });
}
