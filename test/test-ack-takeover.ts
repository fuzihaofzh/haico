import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';

const TEST_DB = path.join(__dirname, 'test-ack-takeover.db');
process.env.HAICO_DB_PATH = TEST_DB;
process.env.HAICO_PORT = '0';

async function api(app: any, url: string, opts: any = {}) {
  const res = await app.inject({ method: opts.method || 'GET', url, payload: opts.body, headers: { 'content-type': 'application/json' } });
  return { status: res.statusCode, body: JSON.parse(res.payload) };
}

describe('Ack takeover test', () => {
  let app: FastifyInstance;
  let projectId: string;
  let issueId: string;
  let issueId2: string;

  before(async () => {
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      try { fs.unlinkSync(f); } catch {}
    }
    const { createApp } = await import('../src/app');
    app = await createApp({ port: 0, host: '127.0.0.1', logger: false, skipScheduler: true });
    const { body: proj } = await api(app, '/api/projects', {
      method: 'POST',
      body: { name: 'ack-takeover-quick', description: 'test', task_description: 'test' },
    });
    projectId = proj.id;

    // Get real agent IDs from the project
    const { body: agents } = await api(app, `/api/projects/${projectId}/agents`);
    const controller = (agents as any[]).find((a: any) => a.is_controller);
    const agentId = controller.id;

    // Issue 1: ack then reassign to agent
    const { body: i1 } = await api(app, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: { title: 'Acked Then Controller Takeover', body: 'test', created_by: 'user', assigned_to: 'user' },
    });
    issueId = i1.id;

    // Issue 2: ack then reassign to agent then back to user
    const { body: i2 } = await api(app, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: { title: 'Acked Then Back To User', body: 'test', created_by: 'user', assigned_to: 'user' },
    });
    issueId2 = i2.id;

    // Ack issue 1, reassign to agent (controller takes over)
    await api(app, `/api/issues/${issueId}/acknowledge`, { method: 'POST', body: {} });
    await api(app, `/api/issues/${issueId}`, { method: 'PUT', body: { assigned_to: agentId, actor: agentId } });

    // Ack issue 2, reassign to agent, then back to user
    await api(app, `/api/issues/${issueId2}/acknowledge`, { method: 'POST', body: {} });
    await api(app, `/api/issues/${issueId2}`, { method: 'PUT', body: { assigned_to: agentId, actor: agentId } });
    await api(app, `/api/issues/${issueId2}`, { method: 'PUT', body: { assigned_to: 'user', actor: agentId } });
  });

  after(async () => {
    const { destroyApp } = await import('../src/app');
    await destroyApp(app);
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      try { fs.unlinkSync(f); } catch {}
    }
  });

  it('acknowledged_at is preserved when reassigned to agent', async () => {
    const { body } = await api(app, `/api/issues/${issueId}`);
    console.log('Issue 1 acknowledged_at:', body.acknowledged_at);
    assert.ok(body.acknowledged_at, 'acknowledged_at should be preserved');
  });

  it('acknowledged_at is reset when reassigned back to user', async () => {
    const { body } = await api(app, `/api/issues/${issueId2}`);
    console.log('Issue 2 acknowledged_at:', body.acknowledged_at);
    assert.equal(body.acknowledged_at, null, 'acknowledged_at should be reset');
  });

  it('acknowledged issue still appears in notifications after controller takeover', async () => {
    const { body } = await api(app, '/api/notifications');
    const found = body.user_issues.find((i: any) => i.id === issueId);
    console.log('Found in notifications:', !!found);
    assert.ok(found, 'should still appear in notifications');
  });

  it('acknowledged issue appears as grey/non-action-required state', async () => {
    const { body } = await api(app, '/api/notifications');
    const found = body.user_issues.find((i: any) => i.id === issueId);
    assert.ok(found, 'issue should be in notifications');
    assert.ok(found.acknowledged_at, 'should have acknowledged_at set (grey state)');
  });
});
