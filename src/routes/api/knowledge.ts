import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { createKnowledgeEntry, deleteKnowledgeEntry, getAgentKnowledgeMemory, getKnowledgeEntry, listKnowledgeEntries, updateAgentKnowledgeMemory, updateKnowledgeEntry, verifyKnowledgeEntry } from '../../services/knowledge';
import { requireProjectAccessPrehandler, requireEntityAccessPrehandler } from '../prehandlers';

export function registerKnowledgeRoutes(fastify: FastifyInstance): void {
  // Agent knowledge endpoints use agent entity access
  fastify.get<{ Params: { id: string } }>('/agents/:id/knowledge-memory', { preHandler: [requireEntityAccessPrehandler('agent')] }, async (request, reply) => {
    const db = getDatabase();
    return getAgentKnowledgeMemory(db, request.params.id);
  });

  fastify.put<{ Params: { id: string }; Body: { content?: string; tags?: string; importance?: string; category?: string; verified_by?: string } }>(
    '/agents/:id/knowledge-memory',
    { preHandler: [requireEntityAccessPrehandler('agent', { manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      return updateAgentKnowledgeMemory(db, request.params.id, request.body || {});
    }
  );

  // Knowledge CRUD uses project access
  fastify.get<{ Params: { pid: string }; Querystring: { tag?: string; importance?: string; q?: string; status?: string; category?: string; owner_agent_id?: string; include_owned?: string } }>(
    '/projects/:pid/knowledge',
    { preHandler: [requireProjectAccessPrehandler()] },
    async (request, reply) => {
      const db = getDatabase();
      const entries = listKnowledgeEntries(db, request.params.pid, request.query);
      return { entries };
    }
  );

  fastify.post<{ Params: { pid: string }; Body: { title?: string; content?: string; tags?: string; importance?: string; category?: string; created_by?: string; owner_agent_id?: string } }>(
    '/projects/:pid/knowledge',
    { preHandler: [requireProjectAccessPrehandler({ manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      const entry = createKnowledgeEntry(db, request.params.pid, request.body || {});
      return reply.status(201).send(entry);
    }
  );

  // Knowledge entity read uses knowledge entity access
  fastify.get<{ Params: { id: string } }>(
    '/knowledge/:id',
    { preHandler: [requireEntityAccessPrehandler('knowledge')] },
    async (request, reply) => {
      const db = getDatabase();
      return getKnowledgeEntry(db, request.params.id);
    }
  );

  // Knowledge entity management uses knowledge entity access with manage
  fastify.put<{ Params: { id: string }; Body: { title?: string; content?: string; tags?: string; importance?: string; category?: string; status?: string; verified_by?: string } }>(
    '/knowledge/:id',
    { preHandler: [requireEntityAccessPrehandler('knowledge', { manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      return updateKnowledgeEntry(db, request.params.id, request.body || {});
    }
  );

  fastify.post<{ Params: { id: string }; Body: { verified_by?: string } }>(
    '/knowledge/:id/verify',
    { preHandler: [requireEntityAccessPrehandler('knowledge', { manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      return verifyKnowledgeEntry(db, request.params.id, request.body || {});
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/knowledge/:id',
    { preHandler: [requireEntityAccessPrehandler('knowledge', { manage: true })] },
    async (request, reply) => {
      const db = getDatabase();
      deleteKnowledgeEntry(db, request.params.id);
      return { success: true };
    }
  );
}
