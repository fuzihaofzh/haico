import type { FastifyInstance } from 'fastify';
import { getUnexpectedErrorMessage, mapErrorToHttp } from '../errors/error-mapper';

export function setupErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, request, reply) => {
    const mapped = mapErrorToHttp(error);
    const statusCode = mapped?.statusCode || 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed');
    } else {
      request.log.info({ err: error }, 'Request failed');
    }

    const message = mapped
      ? mapped.message
      : process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : getUnexpectedErrorMessage(error);

    return reply.code(statusCode).send({ error: message, ...(mapped?.extra || {}) });
  });
}
