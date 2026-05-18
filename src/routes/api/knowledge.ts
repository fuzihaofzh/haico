import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { getProjectRequestContext } from '../../middleware/request-context';
import { requireAgentAccess, requireKnowledgeAccess, requireProjectAccess } from '../../services/project-access';
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  getAgentKnowledgeMemory,
  getKnowledgeEntry,
  listKnowledgeEntries,
  updateAgentKnowledgeMemory,
  updateKnowledgeEntry,
  verifyKnowledgeEntry,
} from '../../services/knowledge';

export function registerKnowledgeRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { id: string } }>(
    '/agents/:id/knowledge-memory',
    async (request, reply) => {
      const db = getDatabase();
      requireAgentAccess(db, getProjectRequestContext(request), request.params.id);

      return getAgentKnowledgeMemory(db, request.params.id);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { content?: string; tags?: string; importance?: string; category?: string; verified_by?: string } }>(
    '/agents/:id/knowledge-memory',
    async (request, reply) => {
      const db = getDatabase();
      requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);

      return updateAgentKnowledgeMemory(db, request.params.id, request.body || {});
    }
  );

  fastify.get<{ Params: { pid: string }; Querystring: { tag?: string; importance?: string; q?: string; status?: string; category?: string; owner_agent_id?: string; include_owned?: string } }>(
    '/projects/:pid/knowledge',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      const entries = listKnowledgeEntries(db, request.params.pid, request.query);
      return { entries };
    }
  );

  fastify.post<{ Params: { pid: string }; Body: { title?: string; content?: string; tags?: string; importance?: string; category?: string; created_by?: string; owner_agent_id?: string } }>(
    '/projects/:pid/knowledge',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid, true);

      const entry = createKnowledgeEntry(db, request.params.pid, request.body || {});
      return reply.status(201).send(entry);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      requireKnowledgeAccess(db, getProjectRequestContext(request), request.params.id);

      return getKnowledgeEntry(db, request.params.id);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { title?: string; content?: string; tags?: string; importance?: string; category?: string; status?: string; verified_by?: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      requireKnowledgeAccess(db, getProjectRequestContext(request), request.params.id, true);

      return updateKnowledgeEntry(db, request.params.id, request.body || {});
    }
  );

  fastify.post<{ Params: { id: string }; Body: { verified_by?: string } }>(
    '/knowledge/:id/verify',
    async (request, reply) => {
      const db = getDatabase();
      requireKnowledgeAccess(db, getProjectRequestContext(request), request.params.id, true);

      return verifyKnowledgeEntry(db, request.params.id, request.body || {});
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      requireKnowledgeAccess(db, getProjectRequestContext(request), request.params.id, true);

      deleteKnowledgeEntry(db, request.params.id);
      return { success: true };
    }
  );
}
