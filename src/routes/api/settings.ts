import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';

const VALID_LANDING_PAGES: Record<string, true> = {
  overview: true,
  inbox: true,
  chat: true,
  projects: true,
};

export function registerSettingsRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/settings/default-landing-page', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' });
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, 'default_landing_page') as
      | { value: string }
      | undefined;
    const value = row?.value && row.value in VALID_LANDING_PAGES ? row.value : 'overview';
    return reply.send({ value });
  });

  fastify.put('/api/settings/default-landing-page', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' });
    const body = request.body as { value?: string };
    const value = body?.value;
    if (!value || !(value in VALID_LANDING_PAGES)) {
      return reply.code(400).send({ error: 'Invalid landing page. Must be one of: ' + Object.keys(VALID_LANDING_PAGES).join(', ') });
    }
    const db = getDatabase();
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, 'default_landing_page', value);
    return reply.send({ value });
  });
}
