import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { ensureAgentAccess, ensureMemoryAccess, ensureProjectAccess } from '../services/project-permissions';

export function registerMemoryRoutes(fastify: FastifyInstance): void {
  // Save a memory for an agent
  fastify.post<{ Params: { id: string }; Body: { content: string; tags?: string; scope?: string; session_id?: string; expires_at?: string } }>(
    '/api/agents/:id/memories',
    async (request, reply) => {
      const db = getDatabase();
      const { id: agentId } = request.params;
      const { content, tags, scope, session_id, expires_at } = request.body as any;
      const access = ensureAgentAccess(db, request, reply, agentId, true);
      if (!access) return;

      if (!content) return reply.status(400).send({ error: 'content is required' });

      const validScope = ['private', 'project'];
      if (scope && !validScope.includes(scope)) {
        return reply.status(400).send({ error: `Invalid scope. Must be one of: ${validScope.join(', ')}` });
      }

      const memId = uuidv4();
      db.prepare(
        'INSERT INTO agent_memories (id, agent_id, project_id, session_id, content, tags, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(memId, agentId, access.entity.project_id, session_id || null, content, tags || '', scope || 'private', expires_at || null);

      const entry = db.prepare('SELECT * FROM agent_memories WHERE id = ?').get(memId);
      return reply.status(201).send(entry);
    }
  );

  // Query memories for an agent (supports FTS via ?q=)
  fastify.get<{ Params: { id: string }; Querystring: { q?: string; scope?: string; limit?: string } }>(
    '/api/agents/:id/memories',
    async (request, reply) => {
      const db = getDatabase();
      const { id: agentId } = request.params;
      const { q, scope, limit } = request.query;
      const maxResults = Math.min(parseInt(limit || '50', 10), 200);
      const access = ensureAgentAccess(db, request, reply, agentId);
      if (!access) return;

      const projectId = access.entity.project_id;

      if (q && q.trim()) {
        // FTS5 search across agent's own memories + project-scope memories
        const memories = db.prepare(`
          SELECT am.*, rank
          FROM memories_fts fts
          JOIN agent_memories am ON am.rowid = fts.rowid
          WHERE memories_fts MATCH ?
            AND am.project_id = ?
            AND (am.agent_id = ? OR am.scope = 'project')
            AND (am.expires_at IS NULL OR am.expires_at > datetime('now'))
          ORDER BY rank
          LIMIT ?
        `).all(q.trim(), projectId, agentId, maxResults);
        return { memories };
      }

      // List memories (own + project scope)
      let sql = `SELECT * FROM agent_memories
        WHERE project_id = ?
          AND (agent_id = ? OR scope = 'project')
          AND (expires_at IS NULL OR expires_at > datetime('now'))`;
      const params: any[] = [projectId, agentId];

      if (scope) {
        sql += ' AND scope = ?';
        params.push(scope);
      }

      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(maxResults);

      const memories = db.prepare(sql).all(...params);
      return { memories };
    }
  );

  // Query project-wide memories
  fastify.get<{ Params: { pid: string }; Querystring: { q?: string; limit?: string } }>(
    '/api/projects/:pid/memories',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const { q, limit } = request.query;
      const maxResults = Math.min(parseInt(limit || '50', 10), 200);
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      if (q && q.trim()) {
        const memories = db.prepare(`
          SELECT am.*, rank
          FROM memories_fts fts
          JOIN agent_memories am ON am.rowid = fts.rowid
          WHERE memories_fts MATCH ?
            AND am.project_id = ?
            AND am.scope = 'project'
            AND (am.expires_at IS NULL OR am.expires_at > datetime('now'))
          ORDER BY rank
          LIMIT ?
        `).all(q.trim(), pid, maxResults);
        return { memories };
      }

      const memories = db.prepare(`
        SELECT * FROM agent_memories
        WHERE project_id = ? AND scope = 'project'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY created_at DESC LIMIT ?
      `).all(pid, maxResults);
      return { memories };
    }
  );

  // Delete a memory
  fastify.delete<{ Params: { id: string; memId: string } }>(
    '/api/agents/:id/memories/:memId',
    async (request, reply) => {
      const db = getDatabase();
      const { id: agentId, memId } = request.params;
      const agentAccess = ensureAgentAccess(db, request, reply, agentId, true);
      if (!agentAccess) return;
      const memoryAccess = ensureMemoryAccess(db, request, reply, memId, true);
      if (!memoryAccess) return;
      if (memoryAccess.entity.agent_id !== agentId) {
        return reply.status(404).send({ error: 'Memory not found' });
      }

      db.prepare('DELETE FROM agent_memories WHERE id = ?').run(memId);
      return { success: true };
    }
  );
}
