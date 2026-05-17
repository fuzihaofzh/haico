import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { broadcastToProject } from '../../realtime';
import { ApprovalRequest } from '../../types';
import {
  ApprovalAgentNotFoundError,
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  InvalidApprovalDecisionStatusError,
  MissingApprovalCreateFieldsError,
} from './errors';

const APPROVAL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const APPROVAL_DECISION_STATUSES = ['approved', 'rejected'] as const;

export type ApprovalRiskLevel = typeof APPROVAL_RISK_LEVELS[number];
export type ApprovalDecisionStatus = typeof APPROVAL_DECISION_STATUSES[number];

export interface ListApprovalsFilters {
  status?: unknown;
  limit?: unknown;
}

export interface CreateApprovalInput {
  agent_id?: unknown;
  title?: unknown;
  description?: unknown;
  risk_level?: unknown;
  issue_id?: unknown;
}

export interface DecideApprovalInput {
  status?: unknown;
  decision_note?: unknown;
  decided_by?: unknown;
}

export interface EnrichedApproval extends ApprovalRequest {
  agent_name: string | null;
  issue_number: number | null;
  issue_title: string | null;
}

export interface DecidedApproval extends ApprovalRequest {
  agent_name: string | null;
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

function normalizeRiskLevel(value: unknown): ApprovalRiskLevel {
  const normalized = normalizeText(value);
  return (APPROVAL_RISK_LEVELS as readonly string[]).includes(normalized)
    ? normalized as ApprovalRiskLevel
    : 'medium';
}

function normalizeListLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function normalizeDecisionStatus(value: unknown): ApprovalDecisionStatus {
  const normalized = normalizeText(value);
  if ((APPROVAL_DECISION_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as ApprovalDecisionStatus;
  }
  throw new InvalidApprovalDecisionStatusError();
}

function buildSqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function getApprovalRecordOrThrow(db: Database.Database, approvalId: string): ApprovalRequest {
  const row = db.prepare(
    'SELECT * FROM approval_requests WHERE id = ?'
  ).get(approvalId) as ApprovalRequest | undefined;
  if (!row) throw new ApprovalNotFoundError();
  return row;
}

export function listApprovals(
  db: Database.Database,
  projectId: string,
  filters: ListApprovalsFilters = {}
): EnrichedApproval[] {
  const status = normalizeText(filters.status);
  const limit = normalizeListLimit(filters.limit);

  const rows = status
    ? db.prepare(
        `SELECT ar.*, a.name as agent_name, i.number as issue_number, i.title as issue_title
         FROM approval_requests ar
         LEFT JOIN agents a ON ar.agent_id = a.id
         LEFT JOIN issues i ON ar.issue_id = i.id
         WHERE ar.project_id = ? AND ar.status = ?
         ORDER BY ar.created_at DESC LIMIT ?`
      ).all(projectId, status, limit)
    : db.prepare(
        `SELECT ar.*, a.name as agent_name, i.number as issue_number, i.title as issue_title
         FROM approval_requests ar
         LEFT JOIN agents a ON ar.agent_id = a.id
         LEFT JOIN issues i ON ar.issue_id = i.id
         WHERE ar.project_id = ?
         ORDER BY ar.created_at DESC LIMIT ?`
      ).all(projectId, limit);

  return rows as EnrichedApproval[];
}

export function getApproval(
  db: Database.Database,
  approvalId: string
): EnrichedApproval {
  const row = db.prepare(
    `SELECT ar.*, a.name as agent_name, i.number as issue_number, i.title as issue_title
     FROM approval_requests ar
     LEFT JOIN agents a ON ar.agent_id = a.id
     LEFT JOIN issues i ON ar.issue_id = i.id
     WHERE ar.id = ?`
  ).get(approvalId) as EnrichedApproval | undefined;

  if (!row) throw new ApprovalNotFoundError();
  return row;
}

export function createApproval(
  db: Database.Database,
  projectId: string,
  input: CreateApprovalInput
): ApprovalRequest {
  const agentId = normalizeText(input.agent_id);
  const title = normalizeText(input.title);

  if (!agentId || !title) {
    throw new MissingApprovalCreateFieldsError();
  }

  const agent = db.prepare(
    'SELECT id, name FROM agents WHERE id = ? AND project_id = ?'
  ).get(agentId, projectId) as { id: string; name: string } | undefined;
  if (!agent) {
    throw new ApprovalAgentNotFoundError();
  }

  const created = db.transaction(() => {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO approval_requests (id, project_id, issue_id, agent_id, title, description, risk_level)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      projectId,
      normalizeNullableText(input.issue_id),
      agentId,
      title,
      normalizeOptionalText(input.description),
      normalizeRiskLevel(input.risk_level)
    );

    return getApprovalRecordOrThrow(db, id);
  })();

  broadcastToProject(projectId, {
    type: 'approval_created',
    projectId,
    data: { ...created, agent_name: agent.name },
  });

  return created;
}

export function decideApproval(
  db: Database.Database,
  approvalId: string,
  input: DecideApprovalInput
): DecidedApproval {
  const status = normalizeDecisionStatus(input.status);

  const result = db.transaction(() => {
    const existing = getApprovalRecordOrThrow(db, approvalId);
    if (existing.status !== 'pending') {
      throw new ApprovalAlreadyDecidedError();
    }

    db.prepare(
      `UPDATE approval_requests
       SET status = ?, decided_by = ?, decision_note = ?, decided_at = datetime('now')
       WHERE id = ?`
    ).run(
      status,
      normalizeText(input.decided_by) || 'user',
      normalizeOptionalText(input.decision_note),
      approvalId
    );

    const updated = db.prepare(
      `SELECT ar.*, a.name as agent_name
       FROM approval_requests ar
       LEFT JOIN agents a ON ar.agent_id = a.id
       WHERE ar.id = ?`
    ).get(approvalId) as DecidedApproval;

    return {
      projectId: existing.project_id,
      approval: updated,
    };
  })();

  broadcastToProject(result.projectId, {
    type: 'approval_decided',
    projectId: result.projectId,
    data: result.approval,
  });

  return result.approval;
}

export function countPendingApprovals(
  db: Database.Database,
  projectIds: string[]
): number {
  if (projectIds.length === 0) return 0;
  const placeholders = buildSqlPlaceholders(projectIds);
  const row = db.prepare(
    `SELECT COUNT(*) as count
     FROM approval_requests
     WHERE project_id IN (${placeholders}) AND status = 'pending'`
  ).get(...projectIds) as { count: number } | undefined;

  return row?.count || 0;
}
