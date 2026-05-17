import { FastifyReply, FastifyRequest } from 'fastify';
import Database from 'better-sqlite3';
import { Project, User } from '../../types';
import {
  ProjectAccessDeniedError,
  ProjectAccessProjectNotFoundError,
  ProjectManagementAccessRequiredError,
} from './errors';
import { getProjectRequestContext } from './context';
import { shouldBypassProjectPermissions } from './policy';
import { ProjectPermission, ProjectPermissionLevel, ProjectRequestContext } from './types';

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

  if (user.role === 'admin') {
    return { exists: true, allowed: true, canManage: true, level: 'admin' };
  }

  if (project.owner_id && project.owner_id === user.id) {
    return { exists: true, allowed: true, canManage: true, level: 'owner' };
  }

  const membership = db.prepare(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
  ).get(projectId, user.id) as { role: string } | undefined;

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

export function requireProjectAccess(
  db: Database.Database,
  context: ProjectRequestContext,
  projectId: string,
  requireManage = false
): ProjectRequestContext & { permission: ProjectPermission } {
  const permission = getProjectPermission(db, projectId, context.user, context.localhostBypass);

  if (!permission.exists) {
    throw new ProjectAccessProjectNotFoundError();
  }

  if (requireManage ? !permission.canManage : !permission.allowed) {
    throw requireManage ? new ProjectManagementAccessRequiredError() : new ProjectAccessDeniedError();
  }

  return { ...context, permission };
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
  ).all(user.id, user.id) as Project[];
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
