import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDatabase } from '../db/database';
import { loadAuthConfig, isValidSinglePasswordToken } from '../services/auth/config';
import { COOKIE_NAME, parseCookies } from '../services/auth/cookies';
import {
  isLocalhostBypassRequest,
  isLocalhostRequest,
  isLocalhostSafeRoute,
} from '../services/auth/localhost-bypass';
import { getRequestUser, isLegacyAuthUser } from '../services/auth/request';
import { isValidSessionToken } from '../services/auth/sessions';
import { hasAnyUsers } from '../services/auth/users';

function hasConfiguredUsers(): boolean {
  try {
    return hasAnyUsers(getDatabase());
  } catch {
    return false;
  }
}

function isValidAuthToken(token: string, authConfig = loadAuthConfig()): boolean {
  if (isValidSinglePasswordToken(token, authConfig)) return true;
  try {
    return isValidSessionToken(getDatabase(), token);
  } catch {
    return false;
  }
}

export function setupAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;

    if (process.env.HAICO_NO_AUTH === 'true') {
      return;
    }

    if (
      request.method === 'OPTIONS' ||
      url === '/login' ||
      url === '/setup' ||
      url === '/register' ||
      url.startsWith('/api/auth') ||
      url === '/favicon.ico'
    ) {
      return;
    }

    if (isLocalhostBypassRequest(request)) {
      return;
    }

    const authConfig = loadAuthConfig();
    if (!authConfig.passwordHash && !hasConfiguredUsers()) {
      if (url.startsWith('/api/') || url.startsWith('/ws')) {
        reply.status(401).send({ error: 'No authentication configured. Visit /register to create the first account.' });
      } else {
        reply.redirect('/register');
      }
      return;
    }

    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token && isValidAuthToken(token, authConfig)) return;

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);
      if (isValidAuthToken(bearerToken, authConfig)) return;
    }

    const queryToken = (request.query as Record<string, string>)?.token;
    if (queryToken && isValidAuthToken(queryToken, authConfig)) return;

    if (url.startsWith('/public/') || url.startsWith('/css/') || url.startsWith('/js/') || url.startsWith('/vendor/')) {
      return;
    }

    if (!url.startsWith('/api/') && !url.startsWith('/ws')) {
      return reply.redirect('/login');
    }

    reply.status(401).send({ error: 'Unauthorized' });
  });
}

export {
  getRequestUser,
  isLegacyAuthUser,
  isLocalhostBypassRequest,
  isLocalhostRequest,
  isLocalhostSafeRoute,
};
