import { FastifyInstance } from 'fastify';
import { registerAgentRoutes } from './agents';
import { registerApprovalRoutes } from './approvals';
import { registerCommandProfileRoutes } from './command-profiles';
import { registerDashboardChatRoutes } from './dashboard-chat';
import { registerExecutiveSummaryRoutes } from './executive-summaries';
import { registerIssueRoutes } from './issues';
import { registerKnowledgeRoutes } from './knowledge';
import { registerMessageRoutes } from './messages';
import { registerPaymentApprovalRoutes } from './payment-approvals';
import { registerProjectRoutes } from './projects';
import { registerRemoteInstanceRoutes } from './remote-instances';
import { registerTemplateRoutes } from './templates';

// Protected business API routes only.
// Auth routes are registered separately in routes/route.ts because their
// login/register endpoints must remain available before the auth guard.
export async function registerApiRoutes(fastify: FastifyInstance): Promise<void> {
  registerProjectRoutes(fastify);
  registerAgentRoutes(fastify);
  registerIssueRoutes(fastify);
  registerCommandProfileRoutes(fastify);
  registerKnowledgeRoutes(fastify);
  registerMessageRoutes(fastify);
  registerTemplateRoutes(fastify);
  registerApprovalRoutes(fastify);
  registerPaymentApprovalRoutes(fastify);
  registerExecutiveSummaryRoutes(fastify);
  registerRemoteInstanceRoutes(fastify);
  registerDashboardChatRoutes(fastify);
}
