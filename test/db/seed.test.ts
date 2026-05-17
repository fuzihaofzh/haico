/**
 * Tests for src/db/seed.ts
 *
 * 契约说明：
 * - seedKnowledgeFts: 依赖 knowledge_entries 表已存在。创建 knowledge_fts FTS5 虚拟表 + 3 个同步触发器。
 *   若 knowledge_fts 已存在则跳过（幂等）。若 knowledge_entries 表结构变更（如 title/content 列名改变），
 *   需同步更新本测试的 FTS MATCH 断言和 seed.ts 中的 FTS5 定义。
 *
 * - seedLegacyAgentKnowledge: 依赖 agents/knowledge.ts 的 seedMissingAgentKnowledgeEntriesFromLegacyMemories。
 *   从旧表 agent_memories 迁移数据到 knowledge_entries，然后删除 agent_memories / memories_fts 及关联触发器。
 *   当旧表不存在时为 no-op。若移除对 agent_memories 的支持，应删除本 describe 块。
 *
 * - seedProjectOwners: 依赖 users + projects + project_members 表。将首个 admin 设为 NULL owner_id 项目的 owner，
 *   并 upsert project_members。若 owner_id 赋值逻辑变更（如改为项目创建时即填充），需更新本测试。
 *
 * - seedBuiltinProjectTemplates: 依赖 project_templates 表。当 is_builtin=0 时插入 3 个内置模板。
 *   若新增/删除/修改内置模板，需同步更新本测试的 ID 列表和数量断言。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { seedKnowledgeFts, seedLegacyAgentKnowledge, seedProjectOwners, seedBuiltinProjectTemplates } from '../../src/db/seed';

function createFreshDb(): Database.Database {
  const dbPath = path.join(__dirname, `seed-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT DEFAULT '',
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, display_name TEXT DEFAULT '',
      role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      created_at DATETIME DEFAULT (datetime('now')), last_login_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      task_description TEXT NOT NULL, command_template TEXT DEFAULT 'cld',
      command_type TEXT DEFAULT NULL, orchestrator_engine TEXT DEFAULT 'langgraph',
      schedule_hours TEXT DEFAULT '', status TEXT DEFAULT 'active',
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now'))
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
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tags TEXT DEFAULT '',
      importance TEXT DEFAULT 'medium' CHECK(importance IN ('high', 'medium', 'low')),
      category TEXT DEFAULT 'architecture', expires_at DATETIME,
      last_verified_at DATETIME, verified_by TEXT, status TEXT DEFAULT 'active',
      created_by TEXT DEFAULT 'user', created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_members (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member' CHECK(role IN ('owner', 'editor', 'member')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      template_data TEXT NOT NULL DEFAULT '{}', created_by TEXT DEFAULT 'system',
      is_builtin BOOLEAN DEFAULT 0, created_at DATETIME DEFAULT (datetime('now'))
    );
  `);
}

describe('seed.ts — Seed Module', () => {
  describe('seedKnowledgeFts', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('creates knowledge_fts table when it does not exist', () => {
      seedKnowledgeFts(db);
      const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'").get() as any;
      assert.ok(fts, 'knowledge_fts table should exist after seeding');
    });

    it('creates FTS sync triggers', () => {
      const triggers = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('knowledge_ai', 'knowledge_ad', 'knowledge_au')"
      ).all() as Array<{ name: string }>;
      assert.equal(triggers.length, 3, 'All 3 FTS triggers should exist');
    });

    it('populates FTS index from existing knowledge entries', () => {
      const projectId = 'fts-test-proj';
      db.prepare('INSERT INTO projects (id, name, task_description) VALUES (?, ?, ?)').run(projectId, 'fts-test', 'test');
      db.prepare("INSERT INTO knowledge_entries (id, project_id, title, content, created_by) VALUES (?, ?, ?, ?, ?)").run('ke1', projectId, 'React Patterns', 'Hooks and context patterns', 'user');

      seedKnowledgeFts(db);

      const results = db.prepare("SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH ?").all('React') as any[];
      assert.ok(results.length > 0, 'FTS should find the React entry');
    });

    it('is idempotent — calling twice does not error', () => {
      assert.doesNotThrow(() => seedKnowledgeFts(db));
    });

    it('FTS stays in sync after insert via trigger', () => {
      const projectId = 'fts-test-proj';
      db.prepare("INSERT INTO knowledge_entries (id, project_id, title, content, created_by) VALUES (?, ?, ?, ?, ?)").run('ke2', projectId, 'TypeScript Tips', 'Generic constraints and mapped types', 'user');
      const results = db.prepare("SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH ?").all('TypeScript') as any[];
      assert.ok(results.length > 0, 'FTS should find newly inserted entry via trigger');
    });
  });

  describe('seedLegacyAgentKnowledge', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('migrates legacy agent_memories into knowledge_entries', () => {
      const projectId = 'legacy-seed-proj';
      db.prepare('INSERT INTO projects (id, name, task_description) VALUES (?, ?, ?)').run(projectId, 'legacy-seed', 'test');
      db.prepare("INSERT INTO agents (id, project_id, name, role, working_directory, custom_instructions) VALUES (?, ?, ?, ?, ?, ?)").run('legacy-seed-agent', projectId, 'legacy-agent', 'worker', '/tmp', 'focus');

      db.exec(`
        CREATE TABLE agent_memories (
          id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT NOT NULL,
          session_id TEXT, content TEXT NOT NULL, tags TEXT DEFAULT '',
          scope TEXT DEFAULT 'private', created_at DATETIME DEFAULT (datetime('now')), expires_at DATETIME
        );
        CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content=agent_memories, content_rowid=rowid);
      `);
      db.prepare("INSERT INTO agent_memories (id, agent_id, project_id, content, tags, scope) VALUES (?, ?, ?, ?, ?, ?)").run('lm1', 'legacy-seed-agent', projectId, 'Remember the deployment path', 'deploy', 'private');

      seedLegacyAgentKnowledge(db);

      const entry = db.prepare(
        "SELECT * FROM knowledge_entries WHERE project_id = ? AND owner_agent_id = ?"
      ).get(projectId, 'legacy-seed-agent') as any;
      assert.ok(entry, 'Agent knowledge entry should exist after migration');
      assert.match(entry.content, /历史记忆迁移/);
      assert.match(entry.content, /Remember the deployment path/);
    });

    it('drops legacy agent_memories table and FTS after migration', () => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memories'").get() as any;
      assert.equal(table, undefined, 'agent_memories table should be dropped');
      const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as any;
      assert.equal(fts, undefined, 'memories_fts table should be dropped');
    });

    it('is idempotent — calling again does not error or duplicate', () => {
      const countBefore = db.prepare("SELECT COUNT(*) as c FROM knowledge_entries WHERE owner_agent_id = 'legacy-seed-agent'").get() as any;
      assert.doesNotThrow(() => seedLegacyAgentKnowledge(db));
      const countAfter = db.prepare("SELECT COUNT(*) as c FROM knowledge_entries WHERE owner_agent_id = 'legacy-seed-agent'").get() as any;
      assert.equal(countBefore.c, countAfter.c, 'Should not duplicate entries');
    });
  });

  describe('seedProjectOwners', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('assigns first admin as owner for projects with NULL owner_id', () => {
      db.prepare("INSERT INTO users (id, username, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)").run('admin-1', 'admin', 'hash', 'salt', 'admin');
      db.prepare("INSERT INTO projects (id, name, task_description, owner_id) VALUES (?, ?, ?, ?)").run('owner-proj', 'owner-test', 'test', null);

      seedProjectOwners(db);

      const proj = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get('owner-proj') as any;
      assert.equal(proj.owner_id, 'admin-1', 'Project owner_id should be set to first admin');
    });

    it('creates project_members entry with owner role', () => {
      const member = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get('owner-proj', 'admin-1') as any;
      assert.ok(member, 'project_members entry should exist');
      assert.equal(member.role, 'owner');
    });

    it('is idempotent — does not duplicate project_members entries', () => {
      seedProjectOwners(db);
      const members = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').all('owner-proj', 'admin-1') as any[];
      assert.equal(members.length, 1, 'Should not create duplicate project_members entries');
    });

    it('does not overwrite existing owner_id', () => {
      db.prepare("INSERT INTO users (id, username, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)").run('admin-2', 'admin2', 'hash', 'salt', 'admin');
      db.prepare("INSERT INTO projects (id, name, task_description, owner_id) VALUES (?, ?, ?, ?)").run('owned-proj', 'already-owned', 'test', 'admin-2');

      seedProjectOwners(db);

      const proj = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get('owned-proj') as any;
      assert.equal(proj.owner_id, 'admin-2', 'Existing owner_id should not be overwritten');
    });
  });

  describe('seedBuiltinProjectTemplates', () => {
    let db: Database.Database;
    before(() => { db = createFreshDb(); createMinimalSchema(db); });
    after(() => cleanupDb(db));

    it('seeds 3 builtin templates when none exist', () => {
      seedBuiltinProjectTemplates(db);
      const count = (db.prepare('SELECT COUNT(*) as c FROM project_templates WHERE is_builtin = 1').get() as any).c;
      assert.equal(count, 3, 'Should seed 3 builtin templates');
    });

    it('seeds correct template IDs', () => {
      const ids = (db.prepare('SELECT id FROM project_templates WHERE is_builtin = 1 ORDER BY id').all() as any[]).map(r => r.id);
      assert.deepEqual(ids, ['tpl-bugfix', 'tpl-feature', 'tpl-review']);
    });

    it('seeds valid JSON in template_data', () => {
      const templates = db.prepare('SELECT id, template_data FROM project_templates WHERE is_builtin = 1').all() as any[];
      for (const t of templates) {
        assert.doesNotThrow(() => JSON.parse(t.template_data), `Template ${t.id} should have valid JSON`);
      }
    });

    it('is idempotent — calling twice does not add more templates', () => {
      seedBuiltinProjectTemplates(db);
      const count = (db.prepare('SELECT COUNT(*) as c FROM project_templates WHERE is_builtin = 1').get() as any).c;
      assert.equal(count, 3, 'Should still be 3 templates after second call');
    });
  });
});
