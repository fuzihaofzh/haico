import { User } from '../../types';

export type ProjectPermissionLevel = 'none' | 'member' | 'editor' | 'owner' | 'admin';

export interface ProjectPermission {
  exists: boolean;
  allowed: boolean;
  canManage: boolean;
  level: ProjectPermissionLevel;
}

export interface ProjectRequestContext {
  user: User | null;
}

export interface ProjectScopedEntity {
  project_id: string;
}
