import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import {
  cancelPaymentApproval,
  CancelPaymentApprovalInput,
  createPaymentApproval,
  CreatePaymentApprovalInput,
  getPaymentApproval,
  listPaymentApprovals,
  ListPaymentApprovalsFilters,
  submitPaymentApprovalDecision,
  SubmitPaymentApprovalDecisionInput,
  validatePaymentApproval,
} from '../../services/payment-approvals';
import {
  ensurePaymentApprovalAccess,
  ensureProjectAccess,
} from '../../services/project-access';

export function registerPaymentApprovalRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { pid: string };
    Querystring: ListPaymentApprovalsFilters;
  }>('/projects/:pid/payment-approvals', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    return listPaymentApprovals(db, request.params.pid, request.query);
  });

  fastify.get<{ Params: { id: string } }>('/payment-approvals/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensurePaymentApprovalAccess(db, request, reply, request.params.id);
    if (!access) return;
    return getPaymentApproval(db, request.params.id);
  });

  fastify.post<{
    Params: { pid: string };
    Body: CreatePaymentApprovalInput;
  }>('/projects/:pid/payment-approvals', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    const approval = createPaymentApproval(db, request.params.pid, request.body || {});
    return reply.code(201).send(approval);
  });

  fastify.post<{
    Params: { id: string };
    Body: SubmitPaymentApprovalDecisionInput;
  }>('/payment-approvals/:id/decisions', async (request, reply) => {
    const db = getDatabase();
    const access = ensurePaymentApprovalAccess(db, request, reply, request.params.id);
    if (!access) return;
    return submitPaymentApprovalDecision(db, request.params.id, request.body || {});
  });

  fastify.put<{
    Params: { id: string };
    Body: CancelPaymentApprovalInput;
  }>('/payment-approvals/:id/cancel', async (request, reply) => {
    const db = getDatabase();
    const access = ensurePaymentApprovalAccess(db, request, reply, request.params.id);
    if (!access) return;
    return cancelPaymentApproval(db, request.params.id, request.body || {});
  });

  fastify.get<{ Params: { id: string } }>('/payment-approvals/:id/validate', async (request, reply) => {
    const db = getDatabase();
    const access = ensurePaymentApprovalAccess(db, request, reply, request.params.id);
    if (!access) return;
    return validatePaymentApproval(db, request.params.id);
  });
}
