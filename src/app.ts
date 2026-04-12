import Fastify, { FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { config } from './config';
import { getDatabase, closeDatabase } from './db/database';
import { setupAuth } from './middleware/auth';
import { registerProjectRoutes } from './routes/projects';
import { registerAgentRoutes } from './routes/agents';
import { registerIssueRoutes } from './routes/issues';
import { registerUIRoutes } from './routes/ui';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerMessageRoutes } from './routes/messages';
import { registerCommandProfileRoutes } from './routes/command-profiles';
import { registerTemplateRoutes } from './routes/templates';
import { registerApprovalRoutes } from './routes/approvals';
import { registerExecutiveSummaryRoutes } from './routes/executive-summaries';
import { registerRemoteInstanceRoutes } from './routes/remote-instances';
import { setupWebSocket } from './services/websocket';
import { initializeScheduler } from './services/scheduler';
import { setOnAgentFinish, stopAllProcesses } from './services/process-manager';
import { autoStartAgentForDispatchableIssues } from './services/assigned-issue-autostart';
import { enqueueControllerTrigger, clearCoalescingTimers } from './services/controller';
import { stopAllSchedulers } from './services/scheduler';
import { killAllPtySessions } from './services/terminal';
import { clearAllPtyCleanupTimers } from './services/websocket';
import { Agent, Project } from './types';

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

  await fastify.register(fastifyCompress, {
    global: true,
    encodings: ['gzip', 'deflate', 'br'],
  });
  await fastify.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/',
    maxAge: '1h',
  });

  setupAuth(fastify);
  registerProjectRoutes(fastify);
  registerAgentRoutes(fastify);
  registerIssueRoutes(fastify);
  registerKnowledgeRoutes(fastify);
  registerMessageRoutes(fastify);
  registerCommandProfileRoutes(fastify);
  registerTemplateRoutes(fastify);
  registerApprovalRoutes(fastify);
  registerExecutiveSummaryRoutes(fastify);
  registerRemoteInstanceRoutes(fastify);
  registerUIRoutes(fastify);
  setupWebSocket(fastify);

  getDatabase();

  setOnAgentFinish((agent: Agent, exitCode: number | null) => {
    try {
      const db = getDatabase();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
      if (!project || project.status !== 'active') return;

      if (!agent.is_controller) {
        if (!agent.paused && agent.status === 'idle') {
          const restartResult = autoStartAgentForDispatchableIssues(db, project, agent, {
            source: 'agent-finish',
            allowStatuses: ['idle'],
          });

          if (restartResult.started) {
            fastify.log.info(
              `Worker "${agent.name}" finished and was immediately restarted for ${restartResult.currentBatchIssueNumbers.length}/${restartResult.activeIssueCount} dispatchable issue(s)`
            );
            return;
          }

          if (restartResult.activeIssueCount > 0) {
            fastify.log.info(
              `Worker "${agent.name}" finished with ${restartResult.activeIssueCount} dispatchable issue(s), but immediate restart was suppressed: ${restartResult.reason}`
            );
            return;
          }
        }

        // Worker finished — enqueue a normal-priority controller trigger.
        // The coalescing system will batch this with other events and the
        // necessity check in triggerControllerAgent will skip if there's nothing to do.
        enqueueControllerTrigger(project, {
          priority: 'normal',
          reason: `worker-finished:${agent.name}`,
        });
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
  // and process.env.HAICO_PORT so that system prompts and spawned agents get
  // the real port.
  const addr = fastify.server.address();
  if (addr && typeof addr === 'object' && addr.port) {
    config.port = addr.port;
    process.env.HAICO_PORT = String(addr.port);
  }

  return fastify;
}

export async function destroyApp(fastify: FastifyInstance): Promise<void> {
  // Clear onAgentFinish callback to prevent new async activity during shutdown
  setOnAgentFinish(null);
  // Cancel any pending coalescing timers
  clearCoalescingTimers();

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
