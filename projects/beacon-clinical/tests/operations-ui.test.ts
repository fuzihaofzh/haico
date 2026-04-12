import Database from 'better-sqlite3';
import { initDatabase } from '../src/models/schema';
import { buildApp } from '../src/index';

function seedOperationsData(db: Database.Database) {
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
      ('visit-1', 'pt-001', 'site-1', 'V2', 'Week 4 Follow-up',
       '2026-04-15', '2026-04-13', '2026-04-17', 'scheduled'),
      ('visit-2', 'pt-002', 'site-1', 'V1', 'Baseline Visit',
       '2026-04-14', '2026-04-12', '2026-04-16', 'confirmed');

    INSERT INTO visit_procedures (id, visit_id, procedure_code, procedure_name,
                                  requires_fasting, requires_consent, estimated_minutes, sort_order)
    VALUES
      ('vp-001', 'visit-1', 'LAB', 'Lab sample collection', 1, 0, 20, 1),
      ('vp-002', 'visit-1', 'ECG', 'ECG recording', 0, 0, 15, 2),
      ('vp-003', 'visit-2', 'ICF', 'Informed consent review', 0, 1, 25, 1);

    INSERT INTO adverse_events (id, participant_id, site_id, reported_by, event_term,
                                description, onset_date, severity, is_serious, causality, status)
    VALUES
      ('ae-001', 'pt-001', 'site-1', 'Dr. Smith', 'Headache',
       'Persistent headache since Day 3', '2026-04-05', 'moderate', 0, 'possible', 'escalated'),
      ('ae-002', 'pt-002', 'site-1', 'Dr. Jones', 'Elevated ALT',
       'ALT 3x ULN on Day 14 labs', '2026-04-10', 'severe', 1, 'probable', 'escalated');

    INSERT INTO ae_escalations (id, adverse_event_id, escalated_by, escalated_to, priority, reason, action_required, acknowledged_at)
    VALUES
      ('esc-001', 'ae-001', 'coord-1', 'medical-monitor', 'standard', 'Routine follow-up needed', 'Review next lab draw', datetime('now')),
      ('esc-002', 'ae-002', 'coord-2', 'safety-board', 'critical', 'Serious hepatic signal', 'Assess expedited reporting', NULL);
  `);
}

describe('Beacon operations UI routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(':memory:');
    seedOperationsData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('renders the combined operations workbench with visit and escalation details', async () => {
    const app = buildApp({ db });

    const response = await app.inject({
      method: 'GET',
      url: '/operations?site_id=site-1&from=2026-04-14&to=2026-04-16',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Beacon Clinical Operations');
    expect(response.body).toContain('Visit Preparation Summaries');
    expect(response.body).toContain('Week 4 Follow-up');
    expect(response.body).toContain('Confirm participant fasting status');
    expect(response.body).toContain('Adverse Event Escalation Inbox');
    expect(response.body).toContain('Elevated ALT');
    expect(response.body).toContain('data-ack-button="esc-002"');

    await app.close();
  });

  it('applies inbox filters while preserving the visit worklist context', async () => {
    const app = buildApp({ db });

    const response = await app.inject({
      method: 'GET',
      url: '/operations?site_id=site-1&from=2026-04-14&to=2026-04-16&priority=critical&acknowledged=false',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Elevated ALT');
    expect(response.body).not.toContain('Routine follow-up needed');
    expect(response.body).toContain('value="2026-04-14"');
    expect(response.body).toContain('value="2026-04-16"');

    await app.close();
  });

  it('redirects the root path to the operations workbench', async () => {
    const app = buildApp({ db });

    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/operations');

    await app.close();
  });
});
