import { FastifyInstance } from 'fastify';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import { isSinglePasswordConfigured } from '../services/auth/config';
import { hasAnyUsers } from '../services/auth/users';

export function registerUIRoutes(fastify: FastifyInstance): void {
  // Resolve public dir relative to project root (works from both src/ and dist/)
  const publicDir = path.join(__dirname, '..', '..', 'public');

  function serveHtml(file: string) {
    const filePath = path.join(publicDir, file);
    return fs.readFileSync(filePath, 'utf-8');
  }

  fastify.get('/', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('index.html'));
  });

  fastify.get('/setup', async (_request, reply) => {
    if (isSinglePasswordConfigured()) return reply.redirect('/login');
    return reply.type('text/html').send(serveHtml('setup.html'));
  });

  fastify.get('/login', async (_request, reply) => {
    let usersConfigured = false;
    try {
      usersConfigured = hasAnyUsers(getDatabase());
    } catch {}
    if (!isSinglePasswordConfigured() && !usersConfigured) return reply.redirect('/register');
    return reply.type('text/html').send(serveHtml('login.html'));
  });

  fastify.get('/register', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('register.html'));
  });

  fastify.get('/change-password', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('change-password.html'));
  });

  fastify.get('/projects/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project.html'));
  });

  fastify.get('/projects/:id/operations-console', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('operations-console.html'));
  });

  fastify.get('/agents/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('agent.html'));
  });

  fastify.get('/terminal', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('terminal.html'));
  });

  fastify.get('/issues/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/projects/:pid/issues/:num', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/admin/users', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('admin-users.html'));
  });
}
