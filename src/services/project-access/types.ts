import { User } from '../../types';

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

export interface ProjectScopedEntity {
  project_id: string;
}
