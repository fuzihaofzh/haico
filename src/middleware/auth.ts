import { FastifyInstance, FastifyRequest } from 'fastify';
import { getDatabase } from '../db/database';
import { COOKIE_NAME, parseCookies } from '../services/auth/cookies';
import { getUserBySessionToken } from '../services/auth/sessions';
import { hasAnyUsers } from '../services/auth/users';
import {
  AuthenticationRequiredError,
  NoAuthenticationConfiguredError,
} from '../services/auth/errors';
import { User } from '../types';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

function hasConfiguredUsers(): boolean {
  try {
    return hasAnyUsers(getDatabase());
  } catch {
    return false;
  }
}

function getQueryToken(query: unknown): string | null {
  const value = (query as Record<string, string | string[] | undefined> | null)?.token;
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function getRequestToken(request: FastifyRequest): string | null {
  const cookies = parseCookies(request.headers.cookie);
  let token = cookies[COOKIE_NAME];

  if (!token) {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }

  return token || getQueryToken(request.query);
}

function getUserForToken(token: string): User | null {
  try {
    return getUserBySessionToken(getDatabase(), token);
  } catch {
    return null;
  }
}

function isPublicAuthRoute(url: string): boolean {
  return url === '/login'
    || url === '/register'
    || url.startsWith('/api/auth')
    || url === '/favicon.ico'
    || url.startsWith('/public/')
    || url.startsWith('/css/')
    || url.startsWith('/js/')
    || url.startsWith('/vendor/');
}

export function setupAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const url = request.url;
    request.user = null;

    const token = getRequestToken(request);
    if (token) {
      request.user = getUserForToken(token);
    }

    if (request.method === 'OPTIONS' || isPublicAuthRoute(url)) {
      return;
    }

    if (!hasConfiguredUsers()) {
      throw new NoAuthenticationConfiguredError();
    }

    if (request.user) return;

    throw new AuthenticationRequiredError();
  });
}
