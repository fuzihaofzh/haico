import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../../db/database';
import { PaymentApprovalRequest } from '../../types';
import { broadcastToProject } from '../../services/websocket';
import {
  ensureProjectAccess,
} from '../../services/project-permissions';

/**
 * Dual-controller payment approval routing.
 *
 * Treasury best practice requires two independent controllers to approve
 * high-value payments before they can proceed. This module enforces:
 *
 * 1. Configurable required_approvals (default 2 for dual-controller).
 * 2. Separation of duties — the same person cannot approve twice, and the
 *    requester cannot approve their own payment.
 * 3. Any single rejection immediately rejects the entire request.
 * 4. The request auto-resolves to "approved" once enough approvals arrive.
 */

function enrichPaymentApproval(db: ReturnType<typeof getDatabase>, row: any) {
  const decisions = db.prepare(
    `SELECT id, decided_by, decision, note, created_at
     FROM payment_approval_decisions
     WHERE payment_approval_id = ?
     ORDER BY created_at ASC`
  ).all(row.id) as any[];

  const approvalCount = decisions.filter((d: any) => d.decision === 'approve').length;
  const rejectionCount = decisions.filter((d: any) => d.decision === 'reject').length;

  return {
    ...row,
    decisions,
    approval_count: approvalCount,
    rejection_count: rejectionCount,
    remaining_approvals: Math.max(0, (row.required_approvals || 2) - approvalCount),
  };
}

