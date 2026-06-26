import { FastifyInstance } from 'fastify';
import { setupAuth } from '../middleware/auth';
import { registerAuthRoutes } from './auth';
import { registerApiRoutes } from './api/route';
import { registerAdminUIRoutes } from './ui-admin';
import { registerUIRoutes } from './ui';
import { registerWebSocketRoutes } from './ws';

const API_PREFIX = '/api';

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  // Auth is intentionally kept outside routes/api even though its public URL is
  // /api/auth/*. Login/register must be available before setupAuth adds
  // the global guard; routes/api is reserved for protected business APIs.
  await fastify.register(async (authRoutes) => {
    registerAuthRoutes(authRoutes);
  }, { prefix: API_PREFIX });

  setupAuth(fastify);

  await fastify.register(registerApiRoutes, { prefix: API_PREFIX });
  registerUIRoutes(fastify);
  registerAdminUIRoutes(fastify);
  registerWebSocketRoutes(fastify);
}
