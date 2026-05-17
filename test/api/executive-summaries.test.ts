import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiTestHarness, createApiTestHarness } from './helpers';

describe('Executive summary service routes', () => {
  let ctx: ApiTestHarness;
  let authCookie: string;
  let projectId: string;

  before(async () => {
    ctx = await createApiTestHarness('executive-summaries');

    const suffix = Date.now();
    const registered = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: {
        username: `exec-summary-owner-${suffix}`,
        password: 'pass1234',
        display_name: 'Executive Summary Owner',
      },
    });
    assert.equal(registered.status, 201, registered.raw);

    const loggedIn = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { username: `exec-summary-owner-${suffix}`, password: 'pass1234' },
    });
    assert.equal(loggedIn.status, 200, loggedIn.raw);
    authCookie = `haico-auth=${loggedIn.body.token}`;

    const createdProject = await ctx.api('/api/projects', {
      method: 'POST',
      headers: { cookie: authCookie },
      body: {
        name: 'executive-summary-project',
        task_description: 'verify executive summary service refactor',
        command_template: 'echo',
      },
    });
    assert.equal(createdProject.status, 201, createdProject.raw);
    projectId = createdProject.body.id;
  });

  after(async () => {
    await ctx?.close();
  });

  async function createSummary(title = 'Weekly Review') {
    const created = await ctx.api(`/api/projects/${projectId}/executive-summaries`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: {
        title,
        period_start: '2026-05-01',
        period_end: '2026-05-07',
        created_by: 'tester',
      },
    });
    assert.equal(created.status, 201, created.raw);
    return created.body;
  }

  it('creates, lists, reads, updates, and deletes summaries', async () => {
    const missingFields = await ctx.api(`/api/projects/${projectId}/executive-summaries`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { title: 'Incomplete' },
    });
    assert.equal(missingFields.status, 400);
    assert.match(missingFields.body.error, /title, period_start, and period_end/);

    const created = await createSummary('Operational Review');
    assert.equal(created.status, 'draft');
    assert.equal(created.created_by, 'tester');
    assert.equal(created.blocks.length, 6);
    assert.deepEqual(
      created.blocks.map((block: any) => block.key),
      [
        'cash_position',
        'payment_activity',
        'liquidity_alerts',
        'forecast_variance',
        'risk_compliance',
        'action_items',
      ]
    );

    const listed = await ctx.api(`/api/projects/${projectId}/executive-summaries?status=draft&limit=1&offset=0`, {
      headers: { cookie: authCookie },
    });
    assert.equal(listed.status, 200, listed.raw);
    assert.equal(listed.body.limit, 1);
    assert.equal(listed.body.offset, 0);
    assert.ok(listed.body.total >= 1);
    assert.equal(listed.body.summaries.length, 1);

    const read = await ctx.api(`/api/projects/${projectId}/executive-summaries/${created.id}`, {
      headers: { cookie: authCookie },
    });
    assert.equal(read.status, 200, read.raw);
    assert.equal(read.body.id, created.id);
    assert.equal(read.body.blocks.length, 6);

    const invalidStatus = await ctx.api(`/api/projects/${projectId}/executive-summaries/${created.id}`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { status: 'published' },
    });
    assert.equal(invalidStatus.status, 400);
    assert.match(invalidStatus.body.error, /draft, final, archived/);

    const noFields = await ctx.api(`/api/projects/${projectId}/executive-summaries/${created.id}`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { ignored: true },
    });
    assert.equal(noFields.status, 400);
    assert.match(noFields.body.error, /No valid fields/);

    const updated = await ctx.api(`/api/projects/${projectId}/executive-summaries/${created.id}`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { title: 'Updated Operational Review', status: 'archived' },
    });
    assert.equal(updated.status, 200, updated.raw);
    assert.equal(updated.body.title, 'Updated Operational Review');
    assert.equal(updated.body.status, 'archived');

    const deleted = await ctx.api(`/api/projects/${projectId}/executive-summaries/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: authCookie },
    });
    assert.equal(deleted.status, 200, deleted.raw);
    assert.deepEqual(deleted.body, { ok: true });

    const missing = await ctx.api(`/api/projects/${projectId}/executive-summaries/${created.id}`, {
      headers: { cookie: authCookie },
    });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /Executive summary not found/);
  });

  it('manages custom blocks through service-backed domain errors', async () => {
    const summary = await createSummary('Block Review');

    const missingBlockFields = await ctx.api(`/api/projects/${projectId}/executive-summaries/${summary.id}/blocks`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { key: 'custom_notes' },
    });
    assert.equal(missingBlockFields.status, 400);
    assert.match(missingBlockFields.body.error, /key and title/);

    const createdBlock = await ctx.api(`/api/projects/${projectId}/executive-summaries/${summary.id}/blocks`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { key: 'custom_notes', title: 'Custom Notes', content: 'Initial notes' },
    });
    assert.equal(createdBlock.status, 201, createdBlock.raw);
    assert.equal(createdBlock.body.key, 'custom_notes');
    assert.equal(createdBlock.body.order_index, 6);

    const duplicate = await ctx.api(`/api/projects/${projectId}/executive-summaries/${summary.id}/blocks`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { key: 'custom_notes', title: 'Duplicate Notes' },
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /already exists/);

    const noBlockFields = await ctx.api(
      `/api/projects/${projectId}/executive-summaries/${summary.id}/blocks/${createdBlock.body.id}`,
      {
        method: 'PUT',
        headers: { cookie: authCookie },
        body: { ignored: true },
      }
    );
    assert.equal(noBlockFields.status, 400);
    assert.match(noBlockFields.body.error, /No valid fields/);

    const updatedBlock = await ctx.api(
      `/api/projects/${projectId}/executive-summaries/${summary.id}/blocks/${createdBlock.body.id}`,
      {
        method: 'PUT',
        headers: { cookie: authCookie },
        body: { title: 'Updated Notes', content: 'Refined notes', order_index: 2 },
      }
    );
    assert.equal(updatedBlock.status, 200, updatedBlock.raw);
    assert.equal(updatedBlock.body.title, 'Updated Notes');
    assert.equal(updatedBlock.body.content, 'Refined notes');
    assert.equal(updatedBlock.body.order_index, 2);

    const deletedBlock = await ctx.api(
      `/api/projects/${projectId}/executive-summaries/${summary.id}/blocks/${createdBlock.body.id}`,
      {
        method: 'DELETE',
        headers: { cookie: authCookie },
      }
    );
    assert.equal(deletedBlock.status, 200, deletedBlock.raw);
    assert.deepEqual(deletedBlock.body, { ok: true });

    const missingBlock = await ctx.api(
      `/api/projects/${projectId}/executive-summaries/${summary.id}/blocks/${createdBlock.body.id}`,
      {
        method: 'PUT',
        headers: { cookie: authCookie },
        body: { title: 'Missing' },
      }
    );
    assert.equal(missingBlock.status, 404);
    assert.match(missingBlock.body.error, /Block not found/);
  });

  it('generates and finalizes summaries without changing existing status semantics', async () => {
    const summary = await createSummary('Generated Review');

    const generated = await ctx.api(`/api/projects/${projectId}/executive-summaries/${summary.id}/generate`, {
      method: 'POST',
      headers: { cookie: authCookie },
    });
    assert.equal(generated.status, 200, generated.raw);
    const cashPosition = generated.body.blocks.find((block: any) => block.key === 'cash_position');
    assert.ok(cashPosition);
    assert.match(cashPosition.content, /\*\*Period\*\*: 2026-05-01/);
    assert.match(cashPosition.content, /Issues resolved/);

    const finalized = await ctx.api(`/api/projects/${projectId}/executive-summaries/${summary.id}/finalize`, {
      method: 'POST',
      headers: { cookie: authCookie },
    });
    assert.equal(finalized.status, 200, finalized.raw);
    assert.equal(finalized.body.status, 'final');

    const refinalized = await ctx.api(`/api/projects/${projectId}/executive-summaries/${summary.id}/finalize`, {
      method: 'POST',
      headers: { cookie: authCookie },
    });
    assert.equal(refinalized.status, 409);
    assert.match(refinalized.body.error, /already finalized/);

    const finalUpdate = await ctx.api(`/api/projects/${projectId}/executive-summaries/${summary.id}`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { title: 'Final Summary Still Editable' },
    });
    assert.equal(finalUpdate.status, 200, finalUpdate.raw);
    assert.equal(finalUpdate.body.title, 'Final Summary Still Editable');

    const archived = await createSummary('Archived Review');
    const archivedUpdate = await ctx.api(`/api/projects/${projectId}/executive-summaries/${archived.id}`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { status: 'archived' },
    });
    assert.equal(archivedUpdate.status, 200, archivedUpdate.raw);

    const archivedFinalize = await ctx.api(`/api/projects/${projectId}/executive-summaries/${archived.id}/finalize`, {
      method: 'POST',
      headers: { cookie: authCookie },
    });
    assert.equal(archivedFinalize.status, 409);
    assert.match(archivedFinalize.body.error, /Cannot finalize an archived summary/);
  });
});
