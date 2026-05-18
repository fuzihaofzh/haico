import { User } from '../../types';
import { ProjectRequestContext } from './types';

export function createProjectRequestContext(
  user: User | null,
  localhostBypass = false
): ProjectRequestContext {
  return { user, localhostBypass };
}
