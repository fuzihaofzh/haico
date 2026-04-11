import Database from 'better-sqlite3';
import { RateLimitConfig } from '../models/types';

export class TokenBucketRateLimiter {
  private db: Database.Database;
  private config: RateLimitConfig;

  private consumeStmt: Database.Statement;
  private upsertStmt: Database.Statement;
  private getStmt: Database.Statement;

  constructor(db: Database.Database, config: RateLimitConfig) {
    this.db = db;
    this.config = config;

    this.getStmt = db.prepare(
      `SELECT tokens, last_refill FROM rate_limit_buckets WHERE key = ?`
    );

    this.upsertStmt = db.prepare(`
      INSERT INTO rate_limit_buckets (key, tokens, last_refill)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET tokens = ?, last_refill = datetime('now')
    `);

    this.consumeStmt = db.prepare(`
      UPDATE rate_limit_buckets SET tokens = tokens - 1 WHERE key = ? AND tokens > 0
    `);
  }

  tryConsume(key: string): { allowed: boolean; retry_after_ms?: number } {
    const row = this.getStmt.get(key) as { tokens: number; last_refill: string } | undefined;

    if (!row) {
      // First request: initialize bucket with max_tokens - 1 (consume one)
      this.upsertStmt.run(key, this.config.max_tokens - 1, this.config.max_tokens - 1);
      return { allowed: true };
    }

    // Calculate refill
    const lastRefill = new Date(row.last_refill + 'Z').getTime();
    const now = Date.now();
    const elapsed = now - lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.config.refill_interval_ms) * this.config.refill_rate;
    const newTokens = Math.min(this.config.max_tokens, row.tokens + tokensToAdd);

    if (newTokens <= 0) {
      const msUntilRefill = this.config.refill_interval_ms - (elapsed % this.config.refill_interval_ms);
      return { allowed: false, retry_after_ms: msUntilRefill };
    }

    this.upsertStmt.run(key, newTokens - 1, newTokens - 1);
    return { allowed: true };
  }

  reset(key: string): void {
    this.upsertStmt.run(key, this.config.max_tokens, this.config.max_tokens);
  }
}
