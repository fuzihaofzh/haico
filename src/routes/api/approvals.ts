import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import {
  countPendingApprovals,
  createApproval,
  CreateApprovalInput,
  decideApproval,
  DecideApprovalInput,
  getApproval,
  listApprovals,
  ListApprovalsFilters,
} from '../../services/approvals';
import {
  requireApprovalAccess,
  requireProjectAccess,
  listAccessibleProjectIds,
} from '../../services/project-access';
import { getProjectRequestContext } from '../../middleware/request-context';
import { getProjectWorkflowStatus } from '../../services/workflow-status';

export function registerApprovalRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { pid: string }; Querystring: ListApprovalsFilters }>(
    '/projects/:pid/approvals',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      return listApprovals(db, request.params.pid, request.query);
    }
  );

  fastify.get('/approvals/pending-count', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);
    return { count: countPendingApprovals(db, projectIds) };
  });

  fastify.post<{ Params: { pid: string }; Body: CreateApprovalInput }>(
    '/projects/:pid/approvals',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      const approval = createApproval(db, request.params.pid, request.body || {});
      return reply.code(201).send(approval);
    }
  );

  fastify.put<{ Params: { id: string }; Body: DecideApprovalInput }>(
    '/approvals/:id',
    async (request, reply) => {
      const db = getDatabase();
      requireApprovalAccess(db, getProjectRequestContext(request), request.params.id);

      return decideApproval(db, request.params.id, request.body || {});
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/approvals/:id',
    async (request, reply) => {
      const db = getDatabase();
      requireApprovalAccess(db, getProjectRequestContext(request), request.params.id);

      return getApproval(db, request.params.id);
    }
  );

  fastify.get<{ Params: { pid: string } }>(
    '/projects/:pid/workflow-status',
    async (request, reply) => {
      const db = getDatabase();
      requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);

      return getProjectWorkflowStatus(db, request.params.pid);
    }
  );
}
