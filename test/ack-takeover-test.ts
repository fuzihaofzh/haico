/**
 * Test: Ack Preservation on Controller Takeover
 *
 * Scenario:
 * 1. Create project with controller + assistant agents
 * 2. Create issue assigned to assistant
 * 3. Assistant acknowledges the issue
 * 4. Controller reassigns (takes over) the issue to itself
 * 5. Verify acknowledged_at is PRESERVED (not reset)
 *
 * Also tests the inverse: reassigning TO user SHOULD reset ack.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';

const TEST_DB = path.join(__dirname, 'ack-takeover-test.db');
process.env.AGENTOPIA_DB_PATH = TEST_DB;
process.env.AGENTOPIA_PORT = '0';

async function api(app: FastifyInstance, url: string, opts: { method?: string; body?: any } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({
    method: (opts.method as any) || 'GET',
    url,
    payload: opts.body,
    headers,
  });
  let body: any = {};
  try { body = JSON.parse(res.body); } catch {}
  return { status: res.statusCode, body };
}

let app: FastifyInstance;
let projectId: string;
const controllerId = 'ctrl-0001';
const assistantId = 'asst-0001';

describe('Ack Preservation on Reassignment', () => {
  before(async () => {
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      try { fs.unlinkSync(f); } catch {}
    }
    const { createApp } = await import('../src/app');
    app = await createApp({ port: 0, host: '127.0.0.1', logger: false, skipScheduler: true });

    // Create project (auto-creates controller + assistant agents)
    const { status: projStatus, body: proj } = await api(app, '/api/projects', {
      method: 'POST',
      body: { name: 'ack-takeover-test', task_description: 'Test ack preservation' },
    });
    assert.equal(projStatus, 201, `Project creation failed: ${JSON.stringify(proj)}`);
    projectId = proj.id;
  });

  after(async () => {
    const { destroyApp } = await import('../src/app');
    await destroyApp(app);
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      try { fs.unlinkSync(f); } catch {}
    }
  });

  it('should preserve ack when controller takes over from assistant', async () => {
    // Step 1: Get agent IDs
    const { body: agents } = await api(app, `/api/projects/${projectId}/agents`);
    const controller = (agents as any[]).find((a: any) => a.is_controller);
    const assistant = (agents as any[]).find((a: any) => !a.is_controller);
    assert.ok(controller, 'Controller agent should exist');
    assert.ok(assistant, 'Assistant agent should exist');

    // Step 2: Create issue assigned to assistant
    const { status: createStatus, body: issue } = await api(app, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Test ack preservation',
        body: 'Issue to test ack is preserved on takeover',
        created_by: 'user',
        assigned_to: assistant.id,
      },
    });
    assert.equal(createStatus, 201);
    assert.ok(issue.id);

    // Step 3: Assistant acknowledges the issue
    const { status: ackStatus } = await api(app, `/api/issues/${issue.id}/acknowledge`, {
      method: 'POST',
    });
    assert.equal(ackStatus, 200);

    // Verify ack is set
    const { body: afterAck } = await api(app, `/api/issues/${issue.id}`);
    assert.ok(afterAck.acknowledged_at, 'acknowledged_at should be set after ack');
    const ackTime = afterAck.acknowledged_at;

    // Step 4: Controller takes over — reassigns to itself
    const { status: updateStatus } = await api(app, `/api/issues/${issue.id}`, {
      method: 'PUT',
      body: {
        assigned_to: controller.id,
        actor: controller.id,
      },
    });
    assert.equal(updateStatus, 200);

    // Step 5: Verify ack is PRESERVED
    const { body: afterTakeover } = await api(app, `/api/issues/${issue.id}`);
    assert.equal(afterTakeover.assigned_to, controller.id, 'Issue should be assigned to controller');
    assert.equal(afterTakeover.acknowledged_at, ackTime, 'acknowledged_at should be PRESERVED after controller takeover');

    console.log('✓ Ack preserved on controller takeover: acknowledged_at =', afterTakeover.acknowledged_at);
  });

  it('should preserve ack when reassigned to another agent (not user)', async () => {
    const { body: agents } = await api(app, `/api/projects/${projectId}/agents`);
    const controller = (agents as any[]).find((a: any) => a.is_controller);
    const assistant = (agents as any[]).find((a: any) => !a.is_controller);

    // Create issue assigned to controller
    const { body: issue } = await api(app, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Test ack preservation agent-to-agent',
        body: 'Reassign between agents should preserve ack',
        created_by: 'user',
        assigned_to: controller.id,
      },
    });

    // Acknowledge
    await api(app, `/api/issues/${issue.id}/acknowledge`, { method: 'POST' });
    const { body: afterAck } = await api(app, `/api/issues/${issue.id}`);
    assert.ok(afterAck.acknowledged_at);

    // Reassign to assistant
    await api(app, `/api/issues/${issue.id}`, {
      method: 'PUT',
      body: { assigned_to: assistant.id, actor: controller.id },
    });

    const { body: afterReassign } = await api(app, `/api/issues/${issue.id}`);
    assert.equal(afterReassign.assigned_to, assistant.id);
    assert.ok(afterReassign.acknowledged_at, 'acknowledged_at should be PRESERVED on agent-to-agent reassignment');

    console.log('✓ Ack preserved on agent-to-agent reassignment');
  });

  it('should RESET ack when reassigned to user', async () => {
    const { body: agents } = await api(app, `/api/projects/${projectId}/agents`);
    const assistant = (agents as any[]).find((a: any) => !a.is_controller);

    // Create issue assigned to assistant
    const { body: issue } = await api(app, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Test ack reset on user assignment',
        body: 'Reassigning to user should reset ack',
        created_by: 'user',
        assigned_to: assistant.id,
      },
    });

    // Acknowledge
    await api(app, `/api/issues/${issue.id}/acknowledge`, { method: 'POST' });
    const { body: afterAck } = await api(app, `/api/issues/${issue.id}`);
    assert.ok(afterAck.acknowledged_at);

    // Reassign to user
    await api(app, `/api/issues/${issue.id}`, {
      method: 'PUT',
      body: { assigned_to: 'user', actor: assistant.id },
    });

    const { body: afterReassign } = await api(app, `/api/issues/${issue.id}`);
    assert.equal(afterReassign.assigned_to, 'user');
    assert.equal(afterReassign.acknowledged_at, null, 'acknowledged_at should be RESET when reassigned to user');

    console.log('✓ Ack correctly reset on reassignment to user');
  });

  it('should preserve ack on status change only (no reassignment)', async () => {
    const { body: agents } = await api(app, `/api/projects/${projectId}/agents`);
    const assistant = (agents as any[]).find((a: any) => !a.is_controller);

    // Create issue
    const { body: issue } = await api(app, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Test ack on status change',
        body: 'Status change alone should not reset ack',
        created_by: 'user',
        assigned_to: assistant.id,
      },
    });

    // Acknowledge
    await api(app, `/api/issues/${issue.id}/acknowledge`, { method: 'POST' });
    const { body: afterAck } = await api(app, `/api/issues/${issue.id}`);
    assert.ok(afterAck.acknowledged_at);

    // Change status only (no reassignment)
    await api(app, `/api/issues/${issue.id}`, {
      method: 'PUT',
      body: { status: 'in_progress', actor: assistant.id },
    });

    const { body: afterStatusChange } = await api(app, `/api/issues/${issue.id}`);
    assert.ok(afterStatusChange.acknowledged_at, 'acknowledged_at should be PRESERVED on status-only change');

    console.log('✓ Ack preserved on status change without reassignment');
  });
});
