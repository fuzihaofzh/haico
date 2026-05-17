import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { PaymentApprovalDecision, PaymentApprovalRequest } from '../../types';
import { broadcastToProject } from '../../realtime';
import {
  InvalidPaymentApprovalAmountError,
  InvalidPaymentApprovalDecisionError,
  MissingPaymentApprovalCancelFieldsError,
  MissingPaymentApprovalCreateFieldsError,
  MissingPaymentApprovalDecisionFieldsError,
  PaymentApprovalAlreadyResolvedError,
  PaymentApprovalCancelForbiddenError,
  PaymentApprovalCancelStatusConflictError,
  PaymentApprovalDuplicateDecisionError,
  PaymentApprovalNotFoundError,
  PaymentApprovalSelfApprovalError,
} from './errors';

const PAYMENT_APPROVAL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

export type PaymentApprovalRiskLevel = typeof PAYMENT_APPROVAL_RISK_LEVELS[number];
export type PaymentApprovalDecisionValue = PaymentApprovalDecision['decision'];

export interface EnrichedPaymentApproval extends PaymentApprovalRequest {
  decisions: PaymentApprovalDecision[];
  approval_count: number;
  rejection_count: number;
  remaining_approvals: number;
}

export interface ListPaymentApprovalsFilters {
  status?: string;
  limit?: string;
}

export interface CreatePaymentApprovalInput {
  requested_by?: unknown;
  title?: unknown;
  description?: unknown;
  amount?: unknown;
  currency?: unknown;
  beneficiary?: unknown;
  risk_level?: unknown;
  required_approvals?: unknown;
  issue_id?: unknown;
}

export interface SubmitPaymentApprovalDecisionInput {
  decided_by?: unknown;
  decision?: unknown;
  note?: unknown;
}

export interface CancelPaymentApprovalInput {
  cancelled_by?: unknown;
}

