import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { countPendingApprovals, createApproval, CreateApprovalInput, decideApproval, DecideApprovalInput, getApproval, listApprovals, ListApprovalsFilters } from '../../services/approvals';
import { listAccessibleProjectIds } from '../../services/project-access';
import { getProjectRequestContext } from '../../middleware/request-context';
import { getProjectWorkflowStatus } from '../../services/workflow-status';
import { requireProjectAccessPrehandler, requireEntityAccessPrehandler } from '../prehandlers';

export function registerApprovalRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { pid: string }; Querystring: ListApprovalsFilters }>(
    '/projects/:pid/approvals',
    { preHandler: [requireProjectAccessPrehandler()] },
    async (request, reply) => {
      const db = getDatabase();
      return listApprovals(db, request.params.pid, request.query);
    }
  );

  fastify.get('/approvals/pending-count', async (request) => {
    const db = getDatabase();
    const { user } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user);
    return { count: countPendingApprovals(db, projectIds) };
  });

  fastify.post<{ Params: { pid: string }; Body: CreateApprovalInput }>(
    '/projects/:pid/approvals',
    { preHandler: [requireProjectAccessPrehandler()] },
    async (request, reply) => {
      const db = getDatabase();
      const approval = createApproval(db, request.params.pid, request.body || {});
      return reply.code(201).send(approval);
    }
  );

  fastify.put<{ Params: { id: string }; Body: DecideApprovalInput }>(
    '/approvals/:id',
    { preHandler: [requireEntityAccessPrehandler('approval')] },
    async (request, reply) => {
      const db = getDatabase();
      return decideApproval(db, request.params.id, request.body || {});
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/approvals/:id',
    { preHandler: [requireEntityAccessPrehandler('approval')] },
    async (request, reply) => {
      const db = getDatabase();
      return getApproval(db, request.params.id);
    }
  );

  fastify.get<{ Params: { pid: string } }>(
    '/projects/:pid/workflow-status',
    { preHandler: [requireProjectAccessPrehandler()] },
    async (request, reply) => {
      const db = getDatabase();
      return getProjectWorkflowStatus(db, request.params.pid);
    }
  );
}
