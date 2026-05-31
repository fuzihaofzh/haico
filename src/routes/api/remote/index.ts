import { FastifyInstance } from 'fastify';
import { registerRemoteInstanceCrudRoutes } from './instances';
import { registerRemoteProjectProxyRoutes } from './projects';
import { registerRemoteAgentProxyRoutes } from './agents';
import { registerRemoteIssueProxyRoutes } from './issues';
import { registerRemoteKnowledgeProxyRoutes } from './knowledge';
import { registerRemoteNotificationRoutes } from './notifications';

export function registerRemoteInstanceRoutes(fastify: FastifyInstance): void {
  registerRemoteInstanceCrudRoutes(fastify);
  registerRemoteProjectProxyRoutes(fastify);
  registerRemoteAgentProxyRoutes(fastify);
  registerRemoteIssueProxyRoutes(fastify);
  registerRemoteKnowledgeProxyRoutes(fastify);
  registerRemoteNotificationRoutes(fastify);
}
