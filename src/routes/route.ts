import { FastifyInstance } from 'fastify';
import { setupAuth } from '../middleware/auth';
import { setupWebSocket } from '../services/websocket';
import { registerAgentRoutes } from './agents';
import { registerApprovalRoutes } from './approvals';
import { registerAuthRoutes } from './auth';
import { registerDashboardChatRoutes } from './dashboard-chat';
import { registerExecutiveSummaryRoutes } from './executive-summaries';
import { registerApiRoutes } from './api/route';
import { registerKnowledgeRoutes } from './knowledge';
import { registerMessageRoutes } from './messages';
import { registerPaymentApprovalRoutes } from './payment-approvals';
import { registerProjectRoutes } from './projects';
import { registerRemoteInstanceRoutes } from './remote-instances';
import { registerTemplateRoutes } from './templates';
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

  // TODO: Gradually move the remaining protected /api route modules below into
  // routes/api/, remove their hard-coded /api prefixes, and register them from
  // routes/api/route.ts. Keep auth as the special pre-guard registration above.
  registerProjectRoutes(fastify);
  registerAgentRoutes(fastify);
  await fastify.register(registerApiRoutes, { prefix: API_PREFIX });
  registerKnowledgeRoutes(fastify);
  registerMessageRoutes(fastify);
  registerTemplateRoutes(fastify);
  registerApprovalRoutes(fastify);
  registerPaymentApprovalRoutes(fastify);
  registerExecutiveSummaryRoutes(fastify);
  registerRemoteInstanceRoutes(fastify);
  registerDashboardChatRoutes(fastify);
  registerUIRoutes(fastify);
  setupWebSocket(fastify);
}
