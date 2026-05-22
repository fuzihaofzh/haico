import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import logger from '../../logger';
import { DefaultAdminLoginDisabledError } from './errors';
import { AuthSession, createSession } from './sessions';
import { DEFAULT_ADMIN_USERNAME, ensureDefaultAdminUser, PublicUser } from './users';

const DEFAULT_ADMIN_PASSWORD_BYTES = 18;

export interface DefaultAdminBootstrapResult {
  enabled: boolean;
  username: string;
  generatedPassword?: string;
  fixedPassword: boolean;
}

export interface DefaultAdminLoginResult {
  session: AuthSession;
  user: PublicUser;
}

export function isDefaultAdminEnabled(): boolean {
  return process.env.HAICO_DEFAULT_ADMIN === 'true';
}

export function bootstrapDefaultAdmin(db: Database.Database): DefaultAdminBootstrapResult {
  if (!isDefaultAdminEnabled()) {
    return {
      enabled: false,
      username: DEFAULT_ADMIN_USERNAME,
      fixedPassword: false,
    };
  }

  const fixedPassword = process.env.HAICO_DEFAULT_ADMIN_PASSWORD;
  const password = fixedPassword || randomBytes(DEFAULT_ADMIN_PASSWORD_BYTES).toString('base64url');
  ensureDefaultAdminUser(db, password);

  if (fixedPassword) {
    logger.warn(
      { username: DEFAULT_ADMIN_USERNAME },
      'Default admin enabled with HAICO_DEFAULT_ADMIN_PASSWORD. This is insecure for production use.'
    );
  } else {
    logger.info(`Default admin credentials: username=${DEFAULT_ADMIN_USERNAME} password=${password}`);
  }

  return {
    enabled: true,
    username: DEFAULT_ADMIN_USERNAME,
    generatedPassword: fixedPassword ? undefined : password,
    fixedPassword: Boolean(fixedPassword),
  };
}

function findDefaultAdminUser(db: Database.Database): PublicUser | null {
  return db.prepare(
    'SELECT id, username, email, display_name, role, created_at, last_login_at FROM users WHERE username = ?'
  ).get(DEFAULT_ADMIN_USERNAME) as PublicUser | undefined || null;
}

export function createDefaultAdminLogin(db: Database.Database): DefaultAdminLoginResult {
  if (!isDefaultAdminEnabled()) {
    throw new DefaultAdminLoginDisabledError();
  }

  const user = findDefaultAdminUser(db)
    || ensureDefaultAdminUser(db, randomBytes(DEFAULT_ADMIN_PASSWORD_BYTES).toString('base64url'));

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const updatedUser = findDefaultAdminUser(db) || user;
  const session = createSession(db, updatedUser.id);
  return { session, user: updatedUser };
}
