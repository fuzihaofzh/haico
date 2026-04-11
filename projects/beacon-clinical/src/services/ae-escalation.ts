import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  AdverseEvent,
  AEEscalation,
  EscalationInboxItem,
  EscalationInboxSummary,
} from '../models/types';

export class AEEscalationService {
  constructor(private db: Database.Database) {}

  /** Get the escalation inbox for a given user/role, with filtering and sorting. */
  getInbox(opts: {
    escalatedTo?: string;
    siteId?: string;
    priority?: string;
    acknowledged?: boolean;
    limit?: number;
    offset?: number;
  }): EscalationInboxSummary {
    const conditions: string[] = ['ae.status != ?'];
    const params: any[] = ['closed'];

    if (opts.escalatedTo) {
      conditions.push('esc.escalated_to = ?');
      params.push(opts.escalatedTo);
    }
    if (opts.siteId) {
      conditions.push('ae.site_id = ?');
      params.push(opts.siteId);
    }
    if (opts.priority) {
      conditions.push('esc.priority = ?');
      params.push(opts.priority);
    }
    if (opts.acknowledged === true) {
      conditions.push('esc.acknowledged_at IS NOT NULL');
    } else if (opts.acknowledged === false) {
      conditions.push('esc.acknowledged_at IS NULL');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const items = this.db
      .prepare(
        `SELECT
           esc.*,
           ae.participant_id, ae.site_id, ae.reported_by, ae.reported_at,
           ae.event_term, ae.description, ae.onset_date, ae.severity,
           ae.is_serious, ae.causality, ae.status AS ae_status, ae.outcome,
           ae.resolved_at AS ae_resolved_at, ae.updated_at AS ae_updated_at,
           p.external_id, p.initials,
           s.name AS site_name,
           CAST(julianday('now') - julianday(esc.created_at) AS INTEGER) AS days_open
         FROM ae_escalations esc
         JOIN adverse_events ae ON ae.id = esc.adverse_event_id
         JOIN participants p ON p.id = ae.participant_id
         JOIN sites s ON s.id = ae.site_id
         ${where}
         ORDER BY
           CASE esc.priority WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END ASC,
           esc.acknowledged_at IS NOT NULL ASC,
           esc.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as any[];

    const mapped: EscalationInboxItem[] = items.map((r) => ({
      escalation: {
        id: r.id,
        adverse_event_id: r.adverse_event_id,
        escalated_by: r.escalated_by,
        escalated_to: r.escalated_to,
        priority: r.priority,
        reason: r.reason,
        action_required: r.action_required,
        acknowledged_at: r.acknowledged_at,
        resolved_at: r.resolved_at,
        resolution_note: r.resolution_note,
        created_at: r.created_at,
      },
      adverse_event: {
        id: r.adverse_event_id,
        participant_id: r.participant_id,
        site_id: r.site_id,
        reported_by: r.reported_by,
        reported_at: r.reported_at,
        event_term: r.event_term,
        description: r.description,
        onset_date: r.onset_date,
        severity: r.severity,
        is_serious: r.is_serious,
        causality: r.causality,
        status: r.ae_status,
        outcome: r.outcome,
        resolved_at: r.ae_resolved_at,
        updated_at: r.ae_updated_at,
      },
      participant: {
        id: r.participant_id,
        external_id: r.external_id,
        initials: r.initials,
      },
      site_name: r.site_name,
      days_open: r.days_open,
    }));

    const countRow = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN esc.priority = 'standard' THEN 1 ELSE 0 END) AS standard,
           SUM(CASE WHEN esc.priority = 'urgent' THEN 1 ELSE 0 END) AS urgent,
           SUM(CASE WHEN esc.priority = 'critical' THEN 1 ELSE 0 END) AS critical,
           SUM(CASE WHEN esc.acknowledged_at IS NULL THEN 1 ELSE 0 END) AS unacknowledged
         FROM ae_escalations esc
         JOIN adverse_events ae ON ae.id = esc.adverse_event_id
         ${where}`,
      )
      .get(...params) as any;

    return {
      total: countRow.total,
      by_priority: {
        standard: countRow.standard ?? 0,
        urgent: countRow.urgent ?? 0,
        critical: countRow.critical ?? 0,
      },
      unacknowledged: countRow.unacknowledged ?? 0,
      items: mapped,
    };
  }

  /** Create a new escalation for an adverse event. */
  createEscalation(data: {
    adverseEventId: string;
    escalatedBy: string;
    escalatedTo: string;
    priority: 'standard' | 'urgent' | 'critical';
    reason: string;
    actionRequired?: string;
  }): AEEscalation {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ae_escalations (id, adverse_event_id, escalated_by, escalated_to, priority, reason, action_required)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.adverseEventId,
        data.escalatedBy,
        data.escalatedTo,
        data.priority,
        data.reason,
        data.actionRequired ?? null,
      );

    this.db
      .prepare(`UPDATE adverse_events SET status = 'escalated', updated_at = datetime('now') WHERE id = ?`)
      .run(data.adverseEventId);

    return this.db
      .prepare(`SELECT * FROM ae_escalations WHERE id = ?`)
      .get(id) as AEEscalation;
  }

  /** Acknowledge an escalation. */
  acknowledge(escalationId: string): AEEscalation | null {
    const result = this.db
      .prepare(
        `UPDATE ae_escalations SET acknowledged_at = datetime('now') WHERE id = ? AND acknowledged_at IS NULL`,
      )
      .run(escalationId);
    if (result.changes === 0) return null;
    return this.db
      .prepare(`SELECT * FROM ae_escalations WHERE id = ?`)
      .get(escalationId) as AEEscalation;
  }

  /** Resolve an escalation with a note. */
  resolve(
    escalationId: string,
    resolutionNote: string,
  ): AEEscalation | null {
    const esc = this.db
      .prepare(`SELECT * FROM ae_escalations WHERE id = ?`)
      .get(escalationId) as AEEscalation | undefined;
    if (!esc) return null;

    this.db
      .prepare(
        `UPDATE ae_escalations
         SET resolved_at = datetime('now'), resolution_note = ?,
             acknowledged_at = COALESCE(acknowledged_at, datetime('now'))
         WHERE id = ?`,
      )
      .run(resolutionNote, escalationId);

    // Check if all escalations for this AE are resolved; if so, mark AE as resolved
    const openCount = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM ae_escalations WHERE adverse_event_id = ? AND resolved_at IS NULL`,
      )
      .get(esc.adverse_event_id) as { cnt: number };

    if (openCount.cnt === 0) {
      this.db
        .prepare(
          `UPDATE adverse_events SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        )
        .run(esc.adverse_event_id);
    }

    return this.db
      .prepare(`SELECT * FROM ae_escalations WHERE id = ?`)
      .get(escalationId) as AEEscalation;
  }
}
