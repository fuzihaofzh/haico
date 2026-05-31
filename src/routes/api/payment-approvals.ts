import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { cancelPaymentApproval, CancelPaymentApprovalInput, createPaymentApproval, CreatePaymentApprovalInput, getPaymentApproval, listPaymentApprovals, ListPaymentApprovalsFilters, submitPaymentApprovalDecision, SubmitPaymentApprovalDecisionInput, validatePaymentApproval } from '../../services/payment-approvals';
import { requireProjectAccessPrehandler, requireEntityAccessPrehandler } from '../prehandlers';

export function registerPaymentApprovalRoutes(fastify: FastifyInstance): void {
  // Project-scoped payment approvals
  fastify.get<{
    Params: { pid: string };
    Querystring: ListPaymentApprovalsFilters;
  }>('/projects/:pid/payment-approvals', { preHandler: [requireProjectAccessPrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    return listPaymentApprovals(db, request.params.pid, request.query);
  });

  fastify.post<{
    Params: { pid: string };
    Body: CreatePaymentApprovalInput;
  }>('/projects/:pid/payment-approvals', { preHandler: [requireProjectAccessPrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    const approval = createPaymentApproval(db, request.params.pid, request.body || {});
    return reply.code(201).send(approval);
  });

  // Payment approval entity routes
  fastify.get<{ Params: { id: string } }>('/payment-approvals/:id', { preHandler: [requireEntityAccessPrehandler('payment-approval')] }, async (request, reply) => {
    const db = getDatabase();
    return getPaymentApproval(db, request.params.id);
  });

  fastify.post<{
    Params: { id: string };
    Body: SubmitPaymentApprovalDecisionInput;
  }>('/payment-approvals/:id/decisions', { preHandler: [requireEntityAccessPrehandler('payment-approval')] }, async (request, reply) => {
    const db = getDatabase();
    return submitPaymentApprovalDecision(db, request.params.id, request.body || {});
  });

  fastify.put<{
    Params: { id: string };
    Body: CancelPaymentApprovalInput;
  }>('/payment-approvals/:id/cancel', { preHandler: [requireEntityAccessPrehandler('payment-approval')] }, async (request, reply) => {
    const db = getDatabase();
    return cancelPaymentApproval(db, request.params.id, request.body || {});
  });

  fastify.get<{ Params: { id: string } }>('/payment-approvals/:id/validate', { preHandler: [requireEntityAccessPrehandler('payment-approval')] }, async (request, reply) => {
    const db = getDatabase();
    return validatePaymentApproval(db, request.params.id);
  });
}
