import { User } from '../../types';

export function shouldBypassProjectPermissions(user: User | null | undefined, localhostBypass: boolean): boolean {
  if (user?.id === 'legacy') return true;
  if (process.env.HAICO_NO_AUTH === 'true' && !user) return true;
  return localhostBypass && !user;
}
