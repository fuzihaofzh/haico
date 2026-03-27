import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { config } from './config';
import { getDatabase, closeDatabase } from './db/database';
import { setupAuth } from './middleware/auth';
import { registerProjectRoutes } from './routes/projects';
import { registerAgentRoutes } from './routes/agents';
import { registerIssueRoutes } from './routes/issues';
import { registerUIRoutes } from './routes/ui';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerMemoryRoutes } from './routes/memories';
import { setupWebSocket } from './services/websocket';
import { initializeScheduler } from './services/scheduler';
import { setOnAgentFinish, stopAllProcesses } from './services/process-manager';
import { triggerControllerAgent } from './services/controller';
import { stopAllSchedulers } from './services/scheduler';
import { killAllPtySessions } from './services/terminal';
import { clearAllPtyCleanupTimers } from './services/websocket';
import { Agent, Project } from './types';

export interface AppOptions {
  port?: number;
  host?: string;
  logger?: boolean;
}

export async function createApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;

  const fastify = Fastify({ logger: opts.logger ?? true });

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
          AND (assigned_to IS NULL OR assigned_to = 'all'
               OR assigned_to IN (SELECT id FROM agents WHERE project_id = ? AND is_controller = 1))
          LIMIT 1
        `).get(project.id, project.id);

        if (needsController) {
          setTimeout(() => {
            try { triggerControllerAgent(project); } catch (e) { fastify.log.error(e, 'Failed to trigger controller agent'); }
          }, 2000);
        }
      }
    } catch (e) {
      fastify.log.warn(e, 'Failed to handle agent finish (DB may be closed)');
    }
  });

  initializeScheduler();

  await fastify.listen({ port, host });
  return fastify;
}

export async function destroyApp(fastify: FastifyInstance): Promise<void> {
  stopAllSchedulers();
  stopAllProcesses();
  clearAllPtyCleanupTimers();
  killAllPtySessions();
  await fastify.close();
  closeDatabase();
}
