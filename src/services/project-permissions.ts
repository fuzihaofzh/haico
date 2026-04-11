import { FastifyReply, FastifyRequest } from 'fastify';
import Database from 'better-sqlite3';
import { getRequestUser, isLocalhostBypassRequest } from '../middleware/auth';
import { Project, User } from '../types';

export type ProjectPermissionLevel = 'none' | 'member' | 'editor' | 'owner' | 'admin' | 'bypass';

export interface ProjectPermission {
  exists: boolean;
  allowed: boolean;
  canManage: boolean;
  level: ProjectPermissionLevel;
}

export interface ProjectRequestContext {
  user: User | null;
  localhostBypass: boolean;
}

interface ProjectScopedEntity {
  project_id: string;
}

export function shouldBypassProjectPermissions(user: User | null | undefined, localhostBypass: boolean): boolean {
  if (user?.id === 'legacy') return true;
  if (process.env.HAICO_NO_AUTH === 'true' && !user) return true;
  return localhostBypass && !user;
}

export function getProjectRequestContext(request: FastifyRequest): ProjectRequestContext {
  return {
    user: getRequestUser(request),
    localhostBypass: isLocalhostBypassRequest(request),
  };
}

export function getProjectPermission(
  db: Database.Database,
  projectId: string,
  user: User | null | undefined,
  localhostBypass = false
): ProjectPermission {
  const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId) as { owner_id: string | null } | undefined;
  if (!project) {
    return { exists: false, allowed: false, canManage: false, level: 'none' };
  }

  if (shouldBypassProjectPermissions(user, localhostBypass)) {
    return { exists: true, allowed: true, canManage: true, level: 'bypass' };
  }

  if (!user) {
    return { exists: true, allowed: false, canManage: false, level: 'none' };
  }

  if (user!.role === 'admin') {
    return { exists: true, allowed: true, canManage: true, level: 'admin' };
  }

  if (project.owner_id && project.owner_id === user!.id) {
    return { exists: true, allowed: true, canManage: true, level: 'owner' };
  }

  const membership = db.prepare(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
  ).get(projectId, user!.id) as { role: string } | undefined;

  if (membership) {
    const canManage = membership.role === 'owner' || membership.role === 'editor';
    return {
      exists: true,
      allowed: true,
      canManage,
      level: membership.role as ProjectPermissionLevel,
    };
  }

  return { exists: true, allowed: false, canManage: false, level: 'none' };
}

export function listAccessibleProjects(
  db: Database.Database,
  user: User | null | undefined,
  localhostBypass = false
): Project[] {
  if (shouldBypassProjectPermissions(user, localhostBypass) || user?.role === 'admin') {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
  }

  if (!user) {
    return [];
  }

  return db.prepare(
    `SELECT DISTINCT p.*
     FROM projects p
     LEFT JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = ?
     WHERE p.owner_id = ? OR pm.user_id IS NOT NULL
     ORDER BY p.created_at DESC`
  ).all(user!.id, user!.id) as Project[];
}

export function listAccessibleProjectIds(
  db: Database.Database,
  user: User | null | undefined,
  localhostBypass = false
): string[] {
  return listAccessibleProjects(db, user, localhostBypass).map((project) => project.id);
}

export function ensureProjectAccess(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  requireManage = false
): (ProjectRequestContext & { permission: ProjectPermission }) | null {
  const context = getProjectRequestContext(request);
  const permission = getProjectPermission(db, projectId, context.user, context.localhostBypass);

  if (!permission.exists) {
    reply.code(404).send({ error: 'Project not found' });
    return null;
  }

  if (requireManage ? !permission.canManage : !permission.allowed) {
    reply.code(403).send({ error: requireManage ? 'Project management access required' : 'Project access denied' });
    return null;
  }

  return { ...context, permission };
}

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
