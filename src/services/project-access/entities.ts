import Database from 'better-sqlite3';
import {
  AgentAccessAgentNotFoundError,
  MessageAccessMessageNotFoundError,
} from './errors';
import { ApprovalNotFoundError } from '../approvals/errors';
import {
  IssueCommentNotFoundError,
  IssueNotFoundError,
  IssueRelationNotFoundError,
  MilestoneNotFoundError,
} from '../issue/errors';
import { KnowledgeEntryNotFoundError } from '../knowledge/errors';
import { PaymentApprovalNotFoundError } from '../payment-approvals/errors';
import { requireProjectAccess } from './projects';
import { ProjectPermission, ProjectRequestContext, ProjectScopedEntity } from './types';

function requireEntityAccess<T extends ProjectScopedEntity>(
  db: Database.Database,
  context: ProjectRequestContext,
  query: string,
  id: string,
  createNotFoundError: () => Error,
  requireManage = false
): ProjectRequestContext & { permission: ProjectPermission; entity: T } {
  const entity = db.prepare(query).get(id) as T | undefined;
  if (!entity) {
    throw createNotFoundError();
  }

  const access = requireProjectAccess(db, context, entity.project_id, requireManage);
  return { ...access, entity };
}

export function requireAgentAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  agentId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string }>(
    db,
    context,
    'SELECT id, project_id FROM agents WHERE id = ?',
    agentId,
    () => new AgentAccessAgentNotFoundError(),
    requireManage
  );
}

export function requireIssueAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  issueId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string }>(
    db,
    context,
    'SELECT id, project_id FROM issues WHERE id = ?',
    issueId,
    () => new IssueNotFoundError(),
    requireManage
  );
}

export function requireCommentAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  commentId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string }>(
    db,
    context,
    `SELECT c.id, i.project_id
     FROM issue_comments c
     JOIN issues i ON i.id = c.issue_id
     WHERE c.id = ?`,
    commentId,
    () => new IssueCommentNotFoundError(),
    requireManage
  );
}

export function requireMilestoneAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  milestoneId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string }>(
    db,
    context,
    'SELECT id, project_id FROM milestones WHERE id = ?',
    milestoneId,
    () => new MilestoneNotFoundError(),
    requireManage
  );
}

export function requireKnowledgeAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  knowledgeId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string }>(
    db,
    context,
    'SELECT id, project_id FROM knowledge_entries WHERE id = ?',
    knowledgeId,
    () => new KnowledgeEntryNotFoundError(),
    requireManage
  );
}

export function requireApprovalAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  approvalId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string }>(
    db,
    context,
    'SELECT id, project_id FROM approval_requests WHERE id = ?',
    approvalId,
    () => new ApprovalNotFoundError(),
    requireManage
  );
}

export function requirePaymentApprovalAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  paymentApprovalId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string }>(
    db,
    context,
    'SELECT id, project_id FROM payment_approval_requests WHERE id = ?',
    paymentApprovalId,
    () => new PaymentApprovalNotFoundError(),
    requireManage
  );
}

export function requireMessageAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  messageId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string; from_agent_id: string; to_agent_id: string }>(
    db,
    context,
    'SELECT id, project_id, from_agent_id, to_agent_id FROM agent_messages WHERE id = ?',
    messageId,
    () => new MessageAccessMessageNotFoundError(),
    requireManage
  );
}

export function requireRelationAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  relationId: string,
  requireManage = false
) {
  return requireEntityAccess<{ id: string; project_id: string; from_issue_id: string; to_issue_id: string }>(
    db,
    context,
    `SELECT r.id, src.project_id, r.from_issue_id, r.to_issue_id
     FROM issue_relations r
     JOIN issues src ON src.id = r.from_issue_id
     WHERE r.id = ?`,
    relationId,
    () => new IssueRelationNotFoundError(),
    requireManage
  );
}
