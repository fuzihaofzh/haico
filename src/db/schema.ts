import Database from 'better-sqlite3';
import logger from '../logger';
import {
  detectCommandTypeFromCommand,
  resolveCommandType,
} from '../services/command-profiles';
import { getAdapterRegistry } from '../services/adapters';
import { seedKnowledgeFts, seedLegacyAgentKnowledge, seedProjectOwners, seedBuiltinProjectTemplates } from './seed';
import { runStartupMaintenance } from './maintenance';

export interface InitializeDatabaseOptions {
  skipStartupMaintenance?: boolean;
}

export function initializeDatabase(db: Database.Database, options: InitializeDatabaseOptions = {}): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS command_profiles (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'claude' CHECK(type IN ('claude', 'codex', 'gemini', 'omp')),
      scenario TEXT DEFAULT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      task_description TEXT NOT NULL,
      command_profile_id TEXT REFERENCES command_profiles(id) ON DELETE SET NULL,
      command_template TEXT DEFAULT 'cld',
      command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini', 'omp')),
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
      constraints_json TEXT DEFAULT '{}',
      context_json TEXT DEFAULT '{}',
      capabilities_json TEXT DEFAULT '{}',
      executor_preferences_json TEXT DEFAULT '{}',
      new_session_per_run BOOLEAN DEFAULT 0,
      session_run_count INTEGER DEFAULT 0,
      session_max_runs INTEGER DEFAULT 10,
      session_token_count INTEGER DEFAULT 0,
      session_max_tokens INTEGER DEFAULT 400000,
      session_resume_timeout INTEGER DEFAULT 300,
      command_profile_id TEXT REFERENCES command_profiles(id) ON DELETE SET NULL,
      command_template TEXT DEFAULT NULL,
      command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini', 'omp')),
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

    CREATE TABLE IF NOT EXISTS executor_profiles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      executor_type TEXT NOT NULL DEFAULT 'claude' CHECK(executor_type IN ('claude', 'codex', 'gemini', 'shell', 'omp')),
      command_template TEXT NOT NULL,
      command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini', 'omp')),
      working_directory TEXT,
      env_json TEXT DEFAULT '{}',
      session_policy_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      target_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      task_type TEXT NOT NULL,
      reason TEXT DEFAULT '',
      prompt TEXT NOT NULL,
      system_prompt TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'blocked', 'running', 'completed', 'failed', 'cancelled', 'stale')),
      scheduled_at DATETIME,
      claimed_at DATETIME,
      started_at DATETIME,
      finished_at DATETIME,
      executor_profile_id TEXT REFERENCES executor_profiles(id) ON DELETE SET NULL,
      executor_snapshot_json TEXT DEFAULT '{}',
      context_snapshot_json TEXT DEFAULT '{}',
      metadata_json TEXT DEFAULT '{}',
      dedupe_key TEXT,
      current_task_run_id TEXT,
      failure_kind TEXT,
      failure_message TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      executor_profile_id TEXT REFERENCES executor_profiles(id) ON DELETE SET NULL,
      run_id TEXT NOT NULL,
      attempt INTEGER DEFAULT 1,
      status TEXT DEFAULT 'starting' CHECK(status IN ('starting', 'running', 'completed', 'failed', 'cancelled')),
      pid INTEGER,
      session_id TEXT,
      prompt_snapshot TEXT NOT NULL,
      command_snapshot TEXT NOT NULL,
      exit_code INTEGER,
      failure_kind TEXT,
      failure_message TEXT,
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      dependency_type TEXT NOT NULL DEFAULT 'blocks' CHECK(dependency_type IN ('blocks')),
      PRIMARY KEY (task_id, depends_on_task_id, dependency_type)
    );

    CREATE TABLE IF NOT EXISTS executor_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      executor_profile_id TEXT NOT NULL REFERENCES executor_profiles(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      run_count INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      last_used_at DATETIME DEFAULT (datetime('now')),
      reset_reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now')),
      UNIQUE(agent_id, executor_profile_id)
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
      backoff_ms INTEGER DEFAULT 0,
      backoff_reason TEXT DEFAULT '',
      backoff_label TEXT DEFAULT '',
      actions TEXT DEFAULT '',
      dispatch_results TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_command_profiles_name ON command_profiles(name);
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
      owner_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '',
      importance TEXT DEFAULT 'medium' CHECK(importance IN ('high', 'medium', 'low')),
      category TEXT DEFAULT 'architecture',
      expires_at DATETIME,
      last_verified_at DATETIME,
      verified_by TEXT,
      status TEXT DEFAULT 'active',
      created_by TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(project_id);

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
    CREATE INDEX IF NOT EXISTS idx_logs_stream_run ON conversation_logs(stream, run_id, id);
    CREATE INDEX IF NOT EXISTS idx_orch_runs_project_created ON orchestration_runs(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executor_profiles_project ON executor_profiles(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(target_agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_dedupe_key ON tasks(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, attempt);
    CREATE INDEX IF NOT EXISTS idx_task_runs_agent_status ON task_runs(agent_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_runs_run ON task_runs(run_id);
    CREATE INDEX IF NOT EXISTS idx_executor_sessions_agent ON executor_sessions(agent_id, executor_profile_id);

    CREATE TABLE IF NOT EXISTS executive_summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'final', 'archived')),
      created_by TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_exec_summary_project ON executive_summaries(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_exec_summary_period ON executive_summaries(project_id, period_end DESC);

    CREATE TABLE IF NOT EXISTS executive_summary_blocks (
      id TEXT PRIMARY KEY,
      summary_id TEXT NOT NULL REFERENCES executive_summaries(id) ON DELETE CASCADE,
      block_key TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      order_index INTEGER DEFAULT 0,
      UNIQUE(summary_id, block_key)
    );
    CREATE INDEX IF NOT EXISTS idx_exec_blocks_summary ON executive_summary_blocks(summary_id);

    CREATE TABLE IF NOT EXISTS domain_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_domain_events_project_time ON domain_events(project_id, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_domain_events_correlation ON domain_events(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_domain_events_type ON domain_events(type);
  `);

  // Migration: add paused column if missing
  const cols = db.prepare("PRAGMA table_info(agents)").all() as any[];
  const orchestrationRunCols = db.prepare("PRAGMA table_info(orchestration_runs)").all() as any[];
  if (!cols.find((c: any) => c.name === 'paused')) {
    db.exec("ALTER TABLE agents ADD COLUMN paused BOOLEAN DEFAULT 0");
    logger.info('Migration: added paused column to agents table');
  }
  for (const col of ['constraints_json', 'context_json', 'capabilities_json', 'executor_preferences_json']) {
    if (!cols.find((c: any) => c.name === col)) {
      db.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT DEFAULT '{}'`);
      logger.info(`Migration: added ${col} column to agents table`);
    }
  }

  if (!orchestrationRunCols.find((c: any) => c.name === 'backoff_ms')) {
    db.exec("ALTER TABLE orchestration_runs ADD COLUMN backoff_ms INTEGER DEFAULT 0");
    logger.info('Migration: added backoff_ms column to orchestration_runs table');
  }
  if (!orchestrationRunCols.find((c: any) => c.name === 'backoff_reason')) {
    db.exec("ALTER TABLE orchestration_runs ADD COLUMN backoff_reason TEXT DEFAULT ''");
    logger.info('Migration: added backoff_reason column to orchestration_runs table');
  }
  if (!orchestrationRunCols.find((c: any) => c.name === 'backoff_label')) {
    db.exec("ALTER TABLE orchestration_runs ADD COLUMN backoff_label TEXT DEFAULT ''");
    logger.info('Migration: added backoff_label column to orchestration_runs table');
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

  // Migration: add command_type column to agents if missing
  if (!cols.find((c: any) => c.name === 'command_type')) {
    db.exec("ALTER TABLE agents ADD COLUMN command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini'))");
    logger.info('Migration: added command_type column to agents table');
  }

  const agentsMissingCommandType = db.prepare(
    'SELECT id, command_template FROM agents WHERE command_type IS NULL AND command_template IS NOT NULL'
  ).all() as Array<{ id: string; command_template: string | null }>;
  if (agentsMissingCommandType.length > 0) {
    const updateAgentCommandType = db.prepare('UPDATE agents SET command_type = ? WHERE id = ?');
    let backfilledCommandTypeCount = 0;
    for (const agent of agentsMissingCommandType) {
      const detectedType = detectCommandTypeFromCommand(agent.command_template);
      if (!detectedType) continue;
      updateAgentCommandType.run(detectedType, agent.id);
      backfilledCommandTypeCount += 1;
    }
    if (backfilledCommandTypeCount > 0) {
      logger.info(`Migration: backfilled command_type for ${backfilledCommandTypeCount} agent(s)`);
    }
  }

  // Migration: add parent_agent_id column to agents if missing
  if (!cols.find((c: any) => c.name === 'parent_agent_id')) {
    db.exec("ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id)");
    logger.info('Migration: added parent_agent_id column to agents table');

    // One-time backfill for databases that predate explicit hierarchy support.
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
  if (!projectCols.find((c: any) => c.name === 'command_type')) {
    db.exec("ALTER TABLE projects ADD COLUMN command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini', 'omp'))");
    logger.info('Migration: added command_type column to projects table');
  }

  const projectsMissingCommandType = db.prepare(
    'SELECT id, command_template FROM projects WHERE command_type IS NULL AND command_template IS NOT NULL'
  ).all() as Array<{ id: string; command_template: string | null }>;
  if (projectsMissingCommandType.length > 0) {
    const updateProjectCommandType = db.prepare('UPDATE projects SET command_type = ? WHERE id = ?');
    let backfilledProjectCommandTypeCount = 0;
    for (const project of projectsMissingCommandType) {
      const detectedType = detectCommandTypeFromCommand(project.command_template);
      if (!detectedType) continue;
      updateProjectCommandType.run(detectedType, project.id);
      backfilledProjectCommandTypeCount += 1;
    }
    if (backfilledProjectCommandTypeCount > 0) {
      logger.info(`Migration: backfilled command_type for ${backfilledProjectCommandTypeCount} project(s)`);
    }
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
  // SQLite can't ALTER CHECK constraints, so recreate the table if needed.
  // Temporarily disable FK enforcement so the test INSERT doesn't fail on
  // missing parent rows (the old code used dummy project_id/user_id).
  const savedFkState = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
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
  } finally {
    db.pragma(`foreign_keys = ${savedFkState}`);
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

  // Migration: add Knowledge Base lifecycle fields if missing
  const knowledgeCols = db.prepare("PRAGMA table_info(knowledge_entries)").all() as any[];
  const hasKnowledgeCol = (name: string) => knowledgeCols.some((c: any) => c.name === name);
  if (!hasKnowledgeCol('owner_agent_id')) {
    db.exec("ALTER TABLE knowledge_entries ADD COLUMN owner_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE");
    logger.info('Migration: added owner_agent_id column to knowledge_entries table');
  }
  if (!hasKnowledgeCol('category')) {
    db.exec("ALTER TABLE knowledge_entries ADD COLUMN category TEXT DEFAULT 'architecture'");
    logger.info('Migration: added category column to knowledge_entries table');
  }
  if (!hasKnowledgeCol('expires_at')) {
    db.exec("ALTER TABLE knowledge_entries ADD COLUMN expires_at DATETIME");
    logger.info('Migration: added expires_at column to knowledge_entries table');
  }
  if (!hasKnowledgeCol('last_verified_at')) {
    db.exec("ALTER TABLE knowledge_entries ADD COLUMN last_verified_at DATETIME");
    logger.info('Migration: added last_verified_at column to knowledge_entries table');
  }
  if (!hasKnowledgeCol('verified_by')) {
    db.exec("ALTER TABLE knowledge_entries ADD COLUMN verified_by TEXT");
    logger.info('Migration: added verified_by column to knowledge_entries table');
  }
  if (!hasKnowledgeCol('status')) {
    db.exec("ALTER TABLE knowledge_entries ADD COLUMN status TEXT DEFAULT 'active'");
    logger.info('Migration: added status column to knowledge_entries table');
  }
  db.exec(`
    UPDATE knowledge_entries
    SET category = 'architecture'
    WHERE category IS NULL OR trim(category) = '';

    UPDATE knowledge_entries
    SET status = 'active'
    WHERE status IS NULL OR status NOT IN ('active', 'stale', 'archived');

    UPDATE knowledge_entries
    SET expires_at = CASE
      WHEN category = 'convention' THEN datetime(COALESCE(updated_at, created_at, datetime('now')), '+90 days')
      WHEN category = 'reference' THEN datetime(COALESCE(updated_at, created_at, datetime('now')), '+180 days')
      ELSE datetime(COALESCE(updated_at, created_at, datetime('now')), '+30 days')
    END
    WHERE expires_at IS NULL AND last_verified_at IS NULL;

    UPDATE knowledge_entries
    SET last_verified_at = COALESCE(updated_at, created_at, datetime('now'))
    WHERE last_verified_at IS NULL;

    UPDATE knowledge_entries
    SET verified_by = COALESCE(NULLIF(created_by, ''), 'user')
    WHERE verified_by IS NULL OR trim(verified_by) = '';

    CREATE INDEX IF NOT EXISTS idx_knowledge_project_status ON knowledge_entries(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_owner ON knowledge_entries(owner_agent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_agent_owner_unique
      ON knowledge_entries(project_id, owner_agent_id)
      WHERE owner_agent_id IS NOT NULL;
  `);

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

  const commandProfilesTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='command_profiles'").get() as any;
  if (commandProfilesTableSql && !commandProfilesTableSql.sql.includes("'gemini'")) {
    db.exec(`
      ALTER TABLE command_profiles RENAME TO command_profiles_old;
      CREATE TABLE command_profiles (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'claude' CHECK(type IN ('claude', 'codex', 'gemini')),
        scenario TEXT DEFAULT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO command_profiles (id, name, command, type, scenario, config_json, created_at, updated_at)
      SELECT id, name, command, type, NULL, '{}', created_at, updated_at
      FROM command_profiles_old;
      DROP TABLE command_profiles_old;
      CREATE INDEX IF NOT EXISTS idx_command_profiles_name ON command_profiles(name);
    `);
    logger.info('Migration: rebuilt command_profiles table to include gemini type');
  }

  const commandProfileCols = db.prepare("PRAGMA table_info(command_profiles)").all() as any[];
  if (!commandProfileCols.find((c: any) => c.name === 'scenario')) {
    db.exec("ALTER TABLE command_profiles ADD COLUMN scenario TEXT DEFAULT NULL");
    logger.info('Migration: added scenario column to command_profiles table');
  }
  if (!commandProfileCols.find((c: any) => c.name === 'config_json')) {
    db.exec("ALTER TABLE command_profiles ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'");
    logger.info('Migration: added config_json column to command_profiles table');
  }

  const commandProfileProjectCols = db.prepare("PRAGMA table_info(projects)").all() as any[];
  if (!commandProfileProjectCols.find((c: any) => c.name === 'command_profile_id')) {
    db.exec("ALTER TABLE projects ADD COLUMN command_profile_id TEXT REFERENCES command_profiles(id) ON DELETE SET NULL");
    logger.info('Migration: added command_profile_id column to projects table');
  }

  // Migration: fix agents CHECK constraint to include 'waiting' status and expanded command_type values
  const agentsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get() as any;
  if (agentsTableSql && (!agentsTableSql.sql.includes("'waiting'") || !agentsTableSql.sql.includes("'omp'"))) {
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
        constraints_json TEXT DEFAULT '{}',
        context_json TEXT DEFAULT '{}',
        capabilities_json TEXT DEFAULT '{}',
        executor_preferences_json TEXT DEFAULT '{}',
        new_session_per_run BOOLEAN DEFAULT 0,
        session_run_count INTEGER DEFAULT 0,
        session_max_runs INTEGER DEFAULT 10,
        session_token_count INTEGER DEFAULT 0,
        session_max_tokens INTEGER DEFAULT 400000,
        session_resume_timeout INTEGER DEFAULT 300,
        command_profile_id TEXT REFERENCES command_profiles(id) ON DELETE SET NULL,
        command_template TEXT DEFAULT NULL,
        command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini', 'omp')),
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
        custom_instructions, constraints_json, context_json, capabilities_json, executor_preferences_json,
        new_session_per_run, session_run_count, session_max_runs,
        session_token_count, session_max_tokens, session_resume_timeout, command_profile_id, command_template, command_type,
        status, paused, pid, last_prompt, started_at, finished_at, created_at
      )
      SELECT
        id, project_id, name, role, is_controller, parent_agent_id, session_id, working_directory,
        custom_instructions, '{}', '{}', '{}', '{}',
        new_session_per_run, session_run_count, session_max_runs,
        session_token_count, session_max_tokens, session_resume_timeout, NULL, command_template, command_type,
        status, paused, pid, last_prompt, started_at, finished_at, created_at
      FROM agents_old;
      DROP TABLE agents_old;
      CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
      CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt agents table with updated status and command_type constraints');
  }

  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as any[];
  if (!agentCols.find((c: any) => c.name === 'command_profile_id')) {
    db.exec("ALTER TABLE agents ADD COLUMN command_profile_id TEXT REFERENCES command_profiles(id) ON DELETE SET NULL");
    logger.info('Migration: added command_profile_id column to agents table');
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

  // Migration: fix broken FK references in tasks, task_runs, executor_sessions, knowledge_entries
  // (Same root cause as conversation_logs: agents table rename left dangling "agents_old" refs)
  const tasksTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as any;
  if (tasksTableSql && tasksTableSql.sql.includes('agents_old')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        source_ref TEXT,
        task_type TEXT NOT NULL,
        reason TEXT DEFAULT '',
        prompt TEXT NOT NULL,
        system_prompt TEXT,
        priority INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'blocked', 'running', 'completed', 'failed', 'cancelled', 'stale')),
        scheduled_at DATETIME,
        claimed_at DATETIME,
        started_at DATETIME,
        finished_at DATETIME,
        executor_profile_id TEXT REFERENCES executor_profiles(id) ON DELETE SET NULL,
        executor_snapshot_json TEXT DEFAULT '{}',
        context_snapshot_json TEXT DEFAULT '{}',
        metadata_json TEXT DEFAULT '{}',
        dedupe_key TEXT,
        current_task_run_id TEXT,
        failure_kind TEXT,
        failure_message TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO tasks SELECT * FROM tasks_old;
      DROP TABLE tasks_old;
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt tasks table to fix FK references');
  }

  const taskRunsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_runs'").get() as any;
  if (taskRunsTableSql && taskRunsTableSql.sql.includes('agents_old')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE task_runs RENAME TO task_runs_old;
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        executor_profile_id TEXT REFERENCES executor_profiles(id) ON DELETE SET NULL,
        run_id TEXT NOT NULL,
        attempt INTEGER DEFAULT 1,
        status TEXT DEFAULT 'starting' CHECK(status IN ('starting', 'running', 'completed', 'failed', 'cancelled')),
        pid INTEGER,
        session_id TEXT,
        prompt_snapshot TEXT NOT NULL,
        command_snapshot TEXT NOT NULL,
        exit_code INTEGER,
        failure_kind TEXT,
        failure_message TEXT,
        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO task_runs SELECT * FROM task_runs_old;
      DROP TABLE task_runs_old;
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt task_runs table to fix FK references');
  }

  const execSessionsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='executor_sessions'").get() as any;
  if (execSessionsTableSql && execSessionsTableSql.sql.includes('agents_old')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE executor_sessions RENAME TO executor_sessions_old;
      CREATE TABLE executor_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        executor_profile_id TEXT NOT NULL REFERENCES executor_profiles(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        run_count INTEGER DEFAULT 0,
        token_count INTEGER DEFAULT 0,
        last_used_at DATETIME DEFAULT (datetime('now')),
        reset_reason TEXT DEFAULT '',
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(agent_id, executor_profile_id)
      );
      INSERT INTO executor_sessions SELECT * FROM executor_sessions_old;
      DROP TABLE executor_sessions_old;
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt executor_sessions table to fix FK references');
  }

  const knowledgeTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_entries'").get() as any;
  if (knowledgeTableSql && knowledgeTableSql.sql.includes('agents_old')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE knowledge_entries RENAME TO knowledge_entries_old;
      CREATE TABLE knowledge_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tags TEXT DEFAULT '',
        importance TEXT DEFAULT 'medium' CHECK(importance IN ('high', 'medium', 'low')),
        category TEXT DEFAULT 'architecture',
        expires_at DATETIME,
        last_verified_at DATETIME,
        verified_by TEXT,
        status TEXT DEFAULT 'active',
        created_by TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO knowledge_entries SELECT * FROM knowledge_entries_old;
      DROP TABLE knowledge_entries_old;
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt knowledge_entries table to fix FK references');
  }

  // Migration: normalize controller command_type and only add Sonnet defaults for Claude controllers.
  const controllerAgents = db.prepare(
    'SELECT id, command_template, command_type FROM agents WHERE is_controller = 1'
  ).all() as Array<{ id: string; command_template: string | null; command_type: string | null }>;
  if (controllerAgents.length > 0) {
    const updateControllerCommand = db.prepare(
      'UPDATE agents SET command_template = ?, command_type = ? WHERE id = ?'
    );
    let normalizedControllerCount = 0;

    for (const agent of controllerAgents) {
      const currentCommandTemplate = agent.command_template ? agent.command_template.trim() : null;
      const resolvedCommandType = resolveCommandType(agent.command_type, currentCommandTemplate);

      if (resolvedCommandType === 'claude' || (!resolvedCommandType && !currentCommandTemplate)) {
        const effectiveType = resolvedCommandType || 'claude';
        const adapter = getAdapterRegistry().resolveFromCommand(currentCommandTemplate || '', effectiveType);
        const desiredTemplate = adapter.buildControllerCommand(currentCommandTemplate || '', undefined);
        const desiredType = adapter.type;
        if (
          desiredTemplate !== currentCommandTemplate ||
          desiredType !== agent.command_type
        ) {
          updateControllerCommand.run(
            desiredTemplate,
            desiredType,
            agent.id
          );
          normalizedControllerCount += 1;
        }
        continue;
      }

      if (!agent.command_type && resolvedCommandType) {
        updateControllerCommand.run(currentCommandTemplate, resolvedCommandType, agent.id);
        normalizedControllerCount += 1;
      }
    }

    if (normalizedControllerCount > 0) {
      logger.info(`Migration: normalized command config for ${normalizedControllerCount} controller agent(s)`);
    }
  }

  // Migration: add user_id column to sessions if missing
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as any[];
  if (!sessionCols.find((c: any) => c.name === 'user_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
    logger.info('Migration: added user_id column to sessions table');
  }
  // Migration: add 'omp' to CHECK constraints in command_profiles, projects, executor_profiles tables
  const cpTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='command_profiles'").get() as any;
  if (cpTableSql && !cpTableSql.sql.includes("'omp'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE command_profiles RENAME TO command_profiles_old;
      CREATE TABLE command_profiles (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'claude' CHECK(type IN ('claude', 'codex', 'gemini', 'omp')),
        scenario TEXT DEFAULT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO command_profiles SELECT * FROM command_profiles_old;
      DROP TABLE command_profiles_old;
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: added omp to command_profiles CHECK constraint');
  }
  const projTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get() as any;
  if (projTableSql && !projTableSql.sql.includes("'omp'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE projects RENAME TO projects_old;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        task_description TEXT NOT NULL,
        command_profile_id TEXT REFERENCES command_profiles(id) ON DELETE SET NULL,
        command_template TEXT DEFAULT 'cld',
        command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini', 'omp')),
        orchestrator_engine TEXT DEFAULT 'langgraph' CHECK(orchestrator_engine IN ('native', 'langgraph')),
        schedule_hours TEXT DEFAULT '',
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        color TEXT DEFAULT '#4A90E2',
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO projects SELECT * FROM projects_old;
      DROP TABLE projects_old;
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: added omp to projects CHECK constraint');
  }
  const epTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='executor_profiles'").get() as any;
  if (epTableSql && !epTableSql.sql.includes("'omp'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE executor_profiles RENAME TO executor_profiles_old;
      CREATE TABLE executor_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        executor_type TEXT NOT NULL DEFAULT 'claude' CHECK(executor_type IN ('claude', 'codex', 'gemini', 'shell', 'omp')),
        command_template TEXT NOT NULL,
        command_type TEXT DEFAULT NULL CHECK(command_type IN ('claude', 'codex', 'gemini', 'omp')),
        working_directory TEXT,
        env_json TEXT DEFAULT '{}',
        session_policy_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      INSERT INTO executor_profiles SELECT * FROM executor_profiles_old;
      DROP TABLE executor_profiles_old;
    `);
    db.pragma('foreign_keys = ON');
    logger.info('Migration: added omp to executor_profiles CHECK constraint');
  }

  // Seed data and maintenance tasks
  seedLegacyAgentKnowledge(db);
  seedKnowledgeFts(db);
  seedProjectOwners(db);
  seedBuiltinProjectTemplates(db);
  if (!options.skipStartupMaintenance) {
    runStartupMaintenance(db);
  }
}
