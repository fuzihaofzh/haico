import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { ensureAgentAccess, ensureKnowledgeAccess, ensureProjectAccess } from '../services/project-permissions';
import {
  calculateKnowledgeExpiresAt,
  DEFAULT_KNOWLEDGE_CATEGORY,
  isKnowledgeCategory,
  isKnowledgeStatus,
  type KnowledgeCategory,
  type KnowledgeStatus,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_STATUSES,
  markExpiredKnowledgeEntries,
  normalizeKnowledgeCategory,
  normalizeKnowledgeStatus,
} from '../services/knowledge-lifecycle';
import { ensureAgentKnowledgeEntry, upsertAgentKnowledgeEntry } from '../services/agent-knowledge';

const VALID_IMPORTANCE = ['high', 'medium', 'low'];

function parseBooleanFlag(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseOwnerAgentId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function parseKnowledgeCategory(value: unknown): KnowledgeCategory | null {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_KNOWLEDGE_CATEGORY;
  }
  const normalized = String(value).trim().toLowerCase();
  return isKnowledgeCategory(normalized) ? normalized : null;
}

function parseKnowledgeStatus(value: unknown): KnowledgeStatus | 'all' | null {
  if (value === undefined || value === null || String(value).trim() === '') return 'active';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'all') return 'all';
  return isKnowledgeStatus(normalized) ? normalized : null;
}

function resolveKnowledgeActor(body: any, existing?: any): string {
  const actor = body?.verified_by || body?.created_by || existing?.verified_by || existing?.created_by || 'user';
  return String(actor).trim() || 'user';
}

