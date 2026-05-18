import { User } from '../../types';

export function isLegacyAuthUser(user: User | null | undefined): boolean {
  return !!user && user.id === 'legacy';
}
