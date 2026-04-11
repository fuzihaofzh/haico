import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { buildPromotionPreview, getPromotionBuilderSeed, PromotionBuilderDraft } from '../services/promotion-builder';

const publicDir = path.join(__dirname, '../../public');

export function registerPromotionBuilderRoutes(app: FastifyInstance) {
  app.get('/ops/promotion-builder', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(readPublicFile('promotion-builder.html'));
  });

  app.get('/ops/promotion-builder.css', async (_request, reply) => {
    return reply.type('text/css; charset=utf-8').send(readPublicFile('promotion-builder.css'));
  });

  app.get('/ops/promotion-builder.js', async (_request, reply) => {
    return reply.type('application/javascript; charset=utf-8').send(readPublicFile('promotion-builder.js'));
  });

  app.get('/api/campaigns/promotion-builder/defaults', async (_request, reply) => {
    return reply.send(getPromotionBuilderSeed());
  });

  app.post<{ Body: Partial<PromotionBuilderDraft> }>('/api/campaigns/promotion-builder/preview', async (request, reply) => {
    return reply.send(buildPromotionPreview(request.body ?? {}));
  });
}

function readPublicFile(filename: string): string {
  return fs.readFileSync(path.join(publicDir, filename), 'utf8');
}
