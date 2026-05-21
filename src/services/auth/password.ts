import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface PasswordHash {
  hash: string;
  salt: string;
}

export function hashPassword(pwd: string, salt?: string): PasswordHash {
  const s = salt || randomBytes(16).toString('hex');
  const derived = scryptSync(pwd, s, 64).toString('hex');
  return { hash: derived, salt: s };
}

export function verifyPassword(pwd: string, storedHash: string, salt: string): boolean {
  const { hash } = hashPassword(pwd, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
