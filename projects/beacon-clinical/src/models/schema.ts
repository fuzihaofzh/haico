import Database from 'better-sqlite3';
import path from 'path';

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || path.join(__dirname, '../../beacon-clinical.db');
  const db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Clinical sites
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Study participants enrolled at sites
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      initials TEXT NOT NULL,
      cohort TEXT,
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('screening', 'active', 'completed', 'withdrawn', 'discontinued')),
      FOREIGN KEY (site_id) REFERENCES sites(id)
    );

    -- Scheduled visits (protocol-driven)
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      visit_code TEXT NOT NULL,
      visit_label TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'confirmed', 'in_progress', 'completed', 'missed', 'cancelled')),
      coordinator_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES participants(id),
      FOREIGN KEY (site_id) REFERENCES sites(id)
    );

    -- Procedures required per visit
    CREATE TABLE IF NOT EXISTS visit_procedures (
      id TEXT PRIMARY KEY,
      visit_id TEXT NOT NULL,
      procedure_code TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      requires_fasting INTEGER NOT NULL DEFAULT 0,
      requires_consent INTEGER NOT NULL DEFAULT 0,
      estimated_minutes INTEGER NOT NULL DEFAULT 15,
      sort_order INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE
    );

    -- Adverse events reported by sites
    CREATE TABLE IF NOT EXISTS adverse_events (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      reported_by TEXT NOT NULL,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      event_term TEXT NOT NULL,
      description TEXT NOT NULL,
      onset_date TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'mild'
        CHECK (severity IN ('mild', 'moderate', 'severe', 'life_threatening', 'fatal')),
      is_serious INTEGER NOT NULL DEFAULT 0,
      causality TEXT NOT NULL DEFAULT 'unrelated'
        CHECK (causality IN ('unrelated', 'unlikely', 'possible', 'probable', 'definite')),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'under_review', 'escalated', 'resolved', 'closed')),
      outcome TEXT,
      resolved_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES participants(id),
      FOREIGN KEY (site_id) REFERENCES sites(id)
    );

    -- Escalation actions on adverse events
    CREATE TABLE IF NOT EXISTS ae_escalations (
      id TEXT PRIMARY KEY,
      adverse_event_id TEXT NOT NULL,
      escalated_by TEXT NOT NULL,
      escalated_to TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'standard'
        CHECK (priority IN ('standard', 'urgent', 'critical')),
      reason TEXT NOT NULL,
      action_required TEXT,
      acknowledged_at TEXT,
      resolved_at TEXT,
      resolution_note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (adverse_event_id) REFERENCES adverse_events(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_visits_site_date
      ON visits(site_id, scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_visits_participant
      ON visits(participant_id, scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_visits_status
      ON visits(status, scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_ae_status
      ON adverse_events(status, is_serious);
    CREATE INDEX IF NOT EXISTS idx_ae_site
      ON adverse_events(site_id, status);
    CREATE INDEX IF NOT EXISTS idx_ae_escalations_event
      ON ae_escalations(adverse_event_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_participants_site
      ON participants(site_id, status);
  `);

  return db;
}
