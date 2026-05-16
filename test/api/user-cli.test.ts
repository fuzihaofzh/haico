import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { verifyPassword } from '../../src/services/auth/password';

const BIN_PATH = path.join(__dirname, '..', '..', 'bin', 'haico.js');
const dbFiles = new Set<string>();

interface StoredUser {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  role: 'admin' | 'member';
}

function makeDbPath(): string {
  const dbPath = path.join(__dirname, `user-cli-${randomUUID()}.db`);
  dbFiles.add(dbPath);
  return dbPath;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }
}

function runCli(args: string[], input = '') {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HAICO_LOG_LEVEL: 'silent',
    },
  });
}

function getStoredUser(dbPath: string, username: string): StoredUser | null {
  const db = new Database(dbPath);
  try {
    const user = db.prepare('SELECT id, username, password_hash, password_salt, role FROM users WHERE username = ?')
      .get(username) as StoredUser | undefined;
    return user || null;
  } finally {
    db.close();
  }
}

function canAuthenticate(dbPath: string, username: string, password: string): StoredUser | null {
  const user = getStoredUser(dbPath, username);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return null;
  }
  return user;
}

function insertSession(dbPath: string, userId: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT INTO sessions (token, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run('test-token', userId, 'csrf-token', Date.now(), Date.now() + 60000);
  } finally {
    db.close();
  }
}

function countSessions(dbPath: string, userId: string): number {
  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?').get(userId) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dbPath of dbFiles) {
    cleanupDb(dbPath);
  }
  dbFiles.clear();
});

describe('User maintenance CLI', { concurrency: false }, () => {
  it('create-user creates a member by default', () => {
    const dbPath = makeDbPath();
    const result = runCli(['create-user', 'alice', '--db', dbPath], 'pass1234\npass1234\n');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created member user "alice"/);

    const user = canAuthenticate(dbPath, 'alice', 'pass1234');
    assert.ok(user);
    assert.equal(user.role, 'member');
  });

  it('create-user can create an admin', () => {
    const dbPath = makeDbPath();
    const result = runCli(['create-user', 'root', '--role', 'admin', '--db', dbPath], 'pass1234\npass1234\n');

    assert.equal(result.status, 0, result.stderr);

    const user = canAuthenticate(dbPath, 'root', 'pass1234');
    assert.ok(user);
    assert.equal(user.role, 'admin');
  });

  it('create-user rejects duplicate usernames', () => {
    const dbPath = makeDbPath();
    const first = runCli(['create-user', 'alice', '--db', dbPath], 'pass1234\npass1234\n');
    assert.equal(first.status, 0, first.stderr);

    const duplicate = runCli(['create-user', 'alice', '--db', dbPath], 'pass1234\npass1234\n');
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already exists/);
  });

  it('reset-password accepts an interactive new password', () => {
    const dbPath = makeDbPath();
    const created = runCli(['create-user', 'alice', '--db', dbPath], 'pass1234\npass1234\n');
    assert.equal(created.status, 0, created.stderr);

    const reset = runCli(['reset-password', 'alice', '--db', dbPath], 'newpass123\nnewpass123\n');
    assert.equal(reset.status, 0, reset.stderr);

    assert.equal(canAuthenticate(dbPath, 'alice', 'pass1234'), null);
    assert.ok(canAuthenticate(dbPath, 'alice', 'newpass123'));
  });

  it('reset-password --random prints a generated password once and clears sessions', () => {
    const dbPath = makeDbPath();
    const created = runCli(['create-user', 'alice', '--db', dbPath], 'pass1234\npass1234\n');
    assert.equal(created.status, 0, created.stderr);

    const originalUser = canAuthenticate(dbPath, 'alice', 'pass1234');
    assert.ok(originalUser);
    insertSession(dbPath, originalUser.id);

    const reset = runCli(['reset-password', 'alice', '--random', '--db', dbPath]);
    assert.equal(reset.status, 0, reset.stderr);

    const match = reset.stdout.match(/Generated password for alice: (\S+)/);
    assert.ok(match, reset.stdout);
    const generatedPassword = match[1];
    assert.equal((reset.stdout.match(new RegExp(generatedPassword, 'g')) || []).length, 1);

    assert.equal(canAuthenticate(dbPath, 'alice', 'pass1234'), null);
    const resetUser = canAuthenticate(dbPath, 'alice', generatedPassword);
    assert.ok(resetUser);
    assert.equal(countSessions(dbPath, resetUser.id), 0);
  });

  it('reports a missing username before prompting for a password', () => {
    const dbPath = makeDbPath();
    const result = runCli(['create-user', '--db', dbPath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing username/);
  });
});
