import { config } from './config';
import { createApp, destroyApp } from './app';
import logger from './logger';

async function main() {
  const fastify = await createApp({
    port: config.port,
    host: config.host,
    logger: true,
  });

  logger.info(`Argus server running at http://${config.host}:${config.port}`);

  const shutdown = () => {
    logger.info('Shutting down...');
    destroyApp(fastify).then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
