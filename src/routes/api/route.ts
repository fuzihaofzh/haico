import { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin';
import { registerAgentRoutes } from './agents';
import { registerCommandProfileRoutes } from './command-profiles';
import { registerDashboardChatRoutes } from './dashboard-chat';
import { registerExecutiveSummaryRoutes } from './executive-summaries';
import { registerIssueRoutes } from './issues';
import { registerKnowledgeRoutes } from './knowledge';
import { registerMessageRoutes } from './messages';
import { registerProjectRoutes } from './projects';
import { registerRemoteInstanceRoutes } from './remote';
import { registerSettingsRoutes } from './settings';
import { registerSkillRoutes } from './skills';
import { registerTemplateRoutes } from './templates';

// Protected business API routes only.
// Auth routes are registered separately in routes/route.ts because their
// login/register endpoints must remain available before the auth guard.
export async function registerApiRoutes(fastify: FastifyInstance): Promise<void> {
  registerProjectRoutes(fastify);
  registerAdminRoutes(fastify);
  registerAgentRoutes(fastify);
  registerIssueRoutes(fastify);
  registerCommandProfileRoutes(fastify);
  registerKnowledgeRoutes(fastify);
  registerMessageRoutes(fastify);
  registerTemplateRoutes(fastify);
  registerExecutiveSummaryRoutes(fastify);
  registerRemoteInstanceRoutes(fastify);
  registerDashboardChatRoutes(fastify);
  registerSettingsRoutes(fastify);
  registerSkillRoutes(fastify);
}
