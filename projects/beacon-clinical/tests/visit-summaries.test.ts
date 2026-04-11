import { initDatabase } from '../src/models/schema';
import { VisitSummaryService } from '../src/services/visit-summaries';
import Database from 'better-sqlite3';

function seedTestData(db: Database.Database) {
  db.exec(`
    INSERT INTO sites (id, name, region, timezone)
    VALUES ('site-1', 'Metro General', 'US-East', 'America/New_York');

    INSERT INTO participants (id, site_id, external_id, initials, cohort, status)
    VALUES
      ('pt-001', 'site-1', 'SCR-1001', 'JD', 'Cohort A', 'active'),
      ('pt-002', 'site-1', 'SCR-1002', 'MK', 'Cohort B', 'screening');

    INSERT INTO visits (id, participant_id, site_id, visit_code, visit_label,
                        scheduled_date, window_start, window_end, status)
    VALUES
      ('v-001', 'pt-001', 'site-1', 'V2', 'Week 4 Follow-up',
       '2026-04-15', '2026-04-13', '2026-04-17', 'scheduled'),
      ('v-002', 'pt-002', 'site-1', 'V1', 'Baseline Visit',
       '2026-04-14', '2026-04-12', '2026-04-16', 'scheduled'),
      ('v-003', 'pt-001', 'site-1', 'V3', 'Week 8 Follow-up',
       '2026-05-15', '2026-05-13', '2026-05-17', 'scheduled');

    INSERT INTO visit_procedures (id, visit_id, procedure_code, procedure_name,
                                   requires_fasting, requires_consent, estimated_minutes, sort_order)
    VALUES
      ('vp-001', 'v-001', 'BLOOD', 'Blood draw (serum chemistry)', 1, 0, 15, 1),
      ('vp-002', 'v-001', 'ECG', 'ECG recording', 0, 0, 20, 2),
      ('vp-003', 'v-002', 'ICF', 'Informed consent review', 0, 1, 30, 1),
      ('vp-004', 'v-002', 'LAB', 'Lab sample collection', 1, 0, 20, 2);
  `);
}

describe('VisitSummaryService', () => {
  let db: Database.Database;
  let service: VisitSummaryService;

  beforeEach(() => {
    db = initDatabase(':memory:');
    seedTestData(db);
    service = new VisitSummaryService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns upcoming visit summaries for a site within date range', () => {
    const summaries = service.getUpcomingSummaries('site-1', '2026-04-10', '2026-04-20');

    expect(summaries).toHaveLength(2);
    expect(summaries[0].visit.visit_code).toBe('V1'); // Apr 14 before Apr 15
    expect(summaries[1].visit.visit_code).toBe('V2');
  });

  it('excludes visits outside date range', () => {
    const summaries = service.getUpcomingSummaries('site-1', '2026-05-01', '2026-05-31');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].visit.visit_code).toBe('V3');
  });

  it('returns empty for non-existent site', () => {
    const summaries = service.getUpcomingSummaries('site-999', '2026-04-10', '2026-04-20');
    expect(summaries).toHaveLength(0);
  });

  it('builds preparation checklist with fasting and lab items', () => {
    const summaries = service.getUpcomingSummaries('site-1', '2026-04-14', '2026-04-16');
    const baseline = summaries.find((s) => s.visit.visit_code === 'V1')!;

    expect(baseline.procedures).toHaveLength(2);
    expect(baseline.preparation_checklist.length).toBeGreaterThanOrEqual(3);

    const fastingItem = baseline.preparation_checklist.find((c) => c.category === 'fasting');
    expect(fastingItem).toBeDefined();
    expect(fastingItem!.required).toBe(true);

    const consentItem = baseline.preparation_checklist.find((c) => c.category === 'consent');
    expect(consentItem).toBeDefined();
  });

  it('calculates total estimated minutes', () => {
    const summaries = service.getUpcomingSummaries('site-1', '2026-04-15', '2026-04-15');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].total_estimated_minutes).toBe(35); // 15 + 20
  });

  it('returns a single visit summary by ID', () => {
    const summary = service.getSummaryById('v-001');
    expect(summary).not.toBeNull();
    expect(summary!.visit.visit_label).toBe('Week 4 Follow-up');
    expect(summary!.participant.initials).toBe('JD');
  });

  it('returns null for non-existent visit', () => {
    expect(service.getSummaryById('v-999')).toBeNull();
  });

  it('alerts when participant is still in screening', () => {
    const summaries = service.getUpcomingSummaries('site-1', '2026-04-14', '2026-04-14');
    const baseline = summaries.find((s) => s.visit.visit_code === 'V1')!;
    expect(baseline.alerts).toContain('Participant is still in screening — confirm eligibility');
  });
});
