import type { FastifyInstance } from 'fastify';
import { getUnexpectedErrorMessage, mapErrorToHttp } from '../errors/error-mapper';

function shouldRedirect(requestUrl: string, method: string, redirect: string | undefined): redirect is string {
  if (!redirect) return false;
  if (method !== 'GET') return false;
  if (requestUrl.startsWith('/api/') || requestUrl.startsWith('/ws')) return false;
  return true;
}

export function setupErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, request, reply) => {
    const mapped = mapErrorToHttp(error);
    const statusCode = mapped?.statusCode || 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed');
    } else {
      request.log.debug({ err: error, statusCode }, 'Request failed');
    }

    const message = mapped
      ? mapped.message
      : process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : getUnexpectedErrorMessage(error);

    if (shouldRedirect(request.url, request.method, mapped?.redirect)) {
      return reply.redirect(mapped.redirect);
    }

    return reply.code(statusCode).send({ error: message, ...(mapped?.extra || {}) });
  });
}
