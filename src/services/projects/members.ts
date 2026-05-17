import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { ProjectMember } from '../../types';
import {
  InvalidProjectMemberRoleError,
  ProjectMemberIdentityRequiredError,
  ProjectMemberNotFoundError,
  ProjectNotFoundError,
  ProjectOwnerAlreadyHasAccessError,
  ProjectOwnerMutationError,
  ProjectUserNotFoundError,
} from './errors';

const PROJECT_MEMBER_ROLES = ['member', 'editor', 'owner'] as const;
type ProjectMemberRole = typeof PROJECT_MEMBER_ROLES[number];

export interface ProjectMemberWithUser extends ProjectMember {
  username: string;
  display_name: string;
  user_role: string;
}

export interface UpsertProjectMemberInput {
  user_id?: string;
  username?: string;
  role?: string;
}

function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return (PROJECT_MEMBER_ROLES as readonly string[]).includes(String(value));
}

function getProjectOwner(db: Database.Database, projectId: string): { owner_id: string | null } {
  const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId) as { owner_id: string | null } | undefined;
  if (!project) throw new ProjectNotFoundError();
  return project;
}

function getProjectMemberByProjectAndUser(
  db: Database.Database,
  projectId: string,
  userId: string
): ProjectMember | undefined {
  return db.prepare(
    'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?'
  ).get(projectId, userId) as ProjectMember | undefined;
}

function getProjectMemberWithUser(db: Database.Database, memberId: string): ProjectMemberWithUser {
  return db.prepare(
    `SELECT pm.*, u.username, u.display_name, u.role as user_role
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.id = ?`
  ).get(memberId) as ProjectMemberWithUser;
}

export function listProjectMembers(db: Database.Database, projectId: string): ProjectMemberWithUser[] {
  return db.prepare(
    `SELECT pm.*,
            u.username,
            u.display_name,
            u.role as user_role
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?
     ORDER BY CASE pm.role WHEN 'owner' THEN 0 ELSE 1 END, COALESCE(u.display_name, u.username), u.username`
  ).all(projectId) as ProjectMemberWithUser[];
}

export function upsertProjectMember(
  db: Database.Database,
  projectId: string,
  input: UpsertProjectMemberInput
): { member: ProjectMemberWithUser; created: boolean } {
  const { user_id, username, role } = input || {};
  if (!user_id && !username) throw new ProjectMemberIdentityRequiredError();

  const assignRole: ProjectMemberRole = role && isProjectMemberRole(role) ? role : 'member';
  const project = getProjectOwner(db, projectId);
  const targetUser = user_id
    ? db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(user_id) as any
    : db.prepare('SELECT id, username, display_name, role FROM users WHERE username = ?').get(username) as any;

  if (!targetUser) throw new ProjectUserNotFoundError();
  if (project.owner_id === targetUser.id) throw new ProjectOwnerAlreadyHasAccessError();

  const existingMember = getProjectMemberByProjectAndUser(db, projectId, targetUser.id);
  if (existingMember?.role === 'owner') {
    throw new ProjectOwnerMutationError('Cannot change project owner membership via share API');
  }

  if (existingMember) {
    db.prepare('UPDATE project_members SET role = ? WHERE id = ?').run(assignRole, existingMember.id);
    return { member: getProjectMemberWithUser(db, existingMember.id), created: false };
  }

  const memberId = uuidv4();
  db.prepare(
    'INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, ?)'
  ).run(memberId, projectId, targetUser.id, assignRole);

  return { member: getProjectMemberWithUser(db, memberId), created: true };
}

export function removeProjectMember(
  db: Database.Database,
  projectId: string,
  userId: string
): { success: true } {
  const project = getProjectOwner(db, projectId);
  if (project.owner_id === userId) {
    throw new ProjectOwnerMutationError('Cannot remove project owner');
  }

  const existingMember = getProjectMemberByProjectAndUser(db, projectId, userId);
  if (!existingMember) throw new ProjectMemberNotFoundError();

  db.prepare('DELETE FROM project_members WHERE id = ?').run(existingMember.id);
  return { success: true };
}

export function updateProjectMemberRole(
  db: Database.Database,
  projectId: string,
  userId: string,
  role: string
): ProjectMemberWithUser {
  if (!role || !isProjectMemberRole(role)) throw new InvalidProjectMemberRoleError();

  const project = getProjectOwner(db, projectId);
  if (project.owner_id === userId) {
    throw new ProjectOwnerMutationError('Cannot change project owner role');
  }

  const existingMember = getProjectMemberByProjectAndUser(db, projectId, userId);
  if (!existingMember) throw new ProjectMemberNotFoundError();

  db.prepare('UPDATE project_members SET role = ? WHERE id = ?').run(role, existingMember.id);
  return getProjectMemberWithUser(db, existingMember.id);
}
