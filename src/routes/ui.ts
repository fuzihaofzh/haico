import { FastifyInstance } from 'fastify';
import path from 'path';
import fs from 'fs';
import { isDefaultAdminEnabled } from '../services/auth/default-admin';
import { hasAnyUsers } from '../services/auth/users';
import { getDatabase } from '../db/database';

export function registerUIRoutes(fastify: FastifyInstance): void {
  // Resolve public dir relative to project root (works from both src/ and dist/)
  const publicDir = path.join(__dirname, '..', '..', 'public');

  function serveHtml(file: string) {
    const filePath = path.join(publicDir, file);
    return fs.readFileSync(filePath, 'utf-8');
  }

  const dashboardViews: Record<string, true> = { overview: true, inbox: true, chat: true, compose: true, projects: true, usage: true, settings: true };

  fastify.get<{ Querystring: { view?: string } }>('/', async (request, reply) => {
    // Priority: query param > user preference > default 'overview'
    const queryView = request.query.view;
    if (queryView && queryView in dashboardViews) {
      return reply.redirect('/' + String(queryView));
    }
    try {
      const userId = request.user?.id;
      if (userId) {
        const db = getDatabase();
        const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, 'default_landing_page') as { value: string } | undefined;
        if (row?.value && row.value in dashboardViews) {
          return reply.redirect('/' + row.value);
        }
      }
    } catch {}
    return reply.redirect('/overview');
  });

  fastify.get('/overview', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('overview.html'));
  });

  fastify.get('/inbox', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('inbox.html'));
  });

  fastify.get('/chat', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('chat.html'));
  });

  fastify.get('/compose', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('compose.html'));
  });
  fastify.get('/issue/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/projects', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('projects.html'));
  });

  fastify.get('/usage', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('usage.html'));
  });

  fastify.get('/settings', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('settings/general.html'));
  });

  fastify.get('/settings/agent-tools', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('settings/agent-tools.html'));
  });

  fastify.get('/login', async (request, reply) => {
    let usersConfigured = false;
    try {
      usersConfigured = hasAnyUsers(getDatabase());
    } catch {}
    if (!usersConfigured) return reply.redirect('/register');
    const manual = (request.query as { manual?: string | string[] } | null)?.manual;
    const manualLogin = Array.isArray(manual) ? manual[0] === '1' : manual === '1';
    if (isDefaultAdminEnabled() && !manualLogin) return reply.redirect('/auto-login');
    return reply.type('text/html').send(serveHtml('login.html'));
  });

  fastify.get('/auto-login', async (_request, reply) => {
    if (!isDefaultAdminEnabled()) return reply.redirect('/login');
    return reply.type('text/html').send(serveHtml('auto-login.html'));
  });

  fastify.get('/register', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('register.html'));
  });

  fastify.get('/change-password', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('change-password.html'));
  });

  fastify.get('/projects/new', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('projects-new.html'));
  });

  fastify.get('/project/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/overview.html'));
  });

  fastify.get('/project/:id/agents', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/agents.html'));
  });

  fastify.get('/project/:id/issues', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/issues.html'));
  });

  fastify.get('/project/:id/issues/new', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/issue-new.html'));
  });

  fastify.get('/project/:id/activity', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/activity.html'));
  });

  fastify.get('/project/:id/git', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/git.html'));
  });

  fastify.get('/project/:id/knowledge', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/knowledge.html'));
  });

  fastify.get('/project/:id/knowledge/new', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/knowledge-edit.html'));
  });

  fastify.get('/project/:id/knowledge/:kid/edit', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/knowledge-edit.html'));
  });

  fastify.get('/project/:id/files', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/files.html'));
  });

  fastify.get('/project/:id/workflow', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/workflow.html'));
  });

  fastify.get('/project/:id/sharing', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/sharing.html'));
  });

  fastify.get('/project/:id/operations-console', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('operations-console.html'));
  });

  fastify.get('/agents/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('agent.html'));
  });

  fastify.get('/project/:pid/agent/:id/edit', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('agent-edit.html'));
  });
  fastify.get('/project/:pid/agent/new/edit', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('agent-edit.html'));
  });

  fastify.get('/terminal', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('terminal.html'));
  });

  fastify.get('/issues/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/project/:pid/issues/:num', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/admin', async (_request, reply) => {
    return reply.redirect('/admin/users');
  });

  const adminPages: Record<string, string> = {
    '/admin/users': 'admin-users.html',
    '/admin/global-settings': 'admin-global-settings.html',
    '/admin/system': 'admin-system.html',
  };
  for (const [path, file] of Object.entries(adminPages)) {
    fastify.get(path, async (request, reply) => {
      if (!request.user || request.user.role !== 'admin') {
        return reply.redirect('/overview');
      }
      return reply.type('text/html').send(serveHtml(file));
    });
  }
}
