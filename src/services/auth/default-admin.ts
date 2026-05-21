import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import logger from '../../logger';
import { DEFAULT_ADMIN_USERNAME, ensureDefaultAdminUser } from './users';

const DEFAULT_ADMIN_PASSWORD_BYTES = 18;

export interface DefaultAdminBootstrapResult {
  enabled: boolean;
  username: string;
  generatedPassword?: string;
  fixedPassword: boolean;
}

export function bootstrapDefaultAdmin(db: Database.Database): DefaultAdminBootstrapResult {
  if (process.env.HAICO_DEFAULT_ADMIN !== 'true') {
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
