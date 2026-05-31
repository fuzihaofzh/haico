import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../../db/database';
import { requestRemoteJsonPath } from '../../../services/remote-instances';
import { decorateRemoteApproval, buildRemoteProxyPath } from '../../../services/remote-instances/decorators';
import { getRemoteNotifications } from '../../../services/remote-instances/notifications';
import { requireRemoteInstancePrehandler } from '../../prehandlers';

export function registerRemoteNotificationRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Querystring: {
      project_id?: string;
      limit?: string;
      offset?: string;
      since_updated_at?: string;
    };
  }>('/remote-notifications', async (request) => {
    const db = getDatabase();
    return getRemoteNotifications(db, {
      projectId: typeof request.query?.project_id === 'string' ? request.query.project_id.trim() : undefined,
      limit: Number.parseInt(String(request.query?.limit || '20'), 10),
      offset: Number.parseInt(String(request.query?.offset || '0'), 10),
      sinceUpdatedAt: typeof request.query?.since_updated_at === 'string' ? request.query.since_updated_at.trim() : '',
    });
  });

  fastify.register(async (scope) => {
    scope.addHook('preHandler', requireRemoteInstancePrehandler());

    scope.get<{
      Params: { instanceId: string; projectId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/approvals', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
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

    scope.put<{
      Params: { instanceId: string; approvalId: string };
      Body: Record<string, unknown>;
    }>('/remote-approvals/:instanceId/:approvalId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;
      const result = await requestRemoteJsonPath<any>(instance, `/api/approvals/${encodeURIComponent(request.params.approvalId)}`, {
        method: 'PUT',
        body: request.body || {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote approval' });
      }
      return result.data || { ok: true };
    });
  });
}
