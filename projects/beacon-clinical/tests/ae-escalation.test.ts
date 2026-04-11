import { initDatabase } from '../src/models/schema';
import { AEEscalationService } from '../src/services/ae-escalation';
import Database from 'better-sqlite3';

function seedTestData(db: Database.Database) {
  db.exec(`
    INSERT INTO sites (id, name, region, timezone)
    VALUES ('site-1', 'Metro General', 'US-East', 'America/New_York');

    INSERT INTO participants (id, site_id, external_id, initials, cohort, status)
    VALUES ('pt-001', 'site-1', 'SCR-1001', 'JD', 'Cohort A', 'active');

    INSERT INTO adverse_events (id, participant_id, site_id, reported_by, event_term,
                                 description, onset_date, severity, is_serious, causality, status)
    VALUES
      ('ae-001', 'pt-001', 'site-1', 'Dr. Smith', 'Headache',
       'Persistent headache since Day 3', '2026-04-05', 'moderate', 0, 'possible', 'open'),
      ('ae-002', 'pt-001', 'site-1', 'Dr. Smith', 'Elevated ALT',
       'ALT 3x ULN on Day 14 labs', '2026-04-10', 'severe', 1, 'probable', 'open');
  `);
}

describe('AEEscalationService', () => {
  let db: Database.Database;
  let service: AEEscalationService;

  beforeEach(() => {
    db = initDatabase(':memory:');
    seedTestData(db);
    service = new AEEscalationService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates an escalation and updates AE status', () => {
    const esc = service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'urgent',
      reason: 'Persistent despite treatment',
    });

    expect(esc.id).toBeDefined();
    expect(esc.priority).toBe('urgent');

    const ae = db.prepare('SELECT status FROM adverse_events WHERE id = ?').get('ae-001') as any;
    expect(ae.status).toBe('escalated');
  });

  it('returns escalation inbox sorted by priority', () => {
    service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'standard',
      reason: 'Routine follow-up needed',
    });
    service.createEscalation({
      adverseEventId: 'ae-002',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'critical',
      reason: 'SAE: Elevated liver enzymes',
    });

    const inbox = service.getInbox({ escalatedTo: 'medical-monitor' });

    expect(inbox.total).toBe(2);
    expect(inbox.by_priority.critical).toBe(1);
    expect(inbox.by_priority.standard).toBe(1);
    expect(inbox.unacknowledged).toBe(2);
    // Critical should be first
    expect(inbox.items[0].escalation.priority).toBe('critical');
  });

  it('acknowledges an escalation', () => {
    const esc = service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'urgent',
      reason: 'Needs review',
    });

    const acked = service.acknowledge(esc.id);
    expect(acked).not.toBeNull();
    expect(acked!.acknowledged_at).not.toBeNull();

    // Double-ack returns null
    expect(service.acknowledge(esc.id)).toBeNull();
  });

  it('resolves an escalation and auto-resolves AE when all escalations done', () => {
    const esc = service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'standard',
      reason: 'Follow up',
    });

    const resolved = service.resolve(esc.id, 'Headache resolved with treatment');
    expect(resolved).not.toBeNull();
    expect(resolved!.resolution_note).toBe('Headache resolved with treatment');
    expect(resolved!.resolved_at).not.toBeNull();

    const ae = db.prepare('SELECT status FROM adverse_events WHERE id = ?').get('ae-001') as any;
    expect(ae.status).toBe('resolved');
  });

  it('does not auto-resolve AE if other escalations are still open', () => {
    service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'standard',
      reason: 'First escalation',
    });
    const esc2 = service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'safety-board',
      priority: 'urgent',
      reason: 'Second escalation',
    });

    // Resolve only one
    service.resolve(esc2.id, 'Cleared by safety board');

    const ae = db.prepare('SELECT status FROM adverse_events WHERE id = ?').get('ae-001') as any;
    expect(ae.status).toBe('escalated'); // Still open
  });

  it('filters inbox by priority', () => {
    service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'standard',
      reason: 'Routine',
    });
    service.createEscalation({
      adverseEventId: 'ae-002',
      escalatedBy: 'coord-1',
      escalatedTo: 'medical-monitor',
      priority: 'critical',
      reason: 'SAE',
    });

    const criticalOnly = service.getInbox({ priority: 'critical' });
    expect(criticalOnly.items).toHaveLength(1);
    expect(criticalOnly.items[0].adverse_event.event_term).toBe('Elevated ALT');
  });

  it('filters inbox by acknowledged status', () => {
    const esc = service.createEscalation({
      adverseEventId: 'ae-001',
      escalatedBy: 'coord-1',
      escalatedTo: 'mm',
      priority: 'standard',
      reason: 'Test',
    });
    service.createEscalation({
      adverseEventId: 'ae-002',
      escalatedBy: 'coord-1',
      escalatedTo: 'mm',
      priority: 'urgent',
      reason: 'Test 2',
    });
    service.acknowledge(esc.id);

    const unacked = service.getInbox({ acknowledged: false });
    expect(unacked.items).toHaveLength(1);
    expect(unacked.items[0].adverse_event.id).toBe('ae-002');

    const acked = service.getInbox({ acknowledged: true });
    expect(acked.items).toHaveLength(1);
    expect(acked.items[0].adverse_event.id).toBe('ae-001');
  });
});
