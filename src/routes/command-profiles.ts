import { FastifyInstance } from 'fastify';
import { getDatabase } from '../db/database';
import {
  COMMAND_PROFILE_TYPES,
  normalizeCommandProfileType,
  resolveCommandType,
} from '../services/command-profiles';

function normalizeProfileName(value: unknown): string {
  return String(value || '').trim();
}

function normalizeProfileCommand(value: unknown): string {
  return String(value || '').trim();
}

function normalizeIntelligence(value: unknown): number {
  const num = Number(value);
  if (Number.isNaN(num)) return 5;
  return Math.max(1, Math.min(10, Math.round(num)));
}

const COMMAND_PROFILE_TYPE_ERROR = `type is required and must be one of: ${COMMAND_PROFILE_TYPES.join(', ')}`;

export function registerCommandProfileRoutes(fastify: FastifyInstance): void {
  fastify.register((profileRoutes, _opts, done) => {
    const defaultJsonParser = profileRoutes.getDefaultJsonParser('error', 'error');

    profileRoutes.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, parserDone) => {
      const bodyText = typeof body === 'string' ? body : body.toString();
      if (bodyText.length === 0) {
        parserDone(null, undefined);
        return;
      }

      defaultJsonParser(request, bodyText, parserDone);
    });

    profileRoutes.get('/api/command-profiles', async () => {
      const db = getDatabase();
      const profiles = db.prepare(
        `SELECT id, name, command, type, intelligence, created_at, updated_at
         FROM command_profiles
         ORDER BY intelligence ASC, lower(name), created_at`
      ).all();
      return { profiles };
    });

    profileRoutes.post<{
      Body: { name?: string; command?: string; type?: string | null; intelligence?: number };
    }>('/api/command-profiles', async (request, reply) => {
      const db = getDatabase();
      const name = normalizeProfileName(request.body?.name);
      const command = normalizeProfileCommand(request.body?.command);
      const type = resolveCommandType(request.body?.type, command);
      const intelligence = normalizeIntelligence(request.body?.intelligence);

      if (!name) return reply.code(400).send({ error: 'name is required' });
      if (!command) return reply.code(400).send({ error: 'command is required' });
      if (!type) return reply.code(400).send({ error: COMMAND_PROFILE_TYPE_ERROR });

      const result = db.prepare(
        `INSERT INTO command_profiles (name, command, type, intelligence, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(name, command, type, intelligence);

      return reply.code(201).send(
        db.prepare('SELECT id, name, command, type, intelligence, created_at, updated_at FROM command_profiles WHERE rowid = ?').get(result.lastInsertRowid)
      );
    });

    profileRoutes.put<{
      Params: { id: string };
      Body: { name?: string; command?: string; type?: string | null; intelligence?: number };
    }>('/api/command-profiles/:id', async (request, reply) => {
      const db = getDatabase();
      const existing = db.prepare('SELECT * FROM command_profiles WHERE id = ?').get(request.params.id) as
        | { id: string; name: string; command: string; type: string; intelligence: number }
        | undefined;
      if (!existing) return reply.code(404).send({ error: 'Command profile not found' });

      const hasName = Object.prototype.hasOwnProperty.call(request.body || {}, 'name');
      const hasCommand = Object.prototype.hasOwnProperty.call(request.body || {}, 'command');
      const hasType = Object.prototype.hasOwnProperty.call(request.body || {}, 'type');
      const hasIntelligence = Object.prototype.hasOwnProperty.call(request.body || {}, 'intelligence');

      const name = hasName ? normalizeProfileName(request.body?.name) : existing.name;
      const command = hasCommand ? normalizeProfileCommand(request.body?.command) : existing.command;
      const type = hasType || hasCommand
        ? resolveCommandType(
            hasType ? request.body?.type : existing.type,
            command
          )
        : normalizeCommandProfileType(existing.type);
      const intelligence = hasIntelligence ? normalizeIntelligence(request.body?.intelligence) : existing.intelligence;

      if (!name) return reply.code(400).send({ error: 'name is required' });
      if (!command) return reply.code(400).send({ error: 'command is required' });
      if (!type) return reply.code(400).send({ error: COMMAND_PROFILE_TYPE_ERROR });

      db.prepare(
        `UPDATE command_profiles
         SET name = ?, command = ?, type = ?, intelligence = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(name, command, type, intelligence, request.params.id);

      return db.prepare(
        'SELECT id, name, command, type, intelligence, created_at, updated_at FROM command_profiles WHERE id = ?'
      ).get(request.params.id);
    });

    profileRoutes.delete<{ Params: { id: string } }>('/api/command-profiles/:id', async (request, reply) => {
      const db = getDatabase();
      const result = db.prepare('DELETE FROM command_profiles WHERE id = ?').run(request.params.id);
      if (result.changes === 0) return reply.code(404).send({ error: 'Command profile not found' });
      return { success: true };
    });

    done();
  });
}