export function registerPaymentApprovalRoutes(fastify: FastifyInstance): void {

  // List payment approval requests for a project
  fastify.get<{ Params: { pid: string }; Querystring: { status?: string; limit?: string } }>(
    '/projects/:pid/payment-approvals',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const status = request.query.status;
      const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);

      let rows: any[];
      if (status) {
        rows = db.prepare(
          `SELECT * FROM payment_approval_requests
           WHERE project_id = ? AND status = ?
           ORDER BY created_at DESC LIMIT ?`
        ).all(pid, status, limit);
      } else {
        rows = db.prepare(
          `SELECT * FROM payment_approval_requests
           WHERE project_id = ?
           ORDER BY created_at DESC LIMIT ?`
        ).all(pid, limit);
      }

      return rows.map(r => enrichPaymentApproval(db, r));
    }
  );

  // Get single payment approval request
  fastify.get<{ Params: { id: string } }>(
    '/payment-approvals/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;

      const row = db.prepare(
        'SELECT * FROM payment_approval_requests WHERE id = ?'
      ).get(id) as any;

      if (!row) {
        return reply.code(404).send({ error: 'Payment approval request not found' });
      }
      return enrichPaymentApproval(db, row);
    }
  );

  // Create a payment approval request (dual-controller by default)
  fastify.post<{ Params: { pid: string }; Body: any }>(
    '/projects/:pid/payment-approvals',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const {
        requested_by, title, description, amount, currency,
        beneficiary, risk_level, required_approvals, issue_id,
      } = request.body as any;

      if (!requested_by || !title || amount == null) {
        return reply.code(400).send({ error: 'requested_by, title, and amount are required' });
      }
      if (typeof amount !== 'number' || amount <= 0) {
        return reply.code(400).send({ error: 'amount must be a positive number' });
      }

      const validRisk = ['low', 'medium', 'high', 'critical'].includes(risk_level) ? risk_level : 'high';
      const approvals = Math.max(1, Math.min(parseInt(required_approvals, 10) || 2, 10));

      const id = uuidv4();
      db.prepare(
        `INSERT INTO payment_approval_requests
         (id, project_id, issue_id, requested_by, title, description, amount, currency, beneficiary, risk_level, required_approvals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, pid, issue_id || null, requested_by, title,
        description || '', amount, currency || 'USD',
        beneficiary || '', validRisk, approvals
      );

      const created = db.prepare('SELECT * FROM payment_approval_requests WHERE id = ?').get(id) as PaymentApprovalRequest;

      broadcastToProject(pid, {
        type: 'payment_approval_created',
        projectId: pid,
        data: enrichPaymentApproval(db, created),
      });

      return reply.code(201).send(enrichPaymentApproval(db, created));
    }
  );

  // Submit a decision (approve or reject) on a payment approval request
  // Enforces separation-of-duties:
  //   - requester cannot approve their own payment
  //   - same person cannot decide twice
  //   - any rejection immediately rejects the whole request
  //   - once required_approvals approve decisions are collected, auto-approves
  fastify.post<{ Params: { id: string }; Body: any }>(
    '/payment-approvals/:id/decisions',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const { decided_by, decision, note } = request.body as any;

      if (!decided_by || !decision) {
        return reply.code(400).send({ error: 'decided_by and decision are required' });
      }
      if (!['approve', 'reject'].includes(decision)) {
        return reply.code(400).send({ error: 'decision must be "approve" or "reject"' });
      }

      const paymentReq = db.prepare(
        'SELECT * FROM payment_approval_requests WHERE id = ?'
      ).get(id) as PaymentApprovalRequest | undefined;

      if (!paymentReq) {
        return reply.code(404).send({ error: 'Payment approval request not found' });
      }
      if (paymentReq.status !== 'pending') {
        return reply.code(409).send({
          error: `Payment approval already resolved with status: ${paymentReq.status}`,
        });
      }

      // Separation of duties: requester cannot approve their own payment
      if (decision === 'approve' && decided_by === paymentReq.requested_by) {
        return reply.code(403).send({
          error: 'Separation of duties violation: requester cannot approve their own payment',
        });
      }

      // Check for duplicate decision from same person
      const existing = db.prepare(
        'SELECT id FROM payment_approval_decisions WHERE payment_approval_id = ? AND decided_by = ?'
      ).get(id, decided_by) as any;
      if (existing) {
        return reply.code(409).send({
          error: 'This controller has already submitted a decision for this payment',
        });
      }

      const decisionId = uuidv4();
      db.prepare(
        `INSERT INTO payment_approval_decisions (id, payment_approval_id, decided_by, decision, note)
         VALUES (?, ?, ?, ?, ?)`
      ).run(decisionId, id, decided_by, decision, note || '');

      broadcastToProject(paymentReq.project_id, {
        type: 'payment_approval_decided',
        projectId: paymentReq.project_id,
        data: { payment_approval_id: id, decided_by, decision, note: note || '' },
      });

      // Resolve: any rejection → reject; enough approvals → approve
      if (decision === 'reject') {
        db.prepare(
          `UPDATE payment_approval_requests SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?`
        ).run(id);

        const resolved = enrichPaymentApproval(db,
          db.prepare('SELECT * FROM payment_approval_requests WHERE id = ?').get(id)
        );

        broadcastToProject(paymentReq.project_id, {
          type: 'payment_approval_resolved',
          projectId: paymentReq.project_id,
          data: resolved,
        });
        return resolved;
      }

      // Count approvals after this one
      const approveCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM payment_approval_decisions
         WHERE payment_approval_id = ? AND decision = 'approve'`
      ).get(id) as any).cnt;

      if (approveCount >= paymentReq.required_approvals) {
        db.prepare(
          `UPDATE payment_approval_requests SET status = 'approved', resolved_at = datetime('now') WHERE id = ?`
        ).run(id);

        const resolved = enrichPaymentApproval(db,
          db.prepare('SELECT * FROM payment_approval_requests WHERE id = ?').get(id)
        );

        broadcastToProject(paymentReq.project_id, {
          type: 'payment_approval_resolved',
          projectId: paymentReq.project_id,
          data: resolved,
        });
        return resolved;
      }

      // Still pending — return current state
      return enrichPaymentApproval(db,
        db.prepare('SELECT * FROM payment_approval_requests WHERE id = ?').get(id)
      );
    }
  );

  // Cancel a payment approval request (only by the requester)
  fastify.put<{ Params: { id: string }; Body: any }>(
    '/payment-approvals/:id/cancel',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const { cancelled_by } = request.body as any;

      const paymentReq = db.prepare(
        'SELECT * FROM payment_approval_requests WHERE id = ?'
      ).get(id) as PaymentApprovalRequest | undefined;

      if (!paymentReq) {
        return reply.code(404).send({ error: 'Payment approval request not found' });
      }
      if (paymentReq.status !== 'pending') {
        return reply.code(409).send({ error: 'Only pending requests can be cancelled' });
      }
      if (cancelled_by !== paymentReq.requested_by) {
        return reply.code(403).send({ error: 'Only the requester can cancel a payment approval' });
      }

      db.prepare(
        `UPDATE payment_approval_requests SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?`
      ).run(id);

      const resolved = enrichPaymentApproval(db,
        db.prepare('SELECT * FROM payment_approval_requests WHERE id = ?').get(id)
      );

      broadcastToProject(paymentReq.project_id, {
        type: 'payment_approval_resolved',
        projectId: paymentReq.project_id,
        data: resolved,
      });

      return resolved;
    }
  );

  // Validation / audit endpoint: check if a payment approval's routing is valid
  fastify.get<{ Params: { id: string } }>(
    '/payment-approvals/:id/validate',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;

      const paymentReq = db.prepare(
        'SELECT * FROM payment_approval_requests WHERE id = ?'
      ).get(id) as any;

      if (!paymentReq) {
        return reply.code(404).send({ error: 'Payment approval request not found' });
      }

      const decisions = db.prepare(
        `SELECT decided_by, decision, created_at
         FROM payment_approval_decisions
         WHERE payment_approval_id = ?
         ORDER BY created_at ASC`
      ).all(id) as any[];

      const approvers = decisions.filter((d: any) => d.decision === 'approve').map((d: any) => d.decided_by);
      const uniqueApprovers = new Set(approvers);

      const violations: string[] = [];

      // Check: no duplicate approvers
      if (approvers.length !== uniqueApprovers.size) {
        violations.push('Duplicate approver detected — same controller approved more than once');
      }

      // Check: requester did not approve own payment
      if (uniqueApprovers.has(paymentReq.requested_by)) {
        violations.push('Separation of duties violation — requester approved their own payment');
      }

      // Check: enough approvals for resolved status
      if (paymentReq.status === 'approved' && uniqueApprovers.size < paymentReq.required_approvals) {
        violations.push(
          `Insufficient approvals: ${uniqueApprovers.size} of ${paymentReq.required_approvals} required`
        );
      }

      return {
        payment_approval_id: id,
        status: paymentReq.status,
        required_approvals: paymentReq.required_approvals,
        actual_unique_approvers: uniqueApprovers.size,
        decisions,
        is_valid: violations.length === 0,
        violations,
      };
    }
  );
}
