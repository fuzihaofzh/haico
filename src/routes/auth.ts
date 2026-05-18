import { FastifyInstance } from 'fastify';
import logger from '../logger';
import { getDatabase } from '../db/database';
import { checkSinglePassword, loadAuthConfig, setSinglePassword } from '../services/auth/config';
import { buildAuthCookie, buildClearAuthCookie, COOKIE_NAME, parseCookies } from '../services/auth/cookies';
import { createSession, deleteSessionByToken } from '../services/auth/sessions';
import {
  authenticateUser,
  deleteUser,
  listUsers,
  registerUser,
  updateUserRole,
  validateRegistrationInput,
} from '../services/auth/users';
import { isLegacySha256 } from '../services/auth/password';

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/setup', async (request, reply) => {
    const authConfig = loadAuthConfig();
    if (authConfig.passwordHash) return reply.status(403).send({ error: 'Password already set' });

    const body = request.body as { password?: string } | null;
    if (!body?.password || body.password.length < 4) {
      return reply.status(400).send({ error: 'Password must be at least 4 characters' });
    }

    const nextConfig = setSinglePassword(body.password);
    logger.info('Password has been set');
    reply.header('Set-Cookie', buildAuthCookie(nextConfig.passwordHash!));
    reply.send({ ok: true });
  });

  app.post('/auth', async (request, reply) => {
    const authConfig = loadAuthConfig();
    if (!authConfig.passwordHash) return reply.status(400).send({ error: 'No password configured' });

    const body = request.body as { password?: string } | null;
    if (body?.password && checkSinglePassword(body.password, authConfig)) {
      let nextConfig = authConfig;
      if (isLegacySha256(authConfig)) {
        nextConfig = setSinglePassword(body.password);
        logger.info('Migrated password hash from SHA-256 to scrypt');
      }
      reply.header('Set-Cookie', buildAuthCookie(nextConfig.passwordHash!));
      reply.send({ ok: true, token: nextConfig.passwordHash });
    } else {
      reply.status(401).send({ error: 'Invalid password' });
    }
  });

  app.post('/auth/change-password', async (request, reply) => {
    const authConfig = loadAuthConfig();
    if (!authConfig.passwordHash) return reply.status(400).send({ error: 'No password configured' });

    const body = request.body as { current?: string; password?: string } | null;
    if (!body?.current || !checkSinglePassword(body.current, authConfig)) {
      return reply.status(401).send({ error: 'Current password is incorrect' });
    }
    if (!body.password || body.password.length < 4) {
      return reply.status(400).send({ error: 'New password must be at least 4 characters' });
    }

    const nextConfig = setSinglePassword(body.password);
    logger.info('Password has been changed');
    reply.header('Set-Cookie', buildAuthCookie(nextConfig.passwordHash!));
    reply.send({ ok: true });
  });

  app.post('/auth/logout', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token) {
      try {
        deleteSessionByToken(getDatabase(), token);
      } catch {}
    }
    reply.header('Set-Cookie', buildClearAuthCookie()).send({ ok: true });
  });

  app.post('/auth/register', async (request, reply) => {
    const body = request.body as { username?: string; email?: string; password?: string; display_name?: string } | null;
    const validationError = validateRegistrationInput(body || {});
    if (validationError) return reply.status(400).send({ error: validationError });

    const db = getDatabase();
    const user = registerUser(db, body!);
    if (user === 'duplicate') return reply.status(409).send({ error: 'Username already taken' });

    const callerUser = request.user;
    if (!callerUser) {
      const session = createSession(db, user.id);
      reply.header('Set-Cookie', buildAuthCookie(session.token));
      return reply.status(201).send({ ok: true, user, token: session.token });
    }

    return reply.status(201).send({ ok: true, user });
  });

  app.post('/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string } | null;
    if (!body?.username || !body?.password) {
      return reply.status(400).send({ error: 'username and password are required' });
    }

    const db = getDatabase();
    const user = authenticateUser(db, body.username, body.password);
    if (!user) return reply.status(401).send({ error: 'Invalid username or password' });

    const session = createSession(db, user.id);
    reply.header('Set-Cookie', buildAuthCookie(session.token));
    return {
      ok: true,
      token: session.token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
      },
    };
  });

  app.get('/auth/me', async (request, reply) => {
    const user = request.user;
    if (user) {
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        created_at: user.created_at,
      };
    }
    return reply.status(401).send({ error: 'Not authenticated' });
  });

  app.get('/auth/users', async (request, reply) => {
    const user = request.user;
    if (!user || user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
    return { users: listUsers(getDatabase()) };
  });

  app.put('/auth/users/:id', async (request, reply) => {
    const user = request.user;
    if (!user || user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });

    const { id } = request.params as { id: string };
    const { role } = request.body as { role?: string };
    if (id === user.id) return reply.status(400).send({ error: 'Cannot change your own role' });
    if (role && !['admin', 'member'].includes(role)) return reply.status(400).send({ error: 'Invalid role' });

    const updated = updateUserRole(getDatabase(), id, role);
    if (!updated) return reply.status(404).send({ error: 'User not found' });
    return { user: updated };
  });

  app.delete('/auth/users/:id', async (request, reply) => {
    const user = request.user;
    if (!user || user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });

    const { id } = request.params as { id: string };
    if (id === user.id) return reply.status(400).send({ error: 'Cannot delete yourself' });

    if (!deleteUser(getDatabase(), id)) return reply.status(404).send({ error: 'User not found' });
    return { ok: true };
  });
}
