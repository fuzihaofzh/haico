import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { config } from './config';
import { getDatabase, closeDatabase, isDatabaseOpen } from './db/database';
import { setupAuth } from './middleware/auth';
import { registerProjectRoutes } from './routes/projects';
import { registerAgentRoutes } from './routes/agents';
import { registerIssueRoutes, clearPendingControllerTriggerTimers } from './routes/issues';
import { registerUIRoutes } from './routes/ui';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerMemoryRoutes } from './routes/memories';
import { registerMessageRoutes } from './routes/messages';
import { registerTemplateRoutes } from './routes/templates';
import { registerApprovalRoutes } from './routes/approvals';
import { setupWebSocket } from './services/websocket';
import { initializeScheduler } from './services/scheduler';
import { setOnAgentFinish, stopAllProcesses } from './services/process-manager';
import { triggerControllerAgent } from './services/controller';
import { stopAllSchedulers } from './services/scheduler';
import { killAllPtySessions } from './services/terminal';
import { clearAllPtyCleanupTimers } from './services/websocket';
import { Agent, Project } from './types';

const pendingFinishTimers = new Set<NodeJS.Timeout>();

export interface AppOptions {
  port?: number;
  host?: string;
  logger?: boolean;
  skipScheduler?: boolean;
}

export async function createApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;

  const fastify = Fastify({ logger: opts.logger ?? true });

  await fastify.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/',
  });

  setupAuth(fastify);
  registerProjectRoutes(fastify);
  registerAgentRoutes(fastify);
  registerIssueRoutes(fastify);
  registerKnowledgeRoutes(fastify);
  registerMemoryRoutes(fastify);
  registerMessageRoutes(fastify);
  registerTemplateRoutes(fastify);
  registerApprovalRoutes(fastify);
  registerUIRoutes(fastify);
  setupWebSocket(fastify);

  getDatabase();

  setOnAgentFinish((agent: Agent, exitCode: number | null) => {
    try {
      const db = getDatabase();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
      if (!project || project.status !== 'active') return;

      if (!agent.is_controller) {
        // Worker finished — only trigger controller if there are issues that
        // genuinely need controller attention (unassigned, errored workers, etc.)
        // System-level auto-assign and issue scan handle most cases now.
        const needsController = db.prepare(`
          SELECT 1 FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress')
          AND (assigned_to IS NULL OR assigned_to = 'all' OR assigned_to = 'user'
               OR assigned_to IN (SELECT id FROM agents WHERE project_id = ? AND is_controller = 1))
          LIMIT 1
        `).get(project.id, project.id);

        if (needsController) {
          const timer = setTimeout(() => {
            pendingFinishTimers.delete(timer);
            if (!isDatabaseOpen()) return;
            try { triggerControllerAgent(project); } catch (e) { fastify.log.error(e, 'Failed to trigger controller agent'); }
          }, 2000);
          pendingFinishTimers.add(timer);
        }
      }
    } catch (e) {
      fastify.log.warn(e, 'Failed to handle agent finish (DB may be closed)');
    }
  });

  if (!opts.skipScheduler) {
    initializeScheduler();
  }

  await fastify.listen({ port, host });

  // If port 0 was requested, the OS assigned a random port. Update config.port
  // and process.env.AGENTOPIA_PORT so that system prompts and spawned agents get
  // the real port.
  const addr = fastify.server.address();
  if (addr && typeof addr === 'object' && addr.port) {
    config.port = addr.port;
    process.env.AGENTOPIA_PORT = String(addr.port);
  }

  return fastify;
}

export async function destroyApp(fastify: FastifyInstance): Promise<void> {
  // Clear onAgentFinish callback to prevent new async activity during shutdown
  setOnAgentFinish(null);
  // Cancel any pending triggerControllerAgent timers (from onAgentFinish and issue routes)
  for (const timer of pendingFinishTimers) clearTimeout(timer);
  pendingFinishTimers.clear();
  clearPendingControllerTriggerTimers();

  stopAllSchedulers();
  await stopAllProcesses();
  clearAllPtyCleanupTimers();
  killAllPtySessions();
  await fastify.close();
  // Unref the underlying HTTP server so it doesn't keep the event loop alive
  // after close (Fastify's close() stops listening but the handle remains ref'd)
  fastify.server.unref();
  closeDatabase();
}