export function registerKnowledgeRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { id: string } }>(
    '/api/agents/:id/knowledge-memory',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureAgentAccess(db, request, reply, request.params.id);
      if (!access) return;

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as any;
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });

      return ensureAgentKnowledgeEntry(db, agent);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { content?: string; tags?: string; importance?: string; category?: string; verified_by?: string } }>(
    '/api/agents/:id/knowledge-memory',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureAgentAccess(db, request, reply, request.params.id, true);
      if (!access) return;

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as any;
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });

      const body = request.body as any;
      if (!body?.content || !String(body.content).trim()) {
        return reply.status(400).send({ error: 'content is required' });
      }
      if (body.importance && !VALID_IMPORTANCE.includes(body.importance)) {
        return reply.status(400).send({ error: `Invalid importance. Must be one of: ${VALID_IMPORTANCE.join(', ')}` });
      }
      const category = parseKnowledgeCategory(body.category);
      if (body.category !== undefined && !category) {
        return reply.status(400).send({ error: `Invalid category. Must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}` });
      }

      return upsertAgentKnowledgeEntry(db, agent, {
        content: String(body.content),
        tags: body.tags,
        category: category || undefined,
        importance: body.importance,
        actor: body.verified_by || agent.id,
      });
    }
  );

  // List knowledge entries for a project (supports FTS5 full-text search via ?q=)
  fastify.get<{ Params: { pid: string }; Querystring: { tag?: string; importance?: string; q?: string; status?: string; category?: string; owner_agent_id?: string; include_owned?: string } }>(
    '/api/projects/:pid/knowledge',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const { tag, importance, q, status: statusQuery, category: categoryQuery, owner_agent_id: ownerAgentIdRaw, include_owned: includeOwnedRaw } = request.query;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      if (importance && !VALID_IMPORTANCE.includes(importance)) {
        return reply.status(400).send({ error: `Invalid importance. Must be one of: ${VALID_IMPORTANCE.join(', ')}` });
      }
      const status = parseKnowledgeStatus(statusQuery);
      if (!status) {
        return reply.status(400).send({ error: `Invalid status. Must be one of: all, ${KNOWLEDGE_STATUSES.join(', ')}` });
      }
      const category = categoryQuery ? parseKnowledgeCategory(categoryQuery) : null;
      if (categoryQuery && !category) {
        return reply.status(400).send({ error: `Invalid category. Must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}` });
      }
      const ownerAgentId = parseOwnerAgentId(ownerAgentIdRaw);
      const includeOwned = parseBooleanFlag(includeOwnedRaw);
      if (ownerAgentId) {
        const ownerAgent = db.prepare('SELECT id FROM agents WHERE id = ? AND project_id = ?').get(ownerAgentId, pid) as { id: string } | undefined;
        if (!ownerAgent) {
          return reply.status(400).send({ error: 'owner_agent_id must reference an agent in this project' });
        }
      }

      markExpiredKnowledgeEntries(db, pid);

      if (q && q.trim()) {
        // FTS5 full-text search
        let sql = `SELECT ke.*, rank
          FROM knowledge_fts fts
          JOIN knowledge_entries ke ON ke.rowid = fts.rowid
          WHERE knowledge_fts MATCH ? AND ke.project_id = ?`;
        const params: any[] = [q.trim(), pid];

        if (status !== 'all') {
          sql += ' AND ke.status = ?';
          params.push(status);
        }
        if (importance) {
          sql += ' AND ke.importance = ?';
          params.push(importance);
        }
        if (category) {
          sql += ' AND ke.category = ?';
          params.push(category);
        }
        if (tag) {
          sql += " AND (',' || ke.tags || ',' LIKE ?)";
          params.push(`%,${tag},%`);
        }
        if (ownerAgentId) {
          sql += ' AND ke.owner_agent_id = ?';
          params.push(ownerAgentId);
        } else if (!includeOwned) {
          sql += ' AND ke.owner_agent_id IS NULL';
        }
        sql += ' ORDER BY rank';
        const entries = db.prepare(sql).all(...params);
        return { entries };
      }

      // Standard LIKE-based listing
      let sql = 'SELECT * FROM knowledge_entries WHERE project_id = ?';
      const params: any[] = [pid];

      if (status !== 'all') {
        sql += ' AND status = ?';
        params.push(status);
      }
      if (importance) {
        sql += ' AND importance = ?';
        params.push(importance);
      }
      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }
      if (tag) {
        sql += " AND (',' || tags || ',' LIKE ?)";
        params.push(`%,${tag},%`);
      }
      if (ownerAgentId) {
        sql += ' AND owner_agent_id = ?';
        params.push(ownerAgentId);
      } else if (!includeOwned) {
        sql += ' AND owner_agent_id IS NULL';
      }

      sql += ' ORDER BY importance ASC, updated_at DESC';
      const entries = db.prepare(sql).all(...params);
      return { entries };
    }
  );

  // Create knowledge entry
  fastify.post<{ Params: { pid: string }; Body: { title: string; content: string; tags?: string; importance?: string; category?: string; created_by?: string; owner_agent_id?: string } }>(
    '/api/projects/:pid/knowledge',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const { title, content, tags, importance, category: categoryRaw, created_by, owner_agent_id: ownerAgentIdRaw } = request.body as any;
      const access = ensureProjectAccess(db, request, reply, pid, true);
      if (!access) return;

      if (!title) return reply.status(400).send({ error: 'title is required' });
      if (importance && !VALID_IMPORTANCE.includes(importance)) {
        return reply.status(400).send({ error: `Invalid importance. Must be one of: ${VALID_IMPORTANCE.join(', ')}` });
      }
      const category = parseKnowledgeCategory(categoryRaw);
      if (!category) {
        return reply.status(400).send({ error: `Invalid category. Must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}` });
      }
      const ownerAgentId = parseOwnerAgentId(ownerAgentIdRaw);
      if (ownerAgentId) {
        const ownerAgent = db.prepare('SELECT id FROM agents WHERE id = ? AND project_id = ?').get(ownerAgentId, pid) as { id: string } | undefined;
        if (!ownerAgent) {
          return reply.status(400).send({ error: 'owner_agent_id must reference an agent in this project' });
        }
        const existingOwnerEntry = db.prepare(
          'SELECT id FROM knowledge_entries WHERE project_id = ? AND owner_agent_id = ? LIMIT 1'
        ).get(pid, ownerAgentId) as { id: string } | undefined;
        if (existingOwnerEntry) {
          return reply.status(409).send({ error: 'Knowledge entry for this owner already exists' });
        }
      }

      const id = uuidv4();
      const actor = created_by || ownerAgentId || 'user';
      const expiresAt = calculateKnowledgeExpiresAt(category);
      db.prepare(
        `INSERT INTO knowledge_entries
          (id, project_id, owner_agent_id, title, content, tags, importance, category, expires_at, last_verified_at, verified_by, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'active', ?)`
      ).run(id, pid, ownerAgentId, title, content || '', tags || '', importance || 'medium', category, expiresAt, actor, actor);

      const entry = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id);
      return reply.status(201).send(entry);
    }
  );

  // Get single knowledge entry
  fastify.get<{ Params: { id: string } }>(
    '/api/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureKnowledgeAccess(db, request, reply, request.params.id);
      if (!access) return;
      const entry = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(request.params.id);
      if (!entry) return reply.status(404).send({ error: 'Knowledge entry not found' });
      return entry;
    }
  );

  // Update knowledge entry
  fastify.put<{ Params: { id: string }; Body: { title?: string; content?: string; tags?: string; importance?: string; category?: string; status?: string; verified_by?: string } }>(
    '/api/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const body = request.body as any;
      const access = ensureKnowledgeAccess(db, request, reply, id, true);
      if (!access) return;

      const existing = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as any;
      if (!existing) return reply.status(404).send({ error: 'Knowledge entry not found' });

      if (body.importance && !VALID_IMPORTANCE.includes(body.importance)) {
        return reply.status(400).send({ error: `Invalid importance. Must be one of: ${VALID_IMPORTANCE.join(', ')}` });
      }
      const category = body.category === undefined
        ? normalizeKnowledgeCategory(existing.category)
        : parseKnowledgeCategory(body.category);
      if (!category) {
        return reply.status(400).send({ error: `Invalid category. Must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}` });
      }
      const parsedStatus = body.status === undefined ? undefined : parseKnowledgeStatus(body.status);
      if (parsedStatus === 'all' || parsedStatus === null) {
        return reply.status(400).send({ error: `Invalid status. Must be one of: ${KNOWLEDGE_STATUSES.join(', ')}` });
      }

      const title = body.title ?? existing.title;
      const content = body.content ?? existing.content;
      const tags = body.tags ?? existing.tags;
      const importance = body.importance ?? existing.importance;
      const shouldRefreshLifecycle = body.title !== undefined
        || body.content !== undefined
        || body.tags !== undefined
        || body.importance !== undefined
        || body.category !== undefined;
      const status = parsedStatus ?? (shouldRefreshLifecycle ? 'active' : normalizeKnowledgeStatus(existing.status));
      const shouldVerifyLifecycle = shouldRefreshLifecycle || parsedStatus === 'active';
      const expiresAt = shouldVerifyLifecycle ? calculateKnowledgeExpiresAt(category) : existing.expires_at;
      const verifiedBy = shouldVerifyLifecycle || body.verified_by !== undefined
        ? resolveKnowledgeActor(body, existing)
        : existing.verified_by;

      if (shouldVerifyLifecycle) {
        db.prepare(
          `UPDATE knowledge_entries
           SET title = ?, content = ?, tags = ?, importance = ?, category = ?, expires_at = ?,
               last_verified_at = datetime('now'), verified_by = ?, status = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(title, content, tags, importance, category, expiresAt, verifiedBy, status, id);
      } else {
        db.prepare(
          `UPDATE knowledge_entries
           SET title = ?, content = ?, tags = ?, importance = ?, category = ?, expires_at = ?,
               verified_by = ?, status = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(title, content, tags, importance, category, expiresAt, verifiedBy, status, id);
      }

      const updated = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id);
      return updated;
    }
  );

  // Verify knowledge entry and extend its lifecycle
  fastify.post<{ Params: { id: string }; Body: { verified_by?: string } }>(
    '/api/knowledge/:id/verify',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const body = request.body as any;
      const access = ensureKnowledgeAccess(db, request, reply, id, true);
      if (!access) return;

      const existing = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as any;
      if (!existing) return reply.status(404).send({ error: 'Knowledge entry not found' });

      const category = normalizeKnowledgeCategory(existing.category);
      const expiresAt = calculateKnowledgeExpiresAt(category);
      const actor = resolveKnowledgeActor(body, existing);
      db.prepare(
        `UPDATE knowledge_entries
         SET last_verified_at = datetime('now'), verified_by = ?, expires_at = ?, status = 'active', updated_at = datetime('now')
         WHERE id = ?`
      ).run(actor, expiresAt, id);

      const updated = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id);
      return updated;
    }
  );

  // Delete knowledge entry
  fastify.delete<{ Params: { id: string } }>(
    '/api/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const access = ensureKnowledgeAccess(db, request, reply, id, true);
      if (!access) return;
      const existing = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as any;
      if (!existing) return reply.status(404).send({ error: 'Knowledge entry not found' });

      db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
      return { success: true };
    }
  );
}
