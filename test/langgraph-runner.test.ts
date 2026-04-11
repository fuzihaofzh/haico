import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DB = path.join(__dirname, 'langgraph-runner.test.db');
process.env.AGENTOPIA_DB_PATH = TEST_DB;

let getDatabase: any;
let closeDatabase: any;
let reconcileNeedsUserOutcomes: any;

function cleanup(): void {
  for (const file of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { fs.unlinkSync(file); } catch {}
  }
}

describe('LangGraph needs_user handoff', () => {
  before(async () => {
    cleanup();
    ({ getDatabase, closeDatabase } = await import('../src/db/database'));
    ({ reconcileNeedsUserOutcomes } = await import('../src/services/langgraph-runner'));
  });

  after(() => {
    closeDatabase?.();
    cleanup();
  });

  it('clears acknowledged_at when auto-handing an issue back to user', () => {
    const db = getDatabase();

    const projectId = 'proj-needs-user';
    const controllerId = 'ctrl-needs-user';
    const workerId = 'worker-needs-user';
    const issueId = 'issue-needs-user';

    db.prepare(
      'INSERT INTO projects (id, name, task_description) VALUES (?, ?, ?)'
    ).run(projectId, 'needs-user-project', 'needs-user regression');

    db.prepare(
      'INSERT INTO agents (id, project_id, name, is_controller, status) VALUES (?, ?, ?, ?, ?)'
    ).run(controllerId, projectId, 'controller', 1, 'idle');

    db.prepare(
      'INSERT INTO agents (id, project_id, name, is_controller, status) VALUES (?, ?, ?, ?, ?)'
    ).run(workerId, projectId, 'worker', 0, 'idle');

    db.prepare(`
      INSERT INTO issues (
        id, project_id, number, title, body, created_by, assigned_to, priority, status, acknowledged_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 minutes'), datetime('now', '-10 minutes'))
    `).run(
      issueId,
      projectId,
      1,
      'needs_user regression issue',
      'worker is waiting for user input',
      'user',
      workerId,
      1,
      'open'
    );

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const agents = db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY is_controller DESC, id').all(projectId);

    const result = reconcileNeedsUserOutcomes(project, [{
      agentId: workerId,
      signal: 'needs_user',
      summary: 'latest output indicates user decision/confirmation is needed',
      excerpt: 'waiting for user confirmation',
      issueCount: 1,
      issueIds: [issueId],
      issueNumbers: [1],
    }], agents);

    assert.equal(result.movedCount, 1);

    const updated = db.prepare(
      'SELECT assigned_to, acknowledged_at FROM issues WHERE id = ?'
    ).get(issueId) as { assigned_to: string | null; acknowledged_at: string | null } | undefined;

    assert.equal(updated?.assigned_to, 'user');
    assert.equal(updated?.acknowledged_at, null);

    const assignmentEvent = db.prepare(
      "SELECT body FROM issue_comments WHERE issue_id = ? AND event_type = 'assignment' ORDER BY created_at DESC LIMIT 1"
    ).get(issueId) as { body: string } | undefined;
    assert.match(String(assignmentEvent?.body || ''), /assigned to user/);
  });
});
