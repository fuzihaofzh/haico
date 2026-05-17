import { FastifyReply, FastifyRequest } from 'fastify';
import Database from 'better-sqlite3';
import {
  AgentAccessAgentNotFoundError,
  MessageAccessMessageNotFoundError,
} from './errors';
import { ensureProjectAccess, requireProjectAccess } from './projects';
import { ProjectPermission, ProjectRequestContext, ProjectScopedEntity } from './types';

function ensureEntityAccess<T extends ProjectScopedEntity>(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  query: string,
  id: string,
  notFoundError: string,
  requireManage = false
): (ProjectRequestContext & { permission: ProjectPermission; entity: T }) | null {
  const entity = db.prepare(query).get(id) as T | undefined;
  if (!entity) {
    reply.code(404).send({ error: notFoundError });
    return null;
  }

  const access = ensureProjectAccess(db, request, reply, entity.project_id, requireManage);
  if (!access) return null;
  return { ...access, entity };
}

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

export function ensureAgentAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  agentId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string }>(
    db,
    request,
    reply,
    'SELECT id, project_id FROM agents WHERE id = ?',
    agentId,
    'Agent not found',
    requireManage
  );
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

export function ensureIssueAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  issueId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string }>(
    db,
    request,
    reply,
    'SELECT id, project_id FROM issues WHERE id = ?',
    issueId,
    'Issue not found',
    requireManage
  );
}

export function ensureCommentAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  commentId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string }>(
    db,
    request,
    reply,
    `SELECT c.id, i.project_id
     FROM issue_comments c
     JOIN issues i ON i.id = c.issue_id
     WHERE c.id = ?`,
    commentId,
    'Comment not found',
    requireManage
  );
}

export function ensureMilestoneAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  milestoneId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string }>(
    db,
    request,
    reply,
    'SELECT id, project_id FROM milestones WHERE id = ?',
    milestoneId,
    'Milestone not found',
    requireManage
  );
}

export function ensureKnowledgeAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  knowledgeId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string }>(
    db,
    request,
    reply,
    'SELECT id, project_id FROM knowledge_entries WHERE id = ?',
    knowledgeId,
    'Knowledge entry not found',
    requireManage
  );
}

export function ensureMessageAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  messageId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string; from_agent_id: string; to_agent_id: string }>(
    db,
    request,
    reply,
    'SELECT id, project_id, from_agent_id, to_agent_id FROM agent_messages WHERE id = ?',
    messageId,
    'Message not found',
    requireManage
  );
}

export function ensurePaymentApprovalAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  paymentApprovalId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string }>(
    db,
    request,
    reply,
    'SELECT id, project_id FROM payment_approval_requests WHERE id = ?',
    paymentApprovalId,
    'Payment approval request not found',
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

export function ensureRelationAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  relationId: string,
  requireManage = false
) {
  return ensureEntityAccess<{ id: string; project_id: string; from_issue_id: string; to_issue_id: string }>(
    db,
    request,
    reply,
    `SELECT r.id, src.project_id, r.from_issue_id, r.to_issue_id
     FROM issue_relations r
     JOIN issues src ON src.id = r.from_issue_id
     WHERE r.id = ?`,
    relationId,
    'Relation not found',
    requireManage
  );
}
