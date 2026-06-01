import type { DomainEvent } from './types';
import { getDatabase } from '../db/database';
import { v4 as uuidv4 } from 'uuid';

export function appendEvent(event: DomainEvent): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO domain_events (id, type, project_id, correlation_id, causation_id, payload, source, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    event.type,
    event.projectId,
    event.meta.correlationId,
    event.meta.causationId || null,
    JSON.stringify(event.payload),
    event.meta.source,
    new Date(event.meta.timestamp).toISOString()
  );
}

export function queryEvents(opts: {
  projectId?: string;
  type?: string;
  correlationId?: string;
  limit?: number;
  offset?: number;
}): any[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.projectId) { conditions.push('project_id = ?'); params.push(opts.projectId); }
  if (opts.type) { conditions.push('type = ?'); params.push(opts.type); }
  if (opts.correlationId) { conditions.push('correlation_id = ?'); params.push(opts.correlationId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit || 100;
  const offset = opts.offset || 0;

  return db.prepare(
    `SELECT * FROM domain_events ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
}

export function purgeOldEvents(maxAgeDays: number): number {
  const db = getDatabase();
  const result = db.prepare(
    "DELETE FROM domain_events WHERE published_at < datetime('now', ? || ' days')"
  ).run(`-${maxAgeDays}`);
  return result.changes;
}
