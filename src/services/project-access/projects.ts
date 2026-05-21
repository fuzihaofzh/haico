import Database from 'better-sqlite3';
import { Project, User } from '../../types';
import {
  ProjectAccessDeniedError,
  ProjectAccessProjectNotFoundError,
  ProjectManagementAccessRequiredError,
} from './errors';
import { ProjectPermission, ProjectPermissionLevel, ProjectRequestContext } from './types';

export function getProjectPermission(
  db: Database.Database,
  projectId: string,
  user: User | null | undefined
): ProjectPermission {
  const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId) as { owner_id: string | null } | undefined;
  if (!project) {
    return { exists: false, allowed: false, canManage: false, level: 'none' };
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
  const permission = getProjectPermission(db, projectId, context.user);

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
  user: User | null | undefined
): Project[] {
  if (user?.role === 'admin') {
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
  user: User | null | undefined
): string[] {
  return listAccessibleProjects(db, user).map((project) => project.id);
}
