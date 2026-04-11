import Database from 'better-sqlite3';
import {
  Visit,
  VisitProcedure,
  VisitPreparationSummary,
  PreparationItem,
} from '../models/types';

export class VisitSummaryService {
  constructor(private db: Database.Database) {}

  /** Get preparation summaries for all visits at a site within a date range. */
  getUpcomingSummaries(
    siteId: string,
    fromDate: string,
    toDate: string,
  ): VisitPreparationSummary[] {
    const visits = this.db
      .prepare(
        `SELECT v.*, p.id AS p_id, p.external_id, p.initials, p.cohort, p.status AS p_status
         FROM visits v
         JOIN participants p ON p.id = v.participant_id
         WHERE v.site_id = ?
           AND v.scheduled_date >= ?
           AND v.scheduled_date <= ?
           AND v.status IN ('scheduled', 'confirmed')
         ORDER BY v.scheduled_date ASC, p.external_id ASC`,
      )
      .all(siteId, fromDate, toDate) as (Visit & {
      p_id: string;
      external_id: string;
      initials: string;
      cohort: string | null;
      p_status: string;
    })[];

    return visits.map((row) => this.buildSummary(row));
  }

  /** Get a single visit preparation summary. */
  getSummaryById(visitId: string): VisitPreparationSummary | null {
    const row = this.db
      .prepare(
        `SELECT v.*, p.id AS p_id, p.external_id, p.initials, p.cohort, p.status AS p_status
         FROM visits v
         JOIN participants p ON p.id = v.participant_id
         WHERE v.id = ?`,
      )
      .get(visitId) as
      | (Visit & {
          p_id: string;
          external_id: string;
          initials: string;
          cohort: string | null;
          p_status: string;
        })
      | undefined;

    if (!row) return null;
    return this.buildSummary(row);
  }

  private buildSummary(
    row: Visit & {
      p_id: string;
      external_id: string;
      initials: string;
      cohort: string | null;
      p_status: string;
    },
  ): VisitPreparationSummary {
    const procedures = this.db
      .prepare(
        `SELECT * FROM visit_procedures WHERE visit_id = ? ORDER BY sort_order ASC`,
      )
      .all(row.id) as VisitProcedure[];

    const checklist = this.buildChecklist(procedures);
    const alerts = this.buildAlerts(row, procedures);
    const totalMinutes = procedures.reduce(
      (sum, p) => sum + p.estimated_minutes,
      0,
    );

    return {
      visit: {
        id: row.id,
        participant_id: row.participant_id,
        site_id: row.site_id,
        visit_code: row.visit_code,
        visit_label: row.visit_label,
        scheduled_date: row.scheduled_date,
        window_start: row.window_start,
        window_end: row.window_end,
        status: row.status,
        coordinator_id: row.coordinator_id,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      participant: {
        id: row.p_id,
        external_id: row.external_id,
        initials: row.initials,
        cohort: row.cohort,
        status: row.p_status as any,
      },
      procedures,
      preparation_checklist: checklist,
      total_estimated_minutes: totalMinutes,
      alerts,
    };
  }

  private buildChecklist(procedures: VisitProcedure[]): PreparationItem[] {
    const items: PreparationItem[] = [];
    const hasFasting = procedures.some((p) => p.requires_fasting);
    const hasConsent = procedures.some((p) => p.requires_consent);

    if (hasFasting) {
      items.push({
        label: 'Confirm participant fasting status (minimum 8 hours)',
        required: true,
        category: 'fasting',
      });
    }
    if (hasConsent) {
      items.push({
        label: 'Verify informed consent is current and signed',
        required: true,
        category: 'consent',
      });
    }

    const labProcs = procedures.filter((p) =>
      /blood|serum|urine|sample|lab/i.test(p.procedure_name),
    );
    if (labProcs.length > 0) {
      items.push({
        label: `Prepare lab kits for ${labProcs.length} sample collection(s)`,
        required: true,
        category: 'lab',
      });
    }

    items.push({
      label: 'Review participant source documents and prior visit notes',
      required: false,
      category: 'general',
    });
    items.push({
      label: 'Confirm visit room and equipment availability',
      required: false,
      category: 'equipment',
    });

    return items;
  }

  private buildAlerts(
    row: Visit & { p_status: string },
    procedures: VisitProcedure[],
  ): string[] {
    const alerts: string[] = [];
    const today = new Date().toISOString().slice(0, 10);

    if (row.scheduled_date < today) {
      alerts.push('Visit is past the scheduled date');
    }
    if (row.scheduled_date > row.window_end) {
      alerts.push('Visit is outside the protocol window');
    }
    if (row.p_status === 'screening') {
      alerts.push('Participant is still in screening — confirm eligibility');
    }
    if (procedures.length === 0) {
      alerts.push('No procedures defined for this visit');
    }

    return alerts;
  }
}
