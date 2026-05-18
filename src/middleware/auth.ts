import { FastifyInstance, FastifyRequest } from 'fastify';
import { getDatabase } from '../db/database';
import { loadAuthConfig, isValidSinglePasswordToken } from '../services/auth/config';
import { COOKIE_NAME, parseCookies } from '../services/auth/cookies';
import {
  isLocalhostRequest,
  isLocalhostSafeRoute,
} from '../services/auth/localhost-bypass';
import { isLegacyAuthUser } from '../services/auth/request';
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
    localhostBypass: boolean;
  }
}

function hasConfiguredUsers(): boolean {
  try {
    return hasAnyUsers(getDatabase());
  } catch {
    return false;
  }
}

function getLegacyAuthUser(): User {
  return {
    id: 'legacy',
    username: 'admin',
    email: '',
    password_hash: '',
    password_salt: '',
    display_name: 'Admin',
    role: 'admin',
    created_at: '',
    last_login_at: null,
  };
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

function getUserForToken(token: string, authConfig = loadAuthConfig()): User | null {
  try {
    const user = getUserBySessionToken(getDatabase(), token);
    if (user) return user;
  } catch {
    return null;
  }

  if (isValidSinglePasswordToken(token, authConfig)) {
    return getLegacyAuthUser();
  }

  return null;
}

function isPublicAuthRoute(url: string): boolean {
  return url === '/login'
    || url === '/setup'
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
    request.localhostBypass = isLocalhostRequest(request.ip) && isLocalhostSafeRoute(request.method, url);

    const authConfig = loadAuthConfig();
    const token = getRequestToken(request);
    if (token) {
      request.user = getUserForToken(token, authConfig);
    }

    if (process.env.HAICO_NO_AUTH === 'true') {
      return;
    }

    if (request.method === 'OPTIONS' || isPublicAuthRoute(url)) {
      return;
    }

    if (request.localhostBypass) {
      return;
    }

    if (!authConfig.passwordHash && !hasConfiguredUsers()) {
      throw new NoAuthenticationConfiguredError();
    }

    if (request.user) return;

    throw new AuthenticationRequiredError();
  });
}

export {
  isLegacyAuthUser,
  isLocalhostRequest,
  isLocalhostSafeRoute,
};
