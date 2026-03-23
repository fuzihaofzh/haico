import { FastifyInstance } from 'fastify';
import path from 'path';
import fs from 'fs';

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

  fastify.get('/projects/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project.html'));
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
}
