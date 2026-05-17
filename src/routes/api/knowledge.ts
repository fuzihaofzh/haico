import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { ensureAgentAccess, ensureKnowledgeAccess, ensureProjectAccess } from '../../services/project-access';
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
      const access = ensureAgentAccess(db, request, reply, request.params.id);
      if (!access) return;

      return getAgentKnowledgeMemory(db, request.params.id);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { content?: string; tags?: string; importance?: string; category?: string; verified_by?: string } }>(
    '/agents/:id/knowledge-memory',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureAgentAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      return updateAgentKnowledgeMemory(db, request.params.id, request.body || {});
    }
  );

  fastify.get<{ Params: { pid: string }; Querystring: { tag?: string; importance?: string; q?: string; status?: string; category?: string; owner_agent_id?: string; include_owned?: string } }>(
    '/projects/:pid/knowledge',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;

      const entries = listKnowledgeEntries(db, request.params.pid, request.query);
      return { entries };
    }
  );

  fastify.post<{ Params: { pid: string }; Body: { title?: string; content?: string; tags?: string; importance?: string; category?: string; created_by?: string; owner_agent_id?: string } }>(
    '/projects/:pid/knowledge',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid, true);
      if (!access) return;

      const entry = createKnowledgeEntry(db, request.params.pid, request.body || {});
      return reply.status(201).send(entry);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureKnowledgeAccess(db, request, reply, request.params.id);
      if (!access) return;

      return getKnowledgeEntry(db, request.params.id);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { title?: string; content?: string; tags?: string; importance?: string; category?: string; status?: string; verified_by?: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureKnowledgeAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      return updateKnowledgeEntry(db, request.params.id, request.body || {});
    }
  );

  fastify.post<{ Params: { id: string }; Body: { verified_by?: string } }>(
    '/knowledge/:id/verify',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureKnowledgeAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      return verifyKnowledgeEntry(db, request.params.id, request.body || {});
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureKnowledgeAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      deleteKnowledgeEntry(db, request.params.id);
      return { success: true };
    }
  );
}
