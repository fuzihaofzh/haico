import { config } from './config';
import { createApp, destroyApp } from './app';
import logger from './logger';

async function main() {
  const fastify = await createApp({
    port: config.port,
    host: config.host,
    logger: true,
  });

  logger.info(`HAICO server running at http://${config.host}:${config.port} (pid: ${process.pid})`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down... (pid: ${process.pid})`);
    destroyApp(fastify).then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => {
    logger.warn(`Received SIGHUP (pid: ${process.pid}) — ignoring`);
  });
}

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — process will exit');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection — process will exit');
  process.exit(1);
});

process.on('beforeExit', (code) => {
  logger.warn(`beforeExit event with code ${code} (pid: ${process.pid})`);
});

process.on('exit', (code) => {
  // This is synchronous-only — last chance to log
  console.error(`[HAICO] process.exit with code=${code} pid=${process.pid} at ${new Date().toISOString()}`);
});

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
