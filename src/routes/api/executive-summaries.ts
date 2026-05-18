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
import { getProjectRequestContext } from '../../middleware/request-context';
import { requireProjectAccess } from '../../services/project-access';

export function registerExecutiveSummaryRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { pid: string };
    Querystring: ListExecutiveSummariesFilters;
  }>('/projects/:pid/executive-summaries', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

    return listExecutiveSummaries(db, request.params.pid, request.query);
  });

  fastify.get<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      return getExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );

  fastify.post<{
    Params: { pid: string };
    Body: CreateExecutiveSummaryInput;
  }>('/projects/:pid/executive-summaries', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

    const summary = createExecutiveSummary(db, request.params.pid, request.body || {});
    return reply.code(201).send(summary);
  });

  fastify.put<{
    Params: { pid: string; sid: string };
    Body: UpdateExecutiveSummaryInput;
  }>('/projects/:pid/executive-summaries/:sid', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

    return updateExecutiveSummary(db, request.params.pid, request.params.sid, request.body || {});
  });

  fastify.delete<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      return deleteExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );

  fastify.put<{
    Params: { pid: string; sid: string; bid: string };
    Body: UpdateExecutiveSummaryBlockInput;
  }>('/projects/:pid/executive-summaries/:sid/blocks/:bid', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

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
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

    const block = createExecutiveSummaryBlock(db, request.params.pid, request.params.sid, request.body || {});
    return reply.code(201).send(block);
  });

  fastify.delete<{ Params: { pid: string; sid: string; bid: string } }>(
    '/projects/:pid/executive-summaries/:sid/blocks/:bid',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      return deleteExecutiveSummaryBlock(db, request.params.pid, request.params.sid, request.params.bid);
    }
  );

  fastify.post<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid/generate',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      return generateExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );

  fastify.post<{ Params: { pid: string; sid: string } }>(
    '/projects/:pid/executive-summaries/:sid/finalize',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      return finalizeExecutiveSummary(db, request.params.pid, request.params.sid);
    }
  );
}
