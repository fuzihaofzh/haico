import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

it('legacy agent_memories rows migrate into owner knowledge and are dropped during init', async () => {
  const legacyDbPath = path.join(
    __dirname,
    `legacy-agent-memories-${Date.now()}.db`
  );
  const cleanupLegacyFiles = () => {
    for (const file of [
      legacyDbPath,
      `${legacyDbPath}-wal`,
      `${legacyDbPath}-shm`,
    ]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  };

  cleanupLegacyFiles();

  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const { initializeDatabase } = await import('../../src/db/schema');
  const legacyDb = new BetterSqlite3(legacyDbPath);

  try {
    legacyDb.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          task_description TEXT NOT NULL,
          command_template TEXT DEFAULT 'echo',
          command_type TEXT DEFAULT NULL,
          orchestrator_engine TEXT DEFAULT 'langgraph',
          schedule_hours TEXT DEFAULT '',
          status TEXT DEFAULT 'active',
          created_at DATETIME DEFAULT (datetime('now')),
          updated_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          role TEXT DEFAULT '',
          is_controller BOOLEAN DEFAULT 0,
          parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          session_id TEXT,
          working_directory TEXT,
          custom_instructions TEXT DEFAULT '',
          new_session_per_run BOOLEAN DEFAULT 0,
          session_run_count INTEGER DEFAULT 0,
          session_max_runs INTEGER DEFAULT 10,
          session_token_count INTEGER DEFAULT 0,
          session_max_tokens INTEGER DEFAULT 400000,
          session_resume_timeout INTEGER DEFAULT 300,
          command_template TEXT DEFAULT NULL,
          command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini')),
          status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'waiting', 'error')),
          paused BOOLEAN DEFAULT 0,
          pid INTEGER,
          last_prompt TEXT,
          started_at DATETIME,
          finished_at DATETIME,
          created_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE knowledge_entries (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          tags TEXT DEFAULT '',
          importance TEXT DEFAULT 'medium' CHECK(importance IN ('high', 'medium', 'low')),
          created_by TEXT DEFAULT 'user',
          created_at DATETIME DEFAULT (datetime('now')),
          updated_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE agent_memories (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          session_id TEXT,
          content TEXT NOT NULL,
          tags TEXT DEFAULT '',
          scope TEXT DEFAULT 'private' CHECK(scope IN ('private', 'project')),
          created_at DATETIME DEFAULT (datetime('now')),
          expires_at DATETIME
        );

        CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content=agent_memories, content_rowid=rowid);

        INSERT INTO projects (id, name, task_description) VALUES ('legacy-project', 'legacy-project', 'legacy memory migration');
        INSERT INTO agents (id, project_id, name, role, working_directory, custom_instructions)
        VALUES ('legacy-agent', 'legacy-project', 'legacy-agent', 'legacy worker', '/tmp/legacy', 'stay focused');
        INSERT INTO agent_memories (id, agent_id, project_id, content, tags, scope)
        VALUES ('legacy-memory-1', 'legacy-agent', 'legacy-project', 'Remember the old deployment path', 'deploy,legacy', 'private');
      `);

    initializeDatabase(legacyDb);

    const migratedEntry = legacyDb
      .prepare(
        `SELECT owner_agent_id, title, content, tags
         FROM knowledge_entries
         WHERE project_id = ? AND owner_agent_id = ?`
      )
      .get('legacy-project', 'legacy-agent') as any;
    assert.ok(migratedEntry);
    assert.equal(migratedEntry.owner_agent_id, 'legacy-agent');
    assert.equal(migratedEntry.title, 'Agent Memory');
    assert.match(migratedEntry.content, /历史记忆迁移/);
    assert.match(migratedEntry.content, /Remember the old deployment path/);
    assert.match(String(migratedEntry.tags || ''), /agent-profile/);
    assert.match(String(migratedEntry.tags || ''), /deploy/);

    const legacyTable = legacyDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_memories'"
      )
      .get() as { name: string } | undefined;
    assert.equal(legacyTable, undefined);

    const legacyFts = legacyDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'"
      )
      .get() as { name: string } | undefined;
    assert.equal(legacyFts, undefined);
  } finally {
    legacyDb.close();
    cleanupLegacyFiles();
  }
});
