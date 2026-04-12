import { FastifyInstance } from 'fastify';
import { DashboardChatInput, runDashboardChatTurn } from '../services/dashboard-chat';

export function registerDashboardChatRoutes(fastify: FastifyInstance): void {
  fastify.post<{ Body: DashboardChatInput }>('/api/dashboard-chat', async (request, reply) => {
    try {
      return await runDashboardChatTurn(fastify, request, request.body || { message: '' });
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
