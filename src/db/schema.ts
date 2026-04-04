import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import logger from '../logger';

export function initializeDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      task_description TEXT NOT NULL,
      command_template TEXT DEFAULT 'cld',
      orchestrator_engine TEXT DEFAULT 'langgraph' CHECK(orchestrator_engine IN ('native', 'langgraph')),
      schedule_hours TEXT DEFAULT '',
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
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
      status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'waiting', 'error')),
      paused BOOLEAN DEFAULT 0,
      pid INTEGER,
      last_prompt TEXT,
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      created_by TEXT NOT NULL,
      assigned_to TEXT,
      priority INTEGER DEFAULT 1,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'pending', 'done', 'closed')),
      labels TEXT DEFAULT '',
      milestone_id TEXT,
      parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      event_type TEXT DEFAULT 'comment' CHECK(event_type IN ('comment', 'status_change', 'assignment', 'label_change')),
      meta TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      due_date TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed')),
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL CHECK(target_type IN ('issue', 'comment')),
      target_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now')),
      UNIQUE(target_type, target_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS conversation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      stream TEXT DEFAULT 'stdout' CHECK(stream IN ('stdin', 'stdout', 'stderr', 'cost')),
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orchestration_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      engine TEXT NOT NULL CHECK(engine IN ('native', 'langgraph')),
      decision TEXT NOT NULL,
      controller_agent_id TEXT,
      controller_started BOOLEAN DEFAULT 0,
      controller_run_id TEXT,
      controller_pid INTEGER,
      dispatch_count INTEGER DEFAULT 0,
      dispatch_summary TEXT DEFAULT '',
      reasons TEXT DEFAULT '',
      actions TEXT DEFAULT '',
      dispatch_results TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to, status);
    CREATE INDEX IF NOT EXISTS idx_issue_comments ON issue_comments(issue_id);
    CREATE INDEX IF NOT EXISTS idx_issue_comments_latest ON issue_comments(issue_id, event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
    CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      created_at DATETIME DEFAULT (datetime('now')),
      last_login_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS project_members (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member' CHECK(role IN ('owner', 'editor', 'member')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS knowledge_entries (
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
    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(project_id);

    CREATE TABLE IF NOT EXISTS agent_memories (
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
    CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project_scope ON agent_memories(project_id, scope);

    CREATE TABLE IF NOT EXISTS issue_relations (
      id TEXT PRIMARY KEY,
      from_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      to_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL CHECK(relation_type IN ('blocks', 'related_to')),
      created_by TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT (datetime('now')),
      UNIQUE(from_issue_id, to_issue_id, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_from ON issue_relations(from_issue_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON issue_relations(to_issue_id);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      subject TEXT DEFAULT '',
      body TEXT NOT NULL,
      status TEXT DEFAULT 'unread' CHECK(status IN ('unread', 'read')),
      reply_to_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_project ON agent_messages(project_id);

    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      template_data TEXT NOT NULL DEFAULT '{}',
      created_by TEXT DEFAULT 'system',
      is_builtin BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_logs_agent ON conversation_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_logs_run ON conversation_logs(run_id);
    CREATE INDEX IF NOT EXISTS idx_orch_runs_project_created ON orchestration_runs(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      risk_level TEXT DEFAULT 'medium' CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      decided_by TEXT,
      decision_note TEXT DEFAULT '',
      decided_at DATETIME,
      created_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_approval_project ON approval_requests(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_approval_agent ON approval_requests(agent_id);
  `);

  // Migration: add paused column if missing
  const cols = db.prepare("PRAGMA table_info(agents)").all() as any[];
  if (!cols.find((c: any) => c.name === 'paused')) {
    db.exec("ALTER TABLE agents ADD COLUMN paused BOOLEAN DEFAULT 0");
    logger.info('Migration: added paused column to agents table');
  }

  // Migration: add session_token_count and session_max_tokens columns if missing
  if (!cols.find((c: any) => c.name === 'session_token_count')) {
    db.exec("ALTER TABLE agents ADD COLUMN session_token_count INTEGER DEFAULT 0");
    logger.info('Migration: added session_token_count column to agents table');
  }
  if (!cols.find((c: any) => c.name === 'session_max_tokens')) {
    db.exec("ALTER TABLE agents ADD COLUMN session_max_tokens INTEGER DEFAULT 400000");
    logger.info('Migration: added session_max_tokens column to agents table');
  }

  // Migration: update session_max_tokens from 0 to 400000 for existing agents
  const updated = db.prepare("UPDATE agents SET session_max_tokens = 400000 WHERE session_max_tokens = 0").run();
  if (updated.changes > 0) {
    logger.info(`Migration: updated session_max_tokens from 0 to 400000 for ${updated.changes} agent(s)`);
  }

  // Migration: upgrade session_max_tokens from 200000 to 400000 (cost optimization)
  const upgraded = db.prepare("UPDATE agents SET session_max_tokens = 400000 WHERE session_max_tokens = 200000").run();
  if (upgraded.changes > 0) {
    logger.info(`Migration: upgraded session_max_tokens from 200000 to 400000 for ${upgraded.changes} agent(s)`);
  }

  // Migration: add session_resume_timeout column if missing (default 300s = 5 minutes)
  if (!cols.find((c: any) => c.name === 'session_resume_timeout')) {
    db.exec("ALTER TABLE agents ADD COLUMN session_resume_timeout INTEGER DEFAULT 300");
    logger.info('Migration: added session_resume_timeout column to agents table');
  }

  // Migration: add command_template column to agents if missing
  if (!cols.find((c: any) => c.name === 'command_template')) {
    db.exec("ALTER TABLE agents ADD COLUMN command_template TEXT DEFAULT NULL");
    logger.info('Migration: added command_template column to agents table');
  }

  // Migration: add parent_agent_id column to agents if missing
  if (!cols.find((c: any) => c.name === 'parent_agent_id')) {
    db.exec("ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id)");
    logger.info('Migration: added parent_agent_id column to agents table');
  }

  // Migration: fix orphan agents — non-controller agents with no parent should be assigned to their project's controller
  {
    const orphanFixed = db.prepare(`
      UPDATE agents SET parent_agent_id = (
        SELECT c.id FROM agents c WHERE c.project_id = agents.project_id AND c.is_controller = 1 LIMIT 1
      )
      WHERE parent_agent_id IS NULL
        AND is_controller = 0
        AND EXISTS (SELECT 1 FROM agents c WHERE c.project_id = agents.project_id AND c.is_controller = 1)
    `).run();
    if (orphanFixed.changes > 0) {
      logger.info(`Migration: assigned ${orphanFixed.changes} orphan agent(s) to their project controller`);
    }
  }

  // Migration: add orchestrator_engine column to projects if missing
  const projectCols = db.prepare("PRAGMA table_info(projects)").all() as any[];
  if (!projectCols.find((c: any) => c.name === 'orchestrator_engine')) {
    db.exec("ALTER TABLE projects ADD COLUMN orchestrator_engine TEXT DEFAULT 'langgraph'");
    logger.info('Migration: added orchestrator_engine column to projects table');
  }
  if (!projectCols.find((c: any) => c.name === 'owner_id')) {
    db.exec("ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL");
    logger.info('Migration: added owner_id column to projects table');
  }
  if (!projectCols.find((c: any) => c.name === 'color')) {
    db.exec("ALTER TABLE projects ADD COLUMN color TEXT DEFAULT '#4A90E2'");
    logger.info('Migration: added color column to projects table');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member' CHECK(role IN ('owner', 'editor', 'member')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
  `);

  // Migration: add 'editor' to project_members role CHECK constraint
  // SQLite can't ALTER CHECK constraints, so recreate the table if needed
  try {
    // Test if 'editor' is accepted — if not, the old CHECK constraint is in place
    db.exec("INSERT INTO project_members (id, project_id, user_id, role) VALUES ('__test_editor__', '__none__', '__none__', 'editor')");
    db.exec("DELETE FROM project_members WHERE id = '__test_editor__'");
  } catch {
    // Old CHECK constraint rejects 'editor' — recreate table
    db.exec(`
      CREATE TABLE project_members_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT DEFAULT 'member' CHECK(role IN ('owner', 'editor', 'member')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, user_id)
      );
      INSERT INTO project_members_new SELECT * FROM project_members;
      DROP TABLE project_members;
      ALTER TABLE project_members_new RENAME TO project_members;
      CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
    `);
    logger.info('Migration: updated project_members role constraint to include editor');
  }

  // Migration: normalize invalid orchestrator_engine values
  const normalizedEngines = db.prepare(
    "UPDATE projects SET orchestrator_engine = 'langgraph' WHERE orchestrator_engine IS NULL OR orchestrator_engine NOT IN ('native', 'langgraph')"
  ).run();
  if (normalizedEngines.changes > 0) {
    logger.info(`Migration: normalized orchestrator_engine for ${normalizedEngines.changes} project(s)`);
  }

  // Migration: add acknowledged_at column to issues if missing
  const issueCols = db.prepare("PRAGMA table_info(issues)").all() as any[];
  if (!issueCols.find((c: any) => c.name === 'acknowledged_at')) {
    db.exec("ALTER TABLE issues ADD COLUMN acknowledged_at TEXT DEFAULT NULL");
    logger.info('Migration: added acknowledged_at column to issues table');
  }

  // Migration: add parent_id column to issues if missing
  if (!issueCols.find((c: any) => c.name === 'parent_id')) {
    db.exec("ALTER TABLE issues ADD COLUMN parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)");
    logger.info('Migration: added parent_id column to issues table');
  }

  // Migration: fix issues CHECK constraint to include 'pending' status
  // SQLite doesn't support ALTER CHECK, so we rebuild the table if the constraint is missing.
  // IMPORTANT: must disable foreign_keys during table rebuild to avoid breaking FK references.
  const issuesTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='issues'").get() as any;
  if (issuesTableSql && !issuesTableSql.sql.includes("'pending'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE issues RENAME TO issues_old;
      CREATE TABLE issues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        assigned_to TEXT,
        priority INTEGER DEFAULT 1,
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'pending', 'done', 'closed')),
        labels TEXT DEFAULT '',
        milestone_id TEXT,
        acknowledged_at DATETIME,
        parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO issues SELECT * FROM issues_old;
      DROP TABLE issues_old;
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to, status);
      CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt issues table with pending status in CHECK constraint');
  }

  // Migration: fix broken FK references after prior table rebuild
  // If issue_comments FK still references issues_old (which no longer exists), rebuild issue_comments too.
  const commentsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='issue_comments'").get() as any;
  if (commentsTableSql && commentsTableSql.sql.includes('issues_old')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE issue_comments RENAME TO issue_comments_old;
      CREATE TABLE issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        event_type TEXT DEFAULT 'comment' CHECK(event_type IN ('comment', 'status_change', 'assignment', 'label_change')),
        meta TEXT DEFAULT '',
        created_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO issue_comments SELECT * FROM issue_comments_old;
      DROP TABLE issue_comments_old;
      CREATE INDEX IF NOT EXISTS idx_issue_comments ON issue_comments(issue_id);
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt issue_comments table to fix FK references');
  }

  // Migration: fix agents CHECK constraint to include 'waiting' status
  const agentsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get() as any;
  if (agentsTableSql && !agentsTableSql.sql.includes("'waiting'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE agents RENAME TO agents_old;
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
        status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'waiting', 'error')),
        paused BOOLEAN DEFAULT 0,
        pid INTEGER,
        last_prompt TEXT,
        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO agents (
        id, project_id, name, role, is_controller, parent_agent_id, session_id, working_directory,
        custom_instructions, new_session_per_run, session_run_count, session_max_runs,
        session_token_count, session_max_tokens, session_resume_timeout, command_template,
        status, paused, pid, last_prompt, started_at, finished_at, created_at
      )
      SELECT
        id, project_id, name, role, is_controller, parent_agent_id, session_id, working_directory,
        custom_instructions, new_session_per_run, session_run_count, session_max_runs,
        session_token_count, session_max_tokens, session_resume_timeout, command_template,
        status, paused, pid, last_prompt, started_at, finished_at, created_at
      FROM agents_old;
      DROP TABLE agents_old;
      CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
      CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt agents table with waiting status in CHECK constraint');
  }

  // Migration: fix broken FK references after agents table rebuild
  const logsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_logs'").get() as any;
  if (logsTableSql && logsTableSql.sql.includes('agents_old')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE conversation_logs RENAME TO conversation_logs_old;
      CREATE TABLE conversation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        content TEXT NOT NULL,
        stream TEXT DEFAULT 'stdout' CHECK(stream IN ('stdin', 'stdout', 'stderr', 'cost')),
        created_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO conversation_logs SELECT * FROM conversation_logs_old;
      DROP TABLE conversation_logs_old;
      CREATE INDEX IF NOT EXISTS idx_logs_agent ON conversation_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_logs_run ON conversation_logs(run_id);
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt conversation_logs table to fix FK references');
  }

  const memoriesTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_memories'").get() as any;
  if (memoriesTableSql && memoriesTableSql.sql.includes('agents_old')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE agent_memories RENAME TO agent_memories_old;
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
      INSERT INTO agent_memories SELECT * FROM agent_memories_old;
      DROP TABLE agent_memories_old;
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id);
      CREATE INDEX IF NOT EXISTS idx_memories_project_scope ON agent_memories(project_id, scope);
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt agent_memories table to fix FK references');
  }

  // Migration: set default Sonnet model for controller agents without a --model flag
  const ctrlModelUpdated = db.prepare(
    "UPDATE agents SET command_template = COALESCE(command_template, 'cld') || ' --model claude-sonnet-4-6' WHERE is_controller = 1 AND (command_template IS NULL OR (command_template NOT LIKE '%--model%'))"
  ).run();
  if (ctrlModelUpdated.changes > 0) {
    logger.info(`Migration: set default Sonnet model for ${ctrlModelUpdated.changes} controller agent(s)`);
  }

  // Migration: create FTS5 virtual table for knowledge full-text search
  const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'").get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, content, content=knowledge_entries, content_rowid=rowid);
    `);
    // Populate FTS index from existing data
    db.exec(`
      INSERT INTO knowledge_fts(rowid, title, content)
      SELECT rowid, title, content FROM knowledge_entries;
    `);
    // Create triggers to keep FTS in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
        INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
    `);
    logger.info('Migration: created FTS5 virtual table for knowledge full-text search');
  }

  // Migration: create FTS5 virtual table for agent memories full-text search
  const memFtsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
  if (!memFtsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content=agent_memories, content_rowid=rowid);
    `);
    db.exec(`
      INSERT INTO memories_fts(rowid, content, tags)
      SELECT rowid, content, tags FROM agent_memories;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON agent_memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON agent_memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON agent_memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
    `);
    logger.info('Migration: created FTS5 virtual table for agent memories full-text search');
  }

  // Migration: add user_id column to sessions if missing
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as any[];
  if (!sessionCols.find((c: any) => c.name === 'user_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
    logger.info('Migration: added user_id column to sessions table');
  }

  const firstAdmin = db.prepare(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1"
  ).get() as { id: string } | undefined;
  if (firstAdmin?.id) {
    const ownerSeeded = db.prepare(
      "UPDATE projects SET owner_id = ? WHERE owner_id IS NULL"
    ).run(firstAdmin.id);
    if (ownerSeeded.changes > 0) {
      logger.info(`Migration: assigned owner_id to ${ownerSeeded.changes} project(s) using first admin`);
    }
  }

  const ownedProjects = db.prepare(
    'SELECT id, owner_id FROM projects WHERE owner_id IS NOT NULL'
  ).all() as Array<{ id: string; owner_id: string }>;
  const upsertOwnerMember = db.prepare(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES (?, ?, ?, 'owner')
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'owner'`
  );
  for (const project of ownedProjects) {
    upsertOwnerMember.run(randomUUID(), project.id, project.owner_id);
  }

  // Migration: seed builtin project templates
  const templateCount = (db.prepare('SELECT COUNT(*) as c FROM project_templates WHERE is_builtin = 1').get() as any).c;
  if (templateCount === 0) {
    const builtinTemplates = [
      {
        id: 'tpl-bugfix',
        name: 'Bug修复流程',
        description: '标准bug修复流程：复现 → 定位 → 修复 → 回归测试',
        template_data: JSON.stringify({
          agents: [
            { name: 'dev', role: '开发Agent。负责定位和修复bug。' },
            { name: 'test', role: '测试Agent。负责复现bug和回归测试。' },
          ],
          issues: [
            { title: '复现bug', assigned_to_role: 'test', body: '复现bug，记录复现步骤和环境信息。' },
            { title: '定位根因', assigned_to_role: 'dev', body: '分析代码定位bug根因。' },
            { title: '修复实现', assigned_to_role: 'dev', body: '编写修复代码并通过编译。' },
            { title: '回归测试', assigned_to_role: 'test', body: '验证修复是否生效，确认无回归问题。' },
          ],
        }),
      },
      {
        id: 'tpl-feature',
        name: '功能开发流程',
        description: '完整功能开发流程：需求分析 → 技术设计 → 实现 → 测试',
        template_data: JSON.stringify({
          agents: [
            { name: 'product', role: '产品Agent。负责需求分析和产品规划。' },
            { name: 'dev', role: '开发Agent。负责技术设计和代码实现。' },
            { name: 'test', role: '测试Agent。负责编写测试用例和质量保障。' },
          ],
          issues: [
            { title: '需求分析', assigned_to_role: 'product', body: '分析功能需求，输出需求文档。' },
            { title: '技术设计', assigned_to_role: 'dev', body: '基于需求文档进行技术方案设计。' },
            { title: '代码实现', assigned_to_role: 'dev', body: '按技术方案编写代码实现功能。' },
            { title: '测试验证', assigned_to_role: 'test', body: '编写和运行测试用例，验证功能正确性。' },
          ],
        }),
      },
      {
        id: 'tpl-review',
        name: '代码审查流程',
        description: '代码审查流程：阅读代码 → 发现问题 → 出审查报告',
        template_data: JSON.stringify({
          agents: [
            { name: 'reviewer', role: '代码审查Agent。阅读和审查代码，发现潜在问题。' },
            { name: 'dev', role: '开发Agent。根据审查意见修复代码问题。' },
          ],
          issues: [
            { title: '阅读代码', assigned_to_role: 'reviewer', body: '阅读指定代码范围，理解逻辑和结构。' },
            { title: '发现问题', assigned_to_role: 'reviewer', body: '记录发现的代码问题、风格问题和潜在bug。' },
            { title: '输出审查报告', assigned_to_role: 'reviewer', body: '汇总所有问题，输出结构化审查报告。' },
          ],
        }),
      },
    ];

    const insertStmt = db.prepare(
      'INSERT INTO project_templates (id, name, description, template_data, created_by, is_builtin) VALUES (?, ?, ?, ?, ?, 1)'
    );
    for (const t of builtinTemplates) {
      insertStmt.run(t.id, t.name, t.description, t.template_data, 'system');
    }
    logger.info(`Migration: seeded ${builtinTemplates.length} builtin project templates`);
  }

  // Reset any agents stuck in 'running' from a previous crash
  const reset = db.prepare("UPDATE agents SET status = 'idle', pid = NULL WHERE status = 'running'");
  const changes = reset.run();
  if (changes.changes > 0) {
    logger.info(`Reset ${changes.changes} agent(s) from 'running' to 'idle' (stale from previous run)`);
  }
}
