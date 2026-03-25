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
  registerUIRoutes(fastify);
  setupWebSocket(fastify);

  getDatabase();

  setOnAgentFinish((agent: Agent, exitCode: number | null) => {
    try {
      const db = getDatabase();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
      if (!project || project.status !== 'active') return;

      if (!agent.is_controller) {
        // Worker finished → trigger controller to check results
        setTimeout(() => {
          try { triggerControllerAgent(project); } catch (e) { fastify.log.error(e, 'Failed to trigger controller agent'); }
        }, 2000);
      } else {
        // Controller finished → check for pending quick commands that arrived while it was running
        const pending = db.prepare(
          "SELECT 1 FROM quick_commands WHERE project_id = ? AND status = 'pending' LIMIT 1"
        ).get(project.id);
        if (pending) {
          setTimeout(() => {
            try { triggerControllerAgent(project, true); } catch (e) { fastify.log.error(e, 'Failed to trigger controller for pending quick commands'); }
          }, 3000);
        }
      }
    } catch (e) {
      // DB may be closed during shutdown
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
