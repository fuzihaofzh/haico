import { FastifyInstance } from 'fastify';
import { requestRemoteJsonPath } from '../../../services/remote-instances';
import { decorateRemoteKnowledgeEntry, buildRemoteProxyPath } from '../../../services/remote-instances/decorators';
import { requireRemoteInstancePrehandler } from '../../prehandlers';

export function registerRemoteKnowledgeProxyRoutes(fastify: FastifyInstance): void {
  fastify.register(async (scope) => {
    scope.addHook('preHandler', requireRemoteInstancePrehandler());

    scope.get<{
      Params: { instanceId: string; projectId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/knowledge', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
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

    scope.post<{
      Params: { instanceId: string; projectId: string };
      Body: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/knowledge', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/knowledge`, {
        method: 'POST',
        body: request.body || {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to create remote knowledge' });
      }
      return decorateRemoteKnowledgeEntry(instance, request.params.projectId, result.data || {});
    });

    scope.get<{
      Params: { instanceId: string; knowledgeId: string };
    }>('/remote-knowledge/:instanceId/:knowledgeId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/knowledge/${encodeURIComponent(request.params.knowledgeId)}`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote knowledge entry' });
      }
      return decorateRemoteKnowledgeEntry(instance, '', result.data || {});
    });

    scope.put<{
      Params: { instanceId: string; knowledgeId: string };
      Body: Record<string, unknown>;
    }>('/remote-knowledge/:instanceId/:knowledgeId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/knowledge/${encodeURIComponent(request.params.knowledgeId)}`, {
        method: 'PUT',
        body: request.body || {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote knowledge entry' });
      }
      return result.data || { ok: true };
    });

    scope.delete<{
      Params: { instanceId: string; knowledgeId: string };
    }>('/remote-knowledge/:instanceId/:knowledgeId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/knowledge/${encodeURIComponent(request.params.knowledgeId)}`, {
        method: 'DELETE',
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote knowledge entry' });
      }
      return result.data || { success: true };
    });
  });
}
