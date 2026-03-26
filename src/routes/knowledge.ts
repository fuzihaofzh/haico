import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';

export function registerKnowledgeRoutes(fastify: FastifyInstance): void {
  // List knowledge entries for a project
  fastify.get<{ Params: { pid: string }; Querystring: { tag?: string; importance?: string } }>(
    '/api/projects/:pid/knowledge',
    async (request) => {
      const db = getDatabase();
      const { pid } = request.params;
      const { tag, importance } = request.query;

      let sql = 'SELECT * FROM knowledge_entries WHERE project_id = ?';
      const params: any[] = [pid];

      if (importance) {
        sql += ' AND importance = ?';
        params.push(importance);
      }
      if (tag) {
        sql += ' AND ("," || tags || "," LIKE ?)';
        params.push(`%,${tag},%`);
      }

      sql += ' ORDER BY importance ASC, updated_at DESC';
      const entries = db.prepare(sql).all(...params);
      return { entries };
    }
  );

  // Create knowledge entry
  fastify.post<{ Params: { pid: string }; Body: { title: string; content: string; tags?: string; importance?: string; created_by?: string } }>(
    '/api/projects/:pid/knowledge',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const { title, content, tags, importance, created_by } = request.body as any;

      if (!title) return reply.status(400).send({ error: 'title is required' });

      const id = uuidv4();
      db.prepare(
        'INSERT INTO knowledge_entries (id, project_id, title, content, tags, importance, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, pid, title, content || '', tags || '', importance || 'medium', created_by || 'user');

      const entry = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id);
      return reply.status(201).send(entry);
    }
  );

  // Get single knowledge entry
  fastify.get<{ Params: { id: string } }>(
    '/api/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const entry = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(request.params.id);
      if (!entry) return reply.status(404).send({ error: 'Knowledge entry not found' });
      return entry;
    }
  );

  // Update knowledge entry
  fastify.put<{ Params: { id: string }; Body: { title?: string; content?: string; tags?: string; importance?: string } }>(
    '/api/knowledge/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const body = request.body as any;

      const existing = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as any;
      if (!existing) return reply.status(404).send({ error: 'Knowledge entry not found' });

      const title = body.title ?? existing.title;
      const content = body.content ?? existing.content;
      const tags = body.tags ?? existing.tags;
      const importance = body.importance ?? existing.importance;

      db.prepare(
        "UPDATE knowledge_entries SET title = ?, content = ?, tags = ?, importance = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(title, content, tags, importance, id);

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
      const existing = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as any;
      if (!existing) return reply.status(404).send({ error: 'Knowledge entry not found' });

      db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
      return { success: true };
    }
  );
}
