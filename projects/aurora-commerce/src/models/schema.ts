import Database from 'better-sqlite3';
import path from 'path';

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || path.join(__dirname, '../../aurora-commerce.db');
  const db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      total_stock INTEGER NOT NULL DEFAULT 0,
      available_stock INTEGER NOT NULL DEFAULT 0,
      reserved_stock INTEGER NOT NULL DEFAULT 0,
      max_per_customer INTEGER NOT NULL DEFAULT 1,
      flash_sale_active INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT,
      released_at TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS reservation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      action TEXT NOT NULL
        CHECK (action IN ('reserve', 'confirm', 'release', 'expire', 'reject_stock', 'reject_limit', 'reject_rate')),
      quantity INTEGER NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      key TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL,
      last_refill TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reservations_product_status
      ON reservations(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_reservations_customer
      ON reservations(customer_id, product_id, status);
    CREATE INDEX IF NOT EXISTS idx_reservations_expires
      ON reservations(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_reservation_log_product
      ON reservation_log(product_id, created_at);
  `);

  return db;
}
