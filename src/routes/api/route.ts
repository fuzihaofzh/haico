import { FastifyInstance } from 'fastify';
import { registerCommandProfileRoutes } from './command-profiles';
import { registerIssueRoutes } from './issues';

// Protected business API routes only.
// Auth routes are registered separately in routes/route.ts because their
// setup/login endpoints must remain available before the auth guard.
export async function registerApiRoutes(fastify: FastifyInstance): Promise<void> {
  registerIssueRoutes(fastify);
  registerCommandProfileRoutes(fastify);
}
