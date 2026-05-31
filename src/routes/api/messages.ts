import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { assertSendAgentMessageInput, listAgentInboxMessages, listAgentSentMessages, markAgentMessageRead, markAllAgentMessagesRead, sendAgentMessage } from '../../services/agents/index';
import { requireEntityAccessPrehandler } from '../prehandlers';
import { getProjectRequestContext } from '../../middleware/request-context';

export function registerMessageRoutes(fastify: FastifyInstance): void {
  // Send/read-all/mark-read use manage access on agent
  fastify.post<{ Params: { id: string }; Body: { to: string; subject?: string; body: string; reply_to_id?: string } }>(
    '/agents/:id/messages/send',
    { preHandler: [requireEntityAccessPrehandler('agent', { manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      const context = getProjectRequestContext(request);
      const fromAgentId = request.params.id;
      const { to, subject, body, reply_to_id } = request.body as any;
      const input = { fromAgentId, toAgentId: to, subject, body, replyToId: reply_to_id };

      assertSendAgentMessageInput(input);

      const message = sendAgentMessage(db, input);
      return reply.code(201).send(message);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/agents/:id/messages/read-all',
    { preHandler: [requireEntityAccessPrehandler('agent', { manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;

      return { updated: markAllAgentMessagesRead(db, id) };
    }
  );

  fastify.put<{ Params: { id: string; msgId: string } }>(
    '/agents/:id/messages/:msgId',
    { preHandler: [requireEntityAccessPrehandler('agent', { manage: true }), requireEntityAccessPrehandler('message', { param: 'msgId', manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      const { id, msgId } = request.params;

      return markAgentMessageRead(db, id, msgId);
    }
  );

  // Get inbox/sent uses read access on agent
  fastify.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
    '/agents/:id/messages',
    { preHandler: [requireEntityAccessPrehandler('agent')] },
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const { status, limit } = request.query;

      return { messages: listAgentInboxMessages(db, { agentId: id, status, limit }) };
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/agents/:id/messages/sent',
    { preHandler: [requireEntityAccessPrehandler('agent')] },
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;

      return { messages: listAgentSentMessages(db, { agentId: id, limit: request.query.limit }) };
    }
  );
}
