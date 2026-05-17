import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import {
  createExecutiveSummary,
  CreateExecutiveSummaryBlockInput,
  createExecutiveSummaryBlock,
  CreateExecutiveSummaryInput,
  deleteExecutiveSummary,
  deleteExecutiveSummaryBlock,
  finalizeExecutiveSummary,
  generateExecutiveSummary,
  getExecutiveSummary,
  listExecutiveSummaries,
  ListExecutiveSummariesFilters,
  updateExecutiveSummary,
  UpdateExecutiveSummaryBlockInput,
  updateExecutiveSummaryBlock,
  UpdateExecutiveSummaryInput,
} from '../../services/executive-summaries';
import { ensureProjectAccess } from '../../services/project-access';

export function registerExecutiveSummaryRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { pid: string };
    Querystring: ListExecutiveSummariesFilters;
  }>('/projects/:pid/executive-summaries', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;

    return listExecutiveSummaries(db, request.params.pid, request.query);
  });

  fastify.get<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;

      return getExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );

  fastify.post<{
    Params: { pid: string };
    Body: CreateExecutiveSummaryInput;
  }>('/projects/:pid/executive-summaries', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;

    const summary = createExecutiveSummary(db, request.params.pid, request.body || {});
    return reply.code(201).send(summary);
  });

  fastify.put<{
    Params: { pid: string; sid: string };
    Body: UpdateExecutiveSummaryInput;
  }>('/projects/:pid/executive-summaries/:sid', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;

    return updateExecutiveSummary(db, request.params.pid, request.params.sid, request.body || {});
  });

  fastify.delete<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;

      return deleteExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );

  fastify.put<{
    Params: { pid: string; sid: string; bid: string };
    Body: UpdateExecutiveSummaryBlockInput;
  }>('/projects/:pid/executive-summaries/:sid/blocks/:bid', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;

    return updateExecutiveSummaryBlock(
      db,
      request.params.pid,
      request.params.sid,
      request.params.bid,
      request.body || {}
    );
  });

  fastify.post<{
    Params: { pid: string; sid: string };
    Body: CreateExecutiveSummaryBlockInput;
  }>('/projects/:pid/executive-summaries/:sid/blocks', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;

    const block = createExecutiveSummaryBlock(db, request.params.pid, request.params.sid, request.body || {});
    return reply.code(201).send(block);
  });

  fastify.delete<{ Params: { pid: string; sid: string; bid: string } }>(
    '/projects/:pid/executive-summaries/:sid/blocks/:bid',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;

      return deleteExecutiveSummaryBlock(db, request.params.pid, request.params.sid, request.params.bid);
    }
  );

  fastify.post<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid/generate',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;

      return generateExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );

  fastify.post<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid/finalize',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;

      return finalizeExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );
}
