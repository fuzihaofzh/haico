import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../../types';
import { hashPassword, verifyPassword } from './password';

export const DEFAULT_ADMIN_USERNAME = 'haico_default_admin';

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  created_at: string;
  last_login_at?: string | null;
}

export interface RegisterUserInput {
  username?: string;
  email?: string;
  password?: string;
  display_name?: string;
}

export type UserRole = 'admin' | 'member';

export function hasAnyUsers(db: Database.Database): boolean {
  return (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c > 0;
}

export function validateRegistrationInput(input: RegisterUserInput): string | null {
  if (!input.username || !input.password) {
    return 'username and password are required';
  }
  if (input.password.length < 4) {
    return 'Password must be at least 4 characters';
  }
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(input.username)) {
    return 'Username must be 2-32 characters (letters, numbers, -, _)';
  }
  return null;
}

export function registerUser(db: Database.Database, input: RegisterUserInput): PublicUser | 'duplicate' {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(input.username);
  if (existing) return 'duplicate';

  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  const role = userCount === 0 ? 'admin' : 'member';
  const userId = uuidv4();
  const { hash, salt } = hashPassword(input.password!);

  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, password_salt, display_name, role) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, input.username, input.email || '', hash, salt, input.display_name || input.username, role);

  return db.prepare('SELECT id, username, email, display_name, role, created_at FROM users WHERE id = ?').get(userId) as PublicUser;
}

export function createUserWithRole(
  db: Database.Database,
  username: string,
  password: string,
  role: UserRole = 'member'
): PublicUser | 'duplicate' {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return 'duplicate';

  const userId = uuidv4();
  const { hash, salt } = hashPassword(password);

  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, password_salt, display_name, role) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, username, '', hash, salt, username, role);

  return db.prepare(
    'SELECT id, username, email, display_name, role, created_at, last_login_at FROM users WHERE id = ?'
  ).get(userId) as PublicUser;
}

export function ensureDefaultAdminUser(
  db: Database.Database,
  password: string
): PublicUser {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(DEFAULT_ADMIN_USERNAME) as { id: string } | undefined;
  const { hash, salt } = hashPassword(password);

  const ensure = db.transaction(() => {
    if (existing) {
      db.prepare(
        "UPDATE users SET password_hash = ?, password_salt = ?, role = 'admin', display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END WHERE id = ?"
      ).run(hash, salt, 'HAICO Default Admin', existing.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      return existing.id;
    }

    const userId = uuidv4();
    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, password_salt, display_name, role) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, DEFAULT_ADMIN_USERNAME, '', hash, salt, 'HAICO Default Admin', 'admin');
    return userId;
  });

  const userId = ensure();
  return db.prepare(
    'SELECT id, username, email, display_name, role, created_at, last_login_at FROM users WHERE id = ?'
  ).get(userId) as PublicUser;
}

export function resetUserPassword(db: Database.Database, username: string, password: string): PublicUser | null {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | undefined;
  if (!user) return null;

  const { hash, salt } = hashPassword(password);
  const reset = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  });
  reset();

  return db.prepare(
    'SELECT id, username, email, display_name, role, created_at, last_login_at FROM users WHERE id = ?'
  ).get(user.id) as PublicUser;
}

export function changeUserPassword(
  db: Database.Database,
  userId: string,
  currentPassword: string,
  nextPassword: string
): PublicUser | 'invalid-current' | null {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
  if (!user) return null;
  if (!verifyPassword(currentPassword, user.password_hash, user.password_salt)) {
    return 'invalid-current';
  }

  const { hash, salt } = hashPassword(nextPassword);
  const change = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  });
  change();

  return db.prepare(
    'SELECT id, username, email, display_name, role, created_at, last_login_at FROM users WHERE id = ?'
  ).get(user.id) as PublicUser;
}

export function authenticateUser(db: Database.Database, username: string, password: string): User | null {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return null;
  }
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  return user;
}

export function listUsers(db: Database.Database): PublicUser[] {
  return db.prepare(
    'SELECT id, username, email, display_name, role, created_at, last_login_at FROM users ORDER BY created_at'
  ).all() as PublicUser[];
}

export function updateUserRole(db: Database.Database, userId: string, role?: string): PublicUser | null {
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as { id: string; username: string } | undefined;
  if (!target) return null;
  if (target.username === DEFAULT_ADMIN_USERNAME && role && role !== 'admin') return null;
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  return db.prepare(
    'SELECT id, username, email, display_name, role, created_at, last_login_at FROM users WHERE id = ?'
  ).get(userId) as PublicUser;
}

export type DeleteUserResult = 'deleted' | 'not-found' | 'protected';

export function deleteUser(db: Database.Database, userId: string): DeleteUserResult {
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as { id: string; username: string } | undefined;
  if (!target) return 'not-found';
  if (target.username === DEFAULT_ADMIN_USERNAME) return 'protected';
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return 'deleted';
}
