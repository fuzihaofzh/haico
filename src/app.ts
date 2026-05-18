import Fastify, { FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { parse as parseQueryString } from 'querystring';
import { config } from './config';
import { getDatabase, closeDatabase } from './db/database';
import { registerRoutes } from './routes/route';
import { initializeScheduler, stopAllSchedulers } from './scheduler';
import { setOnAgentFinish, stopAllProcesses } from './services/process-manager';
import { autoStartAgentForDispatchableIssues } from './services/issue/agent-autostart';
import { enqueueControllerTrigger, clearCoalescingTimers } from './services/controller';
import { killAllPtySessions } from './services/terminal';
import { clearAllPtyCleanupTimers, handleWebSocketError } from './realtime';
import { setupErrorHandler } from './middleware/error-handler';
import { Agent, Project } from './types';
import { loggerOptions } from './logger';

export interface AppOptions {
  port?: number;
  host?: string;
  logger?: boolean;
  skipScheduler?: boolean;
}

export async function createApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;

  const fastify = Fastify({ logger: opts.logger === false ? false : loggerOptions });
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('localhostBypass', false);
  setupErrorHandler(fastify);

  await fastify.register(fastifyCompress, {
    global: true,
    encodings: ['gzip', 'deflate', 'br'],
  });
  await fastify.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, parseQueryString(typeof body === 'string' ? body : body.toString('utf-8')));
  });
  await fastify.register(fastifyWebsocket, {
    errorHandler(error, socket, request) {
      handleWebSocketError(socket, error, {
        request,
        defaultCode: 'websocket_handler_error',
      });
    },
  });
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/',
    maxAge: '1h',
  });

  await registerRoutes(fastify);

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
            fastify.log.info({
              projectId: project.id,
              agentId: agent.id,
              currentBatchCount: restartResult.currentBatchIssueNumbers.length,
              activeIssueCount: restartResult.activeIssueCount,
            }, 'agent.finish.immediate_restart');
            return;
          }

          if (restartResult.activeIssueCount > 0) {
            fastify.log.debug({
              projectId: project.id,
              agentId: agent.id,
              activeIssueCount: restartResult.activeIssueCount,
              reason: restartResult.reason,
            }, 'agent.finish.restart_suppressed');
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
      fastify.log.warn({ err: e }, 'agent.finish.handler_failed');
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
