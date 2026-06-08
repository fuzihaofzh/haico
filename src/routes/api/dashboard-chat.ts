import { FastifyInstance } from 'fastify';
import { getProjectRequestContext } from '../../middleware/request-context';
import type { DashboardChatInput } from '../../services/dashboard-chat';
import { runDashboardChatTurn } from '../../services/dashboard-chat';

export function registerDashboardChatRoutes(fastify: FastifyInstance): void {
  fastify.post<{ Body: DashboardChatInput }>('/dashboard-chat', async (request, reply) => {
    try {
      const userContext = getProjectRequestContext(request);
      return await runDashboardChatTurn(userContext, fastify.log, request.body || { message: '' });
    } catch (error: any) {
      const message = String(error?.message || error || 'Dashboard chat failed');
      fastify.log.error({ err: error }, 'Dashboard chat failed');
      return reply.code(200).send({
        message,
        tool_calls: [],
        error: true,
      });
    }
  });
}
