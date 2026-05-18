import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { getProjectRequestContext } from '../../middleware/request-context';
import {
  assertSendAgentMessageInput,
  listAgentInboxMessages,
  listAgentSentMessages,
  markAgentMessageRead,
  markAllAgentMessagesRead,
  sendAgentMessage,
} from '../../services/agents/index';
import {
  requireAgentAccess,
  requireMessageAccess,
} from '../../services/project-access';

export function registerMessageRoutes(fastify: FastifyInstance): void {
  // Send a message to an agent
  fastify.post<{ Params: { id: string }; Body: { to: string; subject?: string; body: string; reply_to_id?: string } }>(
    '/agents/:id/messages/send',
    async (request, reply) => {
      const db = getDatabase();
      const context = getProjectRequestContext(request);
      const fromAgentId = request.params.id;
      const { to, subject, body, reply_to_id } = request.body as any;
      const input = { fromAgentId, toAgentId: to, subject, body, replyToId: reply_to_id };

      assertSendAgentMessageInput(input);
      requireAgentAccess(db, context, fromAgentId, true);

      const message = sendAgentMessage(db, input);
      return reply.code(201).send(message);
    }
  );

  // Get inbox (messages received by this agent)
  fastify.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
    '/agents/:id/messages',
    async (request, reply) => {
      const db = getDatabase();
      const context = getProjectRequestContext(request);
      const { id } = request.params;
      const { status, limit } = request.query;

      requireAgentAccess(db, context, id);
      return { messages: listAgentInboxMessages(db, { agentId: id, status, limit }) };
    }
  );

  // Get sent messages
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/agents/:id/messages/sent',
    async (request, reply) => {
      const db = getDatabase();
      const context = getProjectRequestContext(request);
      const { id } = request.params;

      requireAgentAccess(db, context, id);
      return { messages: listAgentSentMessages(db, { agentId: id, limit: request.query.limit }) };
    }
  );

  // Mark message as read
  fastify.put<{ Params: { id: string; msgId: string } }>(
    '/agents/:id/messages/:msgId',
    async (request, reply) => {
      const db = getDatabase();
      const context = getProjectRequestContext(request);
      const { id, msgId } = request.params;

      requireAgentAccess(db, context, id, true);
      requireMessageAccess(db, context, msgId, true);
      return markAgentMessageRead(db, id, msgId);
    }
  );

  // Mark all messages as read for an agent
  fastify.post<{ Params: { id: string } }>(
    '/agents/:id/messages/read-all',
    async (request, reply) => {
      const db = getDatabase();
      const context = getProjectRequestContext(request);
      const { id } = request.params;

      requireAgentAccess(db, context, id, true);
      return { updated: markAllAgentMessagesRead(db, id) };
    }
  );
}
