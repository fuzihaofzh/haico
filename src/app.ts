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
import { stopAllCliTaskRuns } from './services/executors/cli-executor';
import { clearCoalescingTimers } from './services/controller';
import { killAllPtySessions } from './services/terminal';
import { clearAllPtyCleanupTimers, handleWebSocketError } from './realtime';
import { setupErrorHandler } from './middleware/error-handler';
import { bootstrapDefaultAdmin } from './services/auth/default-admin';
import { registerAllSubscribers, clearCoalescingTimers as clearEventCoalescingTimers } from './events';
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
    maxAge: config.isProduction ? '1h' : 0,
  });

  const db = getDatabase();
  bootstrapDefaultAdmin(db);

  registerAllSubscribers();

  await registerRoutes(fastify);

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
  clearCoalescingTimers();
  clearEventCoalescingTimers();

  stopAllSchedulers();
  await stopAllCliTaskRuns();
  clearAllPtyCleanupTimers();
  killAllPtySessions();
  await fastify.close();
  // Unref the underlying HTTP server so it doesn't keep the event loop alive
  // after close (Fastify's close() stops listening but the handle remains ref'd)
  fastify.server.unref();
  closeDatabase();
}
