import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { initializeDatabase } from './schema';

let db: Database.Database;
let currentDbPath: string | undefined;

export function getDatabase(dbPath?: string): Database.Database {
  const targetPath = dbPath || currentDbPath || config.dbPath;
  if (!db) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(targetPath);
    currentDbPath = targetPath;
    initializeDatabase(db);
  }
  return db;
}

export function isDatabaseOpen(): boolean {
  return db != null && db.open;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = undefined as any;
    currentDbPath = undefined;
  }
}
