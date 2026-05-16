import { FastifyRequest } from 'fastify';
import { getDatabase } from '../../db/database';
import { User } from '../../types';
import { loadAuthConfig } from './config';
import { COOKIE_NAME, parseCookies } from './cookies';
import { getUserBySessionToken } from './sessions';

export function isLegacyAuthUser(user: User | null | undefined): boolean {
  return !!user && user.id === 'legacy';
}

export function getRequestToken(request: FastifyRequest): string | null {
  const cookies = parseCookies(request.headers.cookie);
  let token = cookies[COOKIE_NAME];

  if (!token) {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }

  return token || null;
}

export function getRequestUser(request: FastifyRequest): User | null {
  try {
    const token = getRequestToken(request);
    if (!token) return null;

    const db = getDatabase();
    const user = getUserBySessionToken(db, token);
    if (user) return user;

    const currentAuthConfig = loadAuthConfig();
    if (currentAuthConfig.passwordHash && token === currentAuthConfig.passwordHash) {
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
      } as User;
    }

    return null;
  } catch {
    return null;
  }
}
