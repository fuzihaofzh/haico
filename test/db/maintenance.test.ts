/**
 * Tests for src/db/maintenance.ts
 *
 * 契约说明：
 * - resetStaleRunningAgents: 每次 startup 必须执行。将 status='running' 的 agent 重置为 'idle' + pid=NULL。
 *   前提：agent 可能因进程崩溃而滞留在 running 状态。若 agent 状态模型变更（如增加新状态），
 *   需确认此函数的重置逻辑仍适用。若移除 pid 列，需同步更新本测试和函数实现。
 *
 * - fixZeroSessionMaxTokens: 修正 session_max_tokens=0 → 400000。属于历史数据修复，
 *   0 值来自早期 schema 的默认值。当所有旧数据已修复且默认值改为 400000 后，此函数可安全移除，
 *   同时删除本 describe 块。
 *
 * - upgradeOldSessionMaxTokens: 升级 session_max_tokens=200000 → 400000。属于成本优化迁移，
 *  200000 来自旧默认值。当所有旧数据已升级后，此函数可安全移除，同时删除本 describe 块。
 *
 * - runStartupMaintenance: 编排入口，按顺序调用上述 3 个函数。新增 maintenance 函数时需在此处注册，
 *   并在对应 describe 块中添加测试。顺序敏感：fixZero 和 upgrade 需在 reset 之前执行，
 *   避免被 reset 的 agent 其 token 值未修正。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { resetStaleRunningAgents, fixZeroSessionMaxTokens, upgradeOldSessionMaxTokens, runStartupMaintenance } from '../../src/db/maintenance';

function createFreshDb(): Database.Database {
  const dbPath = path.join(__dirname, `maint-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  (db as any).__dbPath = dbPath;
  return db;
}

function cleanupDb(db: Database.Database): void {
  const dbPath = (db as any).__dbPath;
  db.close();
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

function createMinimalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      task_description TEXT NOT NULL, command_template TEXT DEFAULT 'cld',
      command_type TEXT DEFAULT NULL, orchestrator_engine TEXT DEFAULT 'langgraph',
      schedule_hours TEXT DEFAULT '', status TEXT DEFAULT 'active',
      owner_id TEXT, created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, role TEXT DEFAULT '', is_controller BOOLEAN DEFAULT 0,
      parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      session_id TEXT, working_directory TEXT, custom_instructions TEXT DEFAULT '',
      new_session_per_run BOOLEAN DEFAULT 0, session_run_count INTEGER DEFAULT 0,
      session_max_runs INTEGER DEFAULT 10, session_token_count INTEGER DEFAULT 0,
      session_max_tokens INTEGER DEFAULT 400000, session_resume_timeout INTEGER DEFAULT 300,
      command_template TEXT DEFAULT NULL, command_type TEXT DEFAULT NULL,
      status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'waiting', 'error')),
      paused BOOLEAN DEFAULT 0, pid INTEGER, last_prompt TEXT,
      started_at DATETIME, finished_at DATETIME,
      created_at DATETIME DEFAULT (datetime('now'))
    );
  `);
}

describe('maintenance.ts — Startup Maintenance', () => {
  describe('resetStaleRunningAgents', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('resets running agents to idle and clears pid', () => {
      const projectId = 'stale-proj';
      db.prepare('INSERT INTO projects (id, name, task_description) VALUES (?, ?, ?)').run(projectId, 'stale-test', 'test');
      db.prepare("INSERT INTO agents (id, project_id, name, status, pid) VALUES (?, ?, ?, 'running', 12345)").run('stale-agent', projectId, 'stale-agent');

      resetStaleRunningAgents(db);

      const agent = db.prepare('SELECT status, pid FROM agents WHERE id = ?').get('stale-agent') as any;
      assert.equal(agent.status, 'idle');
      assert.equal(agent.pid, null);
    });

    it('does not affect idle agents', () => {
      const projectId = 'stale-proj';
      db.prepare("INSERT INTO agents (id, project_id, name, status) VALUES (?, ?, ?, 'idle')").run('idle-agent', projectId, 'idle-agent');

      resetStaleRunningAgents(db);

      const agent = db.prepare('SELECT status FROM agents WHERE id = ?').get('idle-agent') as any;
      assert.equal(agent.status, 'idle');
    });

    it('does not affect waiting agents', () => {
      const projectId = 'stale-proj';
      db.prepare("INSERT INTO agents (id, project_id, name, status) VALUES (?, ?, ?, 'waiting')").run('waiting-agent', projectId, 'waiting-agent');

      resetStaleRunningAgents(db);

      const agent = db.prepare('SELECT status FROM agents WHERE id = ?').get('waiting-agent') as any;
      assert.equal(agent.status, 'waiting');
    });

    it('is idempotent — no error when no running agents exist', () => {
      assert.doesNotThrow(() => resetStaleRunningAgents(db));
    });
  });

  describe('fixZeroSessionMaxTokens', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('updates session_max_tokens from 0 to 400000', () => {
      const projectId = 'token-fix-proj';
      db.prepare('INSERT INTO projects (id, name, task_description) VALUES (?, ?, ?)').run(projectId, 'token-fix', 'test');
      db.prepare("INSERT INTO agents (id, project_id, name, session_max_tokens) VALUES (?, ?, ?, 0)").run('zero-token-agent', projectId, 'zero-agent');

      fixZeroSessionMaxTokens(db);

      const agent = db.prepare('SELECT session_max_tokens FROM agents WHERE id = ?').get('zero-token-agent') as any;
      assert.equal(agent.session_max_tokens, 400000);
    });

    it('does not affect agents with non-zero session_max_tokens', () => {
      const projectId = 'token-fix-proj';
      db.prepare("INSERT INTO agents (id, project_id, name, session_max_tokens) VALUES (?, ?, ?, 500000)").run('nonzero-agent', projectId, 'nonzero-agent');

      fixZeroSessionMaxTokens(db);

      const agent = db.prepare('SELECT session_max_tokens FROM agents WHERE id = ?').get('nonzero-agent') as any;
      assert.equal(agent.session_max_tokens, 500000);
    });

    it('is idempotent — no agents with 0 remain after first call', () => {
      fixZeroSessionMaxTokens(db);
      const count = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE session_max_tokens = 0").get() as any).c;
      assert.equal(count, 0, 'No agents should have session_max_tokens = 0 after fix');
    });
  });

  describe('upgradeOldSessionMaxTokens', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('upgrades session_max_tokens from 200000 to 400000', () => {
      const projectId = 'token-upgrade-proj';
      db.prepare('INSERT INTO projects (id, name, task_description) VALUES (?, ?, ?)').run(projectId, 'token-upgrade', 'test');
      db.prepare("INSERT INTO agents (id, project_id, name, session_max_tokens) VALUES (?, ?, ?, 200000)").run('old-token-agent', projectId, 'old-agent');

      upgradeOldSessionMaxTokens(db);

      const agent = db.prepare('SELECT session_max_tokens FROM agents WHERE id = ?').get('old-token-agent') as any;
      assert.equal(agent.session_max_tokens, 400000);
    });

    it('does not affect agents with other session_max_tokens values', () => {
      const projectId = 'token-upgrade-proj';
      db.prepare("INSERT INTO agents (id, project_id, name, session_max_tokens) VALUES (?, ?, ?, 100000)").run('other-agent', projectId, 'other-agent');

      upgradeOldSessionMaxTokens(db);

      const agent = db.prepare('SELECT session_max_tokens FROM agents WHERE id = ?').get('other-agent') as any;
      assert.equal(agent.session_max_tokens, 100000);
    });
  });

  describe('runStartupMaintenance', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('executes all maintenance tasks: fix zero tokens, upgrade old tokens, reset stale agents', () => {
      const projectId = 'startup-proj';
      db.prepare('INSERT INTO projects (id, name, task_description) VALUES (?, ?, ?)').run(projectId, 'startup-test', 'test');
      db.prepare("INSERT INTO agents (id, project_id, name, status, pid, session_max_tokens) VALUES (?, ?, ?, 'running', 999, 0)").run('startup-agent', projectId, 'startup-agent');
      db.prepare("INSERT INTO agents (id, project_id, name, session_max_tokens) VALUES (?, ?, ?, 200000)").run('old-agent', projectId, 'old-agent');

      runStartupMaintenance(db);

      const agent1 = db.prepare('SELECT status, pid, session_max_tokens FROM agents WHERE id = ?').get('startup-agent') as any;
      assert.equal(agent1.status, 'idle', 'Stale running agent should be reset to idle');
      assert.equal(agent1.pid, null, 'PID should be cleared');
      assert.equal(agent1.session_max_tokens, 400000, 'Zero tokens should be fixed to 400000');

      const agent2 = db.prepare('SELECT session_max_tokens FROM agents WHERE id = ?').get('old-agent') as any;
      assert.equal(agent2.session_max_tokens, 400000, '200000 tokens should be upgraded to 400000');
    });

    it('is idempotent — calling twice produces the same result', () => {
      assert.doesNotThrow(() => runStartupMaintenance(db));

      const agent1 = db.prepare('SELECT status, pid, session_max_tokens FROM agents WHERE id = ?').get('startup-agent') as any;
      assert.equal(agent1.status, 'idle');
      assert.equal(agent1.session_max_tokens, 400000);
    });
  });
});
