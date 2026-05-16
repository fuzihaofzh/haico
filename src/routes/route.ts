import { FastifyInstance } from 'fastify';
import { setupAuth } from '../middleware/auth';
import { setupWebSocket } from '../services/websocket';
import { registerAuthRoutes } from './auth';
import { registerApiRoutes } from './api/route';
import { registerUIRoutes } from './ui';

const API_PREFIX = '/api';

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  // Auth is intentionally kept outside routes/api even though its public URL is
  // /api/auth/*. Setup/login/register must be available before setupAuth adds
  // the global guard; routes/api is reserved for protected business APIs.
  await fastify.register(async (authRoutes) => {
    registerAuthRoutes(authRoutes);
  }, { prefix: API_PREFIX });

  setupAuth(fastify);

  await fastify.register(registerApiRoutes, { prefix: API_PREFIX });
  registerUIRoutes(fastify);
  setupWebSocket(fastify);
}
