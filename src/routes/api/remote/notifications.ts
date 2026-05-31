import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../../db/database';
import { requestRemoteJsonPath } from '../../../services/remote-instances';
import { buildRemoteProxyPath } from '../../../services/remote-instances/decorators';
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
}