export interface PaymentApprovalValidationResult {
  payment_approval_id: string;
  status: PaymentApprovalRequest['status'];
  required_approvals: number;
  actual_unique_approvers: number;
  decisions: Array<Pick<PaymentApprovalDecision, 'decided_by' | 'decision' | 'created_at'>>;
  is_valid: boolean;
  violations: string[];
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeOptionalText(value: unknown): string {
  return String(value || '');
}

function normalizeNullableText(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizeRiskLevel(value: unknown): PaymentApprovalRiskLevel {
  const normalized = normalizeText(value);
  return (PAYMENT_APPROVAL_RISK_LEVELS as readonly string[]).includes(normalized)
    ? normalized as PaymentApprovalRiskLevel
    : 'high';
}

function normalizeRequiredApprovals(value: unknown): number {
  const parsed = typeof value === 'number'
    ? Math.trunc(value)
    : Number.parseInt(String(value || ''), 10);
  const approvals = Number.isFinite(parsed) ? parsed : 2;
  return Math.max(1, Math.min(approvals, 10));
}

function normalizeListLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function getPaymentApprovalRecordOrThrow(
  db: Database.Database,
  paymentApprovalId: string
): PaymentApprovalRequest {
  const row = db.prepare(
    'SELECT * FROM payment_approval_requests WHERE id = ?'
  ).get(paymentApprovalId) as PaymentApprovalRequest | undefined;
  if (!row) throw new PaymentApprovalNotFoundError();
  return row;
}

export function enrichPaymentApproval(
  db: Database.Database,
  row: PaymentApprovalRequest
): EnrichedPaymentApproval {
  const decisions = db.prepare(
    `SELECT id, payment_approval_id, decided_by, decision, note, created_at
     FROM payment_approval_decisions
     WHERE payment_approval_id = ?
     ORDER BY created_at ASC`
  ).all(row.id) as PaymentApprovalDecision[];

  const approvalCount = decisions.filter((decision) => decision.decision === 'approve').length;
  const rejectionCount = decisions.filter((decision) => decision.decision === 'reject').length;

  return {
    ...row,
    decisions,
    approval_count: approvalCount,
    rejection_count: rejectionCount,
    remaining_approvals: Math.max(0, (row.required_approvals || 2) - approvalCount),
  };
}

export function listPaymentApprovals(
  db: Database.Database,
  projectId: string,
  filters: ListPaymentApprovalsFilters = {}
): EnrichedPaymentApproval[] {
  const status = normalizeText(filters.status);
  const limit = normalizeListLimit(filters.limit);

  const rows = status
    ? db.prepare(
        `SELECT * FROM payment_approval_requests
         WHERE project_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(projectId, status, limit)
    : db.prepare(
        `SELECT * FROM payment_approval_requests
         WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(projectId, limit);

  return (rows as PaymentApprovalRequest[]).map((row) => enrichPaymentApproval(db, row));
}

export function getPaymentApproval(
  db: Database.Database,
  paymentApprovalId: string
): EnrichedPaymentApproval {
  return enrichPaymentApproval(db, getPaymentApprovalRecordOrThrow(db, paymentApprovalId));
}

export function createPaymentApproval(
  db: Database.Database,
  projectId: string,
  input: CreatePaymentApprovalInput
): EnrichedPaymentApproval {
  const requestedBy = normalizeText(input.requested_by);
  const title = normalizeText(input.title);

  if (!requestedBy || !title || input.amount == null) {
    throw new MissingPaymentApprovalCreateFieldsError();
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) {
    throw new InvalidPaymentApprovalAmountError();
  }

  const created = db.transaction(() => {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO payment_approval_requests
       (id, project_id, issue_id, requested_by, title, description, amount, currency, beneficiary, risk_level, required_approvals)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      projectId,
      normalizeNullableText(input.issue_id),
      requestedBy,
      title,
      normalizeOptionalText(input.description),
      input.amount,
      normalizeText(input.currency) || 'USD',
      normalizeOptionalText(input.beneficiary),
      normalizeRiskLevel(input.risk_level),
      normalizeRequiredApprovals(input.required_approvals)
    );

    return getPaymentApproval(db, id);
  })();

  broadcastToProject(projectId, {
    type: 'payment_approval_created',
    projectId,
    data: created,
  });

  return created;
}

export function submitPaymentApprovalDecision(
  db: Database.Database,
  paymentApprovalId: string,
  input: SubmitPaymentApprovalDecisionInput
): EnrichedPaymentApproval {
  const decidedBy = normalizeText(input.decided_by);
  const decision = normalizeText(input.decision);

  if (!decidedBy || !decision) {
    throw new MissingPaymentApprovalDecisionFieldsError();
  }
  if (decision !== 'approve' && decision !== 'reject') {
    throw new InvalidPaymentApprovalDecisionError();
  }

  const result = db.transaction(() => {
    const paymentApproval = getPaymentApprovalRecordOrThrow(db, paymentApprovalId);
    if (paymentApproval.status !== 'pending') {
      throw new PaymentApprovalAlreadyResolvedError(paymentApproval.status);
    }

    if (decision === 'approve' && decidedBy === paymentApproval.requested_by) {
      throw new PaymentApprovalSelfApprovalError();
    }

    const existing = db.prepare(
      'SELECT id FROM payment_approval_decisions WHERE payment_approval_id = ? AND decided_by = ?'
    ).get(paymentApprovalId, decidedBy) as { id: string } | undefined;
    if (existing) {
      throw new PaymentApprovalDuplicateDecisionError();
    }

    const note = normalizeOptionalText(input.note);
    db.prepare(
      `INSERT INTO payment_approval_decisions (id, payment_approval_id, decided_by, decision, note)
       VALUES (?, ?, ?, ?, ?)`
    ).run(uuidv4(), paymentApprovalId, decidedBy, decision, note);

    let resolved = false;
    if (decision === 'reject') {
      db.prepare(
        `UPDATE payment_approval_requests
         SET status = 'rejected', resolved_at = datetime('now')
         WHERE id = ?`
      ).run(paymentApprovalId);
      resolved = true;
    } else {
      const approveCount = (db.prepare(
        `SELECT COUNT(*) as count FROM payment_approval_decisions
         WHERE payment_approval_id = ? AND decision = 'approve'`
      ).get(paymentApprovalId) as { count: number }).count;

      if (approveCount >= paymentApproval.required_approvals) {
        db.prepare(
          `UPDATE payment_approval_requests
           SET status = 'approved', resolved_at = datetime('now')
           WHERE id = ?`
        ).run(paymentApprovalId);
        resolved = true;
      }
    }

    return {
      projectId: paymentApproval.project_id,
      decisionEvent: {
        payment_approval_id: paymentApprovalId,
        decided_by: decidedBy,
        decision,
        note,
      },
      resolved,
      approval: getPaymentApproval(db, paymentApprovalId),
    };
  })();

  broadcastToProject(result.projectId, {
    type: 'payment_approval_decided',
    projectId: result.projectId,
    data: result.decisionEvent,
  });

  if (result.resolved) {
    broadcastToProject(result.projectId, {
      type: 'payment_approval_resolved',
      projectId: result.projectId,
      data: result.approval,
    });
  }

  return result.approval;
}

export function cancelPaymentApproval(
  db: Database.Database,
  paymentApprovalId: string,
  input: CancelPaymentApprovalInput
): EnrichedPaymentApproval {
  const cancelledBy = normalizeText(input.cancelled_by);
  if (!cancelledBy) {
    throw new MissingPaymentApprovalCancelFieldsError();
  }

  const result = db.transaction(() => {
    const paymentApproval = getPaymentApprovalRecordOrThrow(db, paymentApprovalId);
    if (paymentApproval.status !== 'pending') {
      throw new PaymentApprovalCancelStatusConflictError();
    }
    if (cancelledBy !== paymentApproval.requested_by) {
      throw new PaymentApprovalCancelForbiddenError();
    }

    db.prepare(
      `UPDATE payment_approval_requests
       SET status = 'cancelled', resolved_at = datetime('now')
       WHERE id = ?`
    ).run(paymentApprovalId);

    return {
      projectId: paymentApproval.project_id,
      approval: getPaymentApproval(db, paymentApprovalId),
    };
  })();

  broadcastToProject(result.projectId, {
    type: 'payment_approval_resolved',
    projectId: result.projectId,
    data: result.approval,
  });

  return result.approval;
}

export function validatePaymentApproval(
  db: Database.Database,
  paymentApprovalId: string
): PaymentApprovalValidationResult {
  const paymentApproval = getPaymentApprovalRecordOrThrow(db, paymentApprovalId);
  const decisions = db.prepare(
    `SELECT decided_by, decision, created_at
     FROM payment_approval_decisions
     WHERE payment_approval_id = ?
     ORDER BY created_at ASC`
  ).all(paymentApprovalId) as Array<Pick<PaymentApprovalDecision, 'decided_by' | 'decision' | 'created_at'>>;

  const approvers = decisions
    .filter((decision) => decision.decision === 'approve')
    .map((decision) => decision.decided_by);
  const uniqueApprovers = new Set(approvers);
  const violations: string[] = [];

  if (approvers.length !== uniqueApprovers.size) {
    violations.push('Duplicate approver detected - same controller approved more than once');
  }

  if (uniqueApprovers.has(paymentApproval.requested_by)) {
    violations.push('Separation of duties violation - requester approved their own payment');
  }

  if (paymentApproval.status === 'approved' && uniqueApprovers.size < paymentApproval.required_approvals) {
    violations.push(
      `Insufficient approvals: ${uniqueApprovers.size} of ${paymentApproval.required_approvals} required`
    );
  }

  return {
    payment_approval_id: paymentApprovalId,
    status: paymentApproval.status,
    required_approvals: paymentApproval.required_approvals,
    actual_unique_approvers: uniqueApprovers.size,
    decisions,
    is_valid: violations.length === 0,
    violations,
  };
}
