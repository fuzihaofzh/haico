import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from '../../logger';
import { getDatabase } from '../../db/database';
import { hashPassword, isLegacySha256, legacySha256, verifyPassword } from './password';

const CONFIG_DIR = path.join(os.homedir(), '.haico');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface AuthConfig {
  passwordHash?: string;
  passwordSalt?: string;
}

export function loadAuthConfig(): AuthConfig {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'auth'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value);
  } catch (e) {
    logger.error(e, 'Failed to load auth config from database');
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as AuthConfig;
      if (config.passwordHash) {
        logger.info('Migrating auth config from file to database');
        saveAuthConfig(config);
        return config;
      }
    }
  } catch {}

  return {};
}

export function saveAuthConfig(config: AuthConfig): void {
  try {
    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auth', ?)").run(JSON.stringify(config));
  } catch (e) {
    logger.error(e, 'Failed to save auth config to database');
  }
}

export function isSinglePasswordConfigured(): boolean {
  return !!loadAuthConfig().passwordHash;
}

export function checkSinglePassword(pwd: string, config = loadAuthConfig()): boolean {
  if (!config.passwordHash) return false;
  if (isLegacySha256(config)) {
    return legacySha256(pwd) === config.passwordHash;
  }
  return verifyPassword(pwd, config.passwordHash, config.passwordSalt!);
}

export function setSinglePassword(pwd: string): AuthConfig {
  const { hash, salt } = hashPassword(pwd);
  const config = { passwordHash: hash, passwordSalt: salt };
  saveAuthConfig(config);
  return config;
}

export function isValidSinglePasswordToken(token: string, config = loadAuthConfig()): boolean {
  return !!config.passwordHash && token === config.passwordHash;
}
