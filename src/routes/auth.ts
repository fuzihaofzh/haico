import { FastifyInstance } from 'fastify';
import { getDatabase } from '../db/database';
import { buildAuthCookie, buildClearAuthCookie, COOKIE_NAME, parseCookies } from '../services/auth/cookies';
import { createSession, deleteSessionByToken } from '../services/auth/sessions';
import {
  authenticateUser,
  changeUserPassword,
  DEFAULT_ADMIN_USERNAME,
  deleteUser,
  hasAnyUsers,
  listUsers,
  registerUser,
  updateUserRole,
  validateRegistrationInput,
} from '../services/auth/users';

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/change-password', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });

    const body = request.body as { current?: string; password?: string } | null;
    if (!body?.current) return reply.status(400).send({ error: 'Current password is required' });
    if (!body.password || body.password.length < 4) {
      return reply.status(400).send({ error: 'New password must be at least 4 characters' });
    }

    const db = getDatabase();
    const changed = changeUserPassword(db, user.id, body.current, body.password);
    if (changed === 'invalid-current') return reply.status(401).send({ error: 'Current password is incorrect' });
    if (!changed) return reply.status(404).send({ error: 'User not found' });

    const session = createSession(db, user.id);
    reply.header('Set-Cookie', buildAuthCookie(session.token));
    reply.send({ ok: true, token: session.token });
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
    const usersExist = hasAnyUsers(db);
    const callerUser = request.user;
    if (usersExist && (!callerUser || callerUser.role !== 'admin')) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const user = registerUser(db, body!);
    if (user === 'duplicate') return reply.status(409).send({ error: 'Username already taken' });

    if (!usersExist) {
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
    const target = getDatabase().prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
    if (target?.username === DEFAULT_ADMIN_USERNAME && role && role !== 'admin') {
      return reply.status(400).send({ error: 'Default admin cannot be demoted' });
    }

    const updated = updateUserRole(getDatabase(), id, role);
    if (!updated) return reply.status(404).send({ error: 'User not found' });
    return { user: updated };
  });

  app.delete('/auth/users/:id', async (request, reply) => {
    const user = request.user;
    if (!user || user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });

    const { id } = request.params as { id: string };
    if (id === user.id) return reply.status(400).send({ error: 'Cannot delete yourself' });

    const result = deleteUser(getDatabase(), id);
    if (result === 'not-found') return reply.status(404).send({ error: 'User not found' });
    if (result === 'protected') return reply.status(400).send({ error: 'Default admin cannot be deleted' });
    return { ok: true };
  });
}
