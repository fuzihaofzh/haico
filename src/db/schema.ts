import Database from 'better-sqlite3';
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
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT DEFAULT '',
      is_controller BOOLEAN DEFAULT 0,
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
      status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'error', 'stopped')),
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
    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to, status);
    CREATE INDEX IF NOT EXISTS idx_issue_comments ON issue_comments(issue_id);
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

    CREATE INDEX IF NOT EXISTS idx_logs_agent ON conversation_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_logs_run ON conversation_logs(run_id);
    CREATE INDEX IF NOT EXISTS idx_orch_runs_project_created ON orchestration_runs(project_id, created_at DESC);
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

  // Migration: add orchestrator_engine column to projects if missing
  const projectCols = db.prepare("PRAGMA table_info(projects)").all() as any[];
  if (!projectCols.find((c: any) => c.name === 'orchestrator_engine')) {
    db.exec("ALTER TABLE projects ADD COLUMN orchestrator_engine TEXT DEFAULT 'langgraph'");
    logger.info('Migration: added orchestrator_engine column to projects table');
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

  // Reset any agents stuck in 'running' from a previous crash
  const reset = db.prepare("UPDATE agents SET status = 'idle', pid = NULL WHERE status = 'running'");
  const changes = reset.run();
  if (changes.changes > 0) {
    logger.info(`Reset ${changes.changes} agent(s) from 'running' to 'idle' (stale from previous run)`);
  }
}
