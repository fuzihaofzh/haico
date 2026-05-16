import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { User } from '../../types';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthSession {
  token: string;
  expiresAt: number;
}

export function createSession(db: Database.Database, userId: string): AuthSession {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_MAX_AGE_MS;
  db.prepare('INSERT INTO sessions (token, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, userId, randomBytes(16).toString('hex'), now, expiresAt);
  return { token, expiresAt };
}

export function deleteSessionByToken(db: Database.Database, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function isValidSessionToken(db: Database.Database, token: string): boolean {
  const session = db.prepare('SELECT token FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now());
  return !!session;
}

export function getUserBySessionToken(db: Database.Database, token: string): User | null {
  const session = db.prepare(
    'SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?'
  ).get(token, Date.now()) as { user_id: string } | undefined;

  if (!session?.user_id) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as User | undefined || null;
}
