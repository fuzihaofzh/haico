import { User } from '../../types';
import { ProjectRequestContext } from './types';

export function createProjectRequestContext(user: User | null): ProjectRequestContext {
  return { user };
}
