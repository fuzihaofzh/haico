import Database from 'better-sqlite3';
import logger from '../logger';

export function initializeDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      task_description TEXT NOT NULL,
      controller_interval_min INTEGER DEFAULT 0,
      command_template TEXT DEFAULT 'cld',
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
      session_max_tokens INTEGER DEFAULT 0,
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
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'done', 'closed')),
      labels TEXT DEFAULT '',
      milestone_id TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to, status);
    CREATE INDEX IF NOT EXISTS idx_issue_comments ON issue_comments(issue_id);
    CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE INDEX IF NOT EXISTS idx_logs_agent ON conversation_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_logs_run ON conversation_logs(run_id);
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
    db.exec("ALTER TABLE agents ADD COLUMN session_max_tokens INTEGER DEFAULT 0");
    logger.info('Migration: added session_max_tokens column to agents table');
  }

  // Reset any agents stuck in 'running' from a previous crash
  const reset = db.prepare("UPDATE agents SET status = 'idle', pid = NULL WHERE status = 'running'");
  const changes = reset.run();
  if (changes.changes > 0) {
    logger.info(`Reset ${changes.changes} agent(s) from 'running' to 'idle' (stale from previous run)`);
  }
}
