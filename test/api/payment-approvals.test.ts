import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiTestHarness, createApiTestHarness } from './helpers';

describe('Payment approval service routes', () => {
  let ctx: ApiTestHarness;
  let projectId: string;
  let authCookie: string;

  before(async () => {
    ctx = await createApiTestHarness('payment-approvals');

    const username = `payment-owner-${Date.now()}`;
    const registered = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: { username, password: 'pass1234', display_name: 'Payment Owner' },
    });
    assert.equal(registered.status, 201, registered.raw);

    const loggedIn = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'pass1234' },
    });
    assert.equal(loggedIn.status, 200, loggedIn.raw);
    authCookie = `haico-auth=${loggedIn.body.token}`;

    const created = await ctx.api('/api/projects', {
      method: 'POST',
      headers: { cookie: authCookie },
      body: {
        name: 'payment-approval-project',
        task_description: 'verify dual-controller payment approval workflow',
        command_template: 'echo',
      },
    });
    assert.equal(created.status, 201, created.raw);
    projectId = created.body.id;
  });

  after(async () => {
    await ctx?.close();
  });

  it('enforces dual-controller decisions and resolves after required approvals', async () => {
    const created = await ctx.api(`/api/projects/${projectId}/payment-approvals`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: {
        requested_by: 'requester-1',
        title: 'Wire transfer',
        amount: 1250,
        required_approvals: 2,
      },
    });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.status, 'pending');
    assert.equal(created.body.remaining_approvals, 2);

    const selfApproval = await ctx.api(`/api/payment-approvals/${created.body.id}/decisions`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { decided_by: 'requester-1', decision: 'approve' },
    });
    assert.equal(selfApproval.status, 403);
    assert.match(selfApproval.body.error, /requester cannot approve/);

    const firstApproval = await ctx.api(`/api/payment-approvals/${created.body.id}/decisions`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { decided_by: 'controller-1', decision: 'approve', note: 'Looks good' },
    });
    assert.equal(firstApproval.status, 200, firstApproval.raw);
    assert.equal(firstApproval.body.status, 'pending');
    assert.equal(firstApproval.body.approval_count, 1);
    assert.equal(firstApproval.body.remaining_approvals, 1);

    const duplicate = await ctx.api(`/api/payment-approvals/${created.body.id}/decisions`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { decided_by: 'controller-1', decision: 'reject' },
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /already submitted/);

    const secondApproval = await ctx.api(`/api/payment-approvals/${created.body.id}/decisions`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { decided_by: 'controller-2', decision: 'approve' },
    });
    assert.equal(secondApproval.status, 200, secondApproval.raw);
    assert.equal(secondApproval.body.status, 'approved');
    assert.equal(secondApproval.body.approval_count, 2);
    assert.equal(secondApproval.body.remaining_approvals, 0);

    const lateDecision = await ctx.api(`/api/payment-approvals/${created.body.id}/decisions`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: { decided_by: 'controller-3', decision: 'reject' },
    });
    assert.equal(lateDecision.status, 409);
    assert.match(lateDecision.body.error, /already resolved/);

    const validation = await ctx.api(`/api/payment-approvals/${created.body.id}/validate`, {
      headers: { cookie: authCookie },
    });
    assert.equal(validation.status, 200, validation.raw);
    assert.equal(validation.body.is_valid, true);
    assert.equal(validation.body.actual_unique_approvers, 2);
  });

  it('lets only the requester cancel a pending payment approval', async () => {
    const created = await ctx.api(`/api/projects/${projectId}/payment-approvals`, {
      method: 'POST',
      headers: { cookie: authCookie },
      body: {
        requested_by: 'requester-2',
        title: 'Cancel me',
        amount: 300,
      },
    });
    assert.equal(created.status, 201, created.raw);

    const forbidden = await ctx.api(`/api/payment-approvals/${created.body.id}/cancel`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { cancelled_by: 'controller-1' },
    });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.body.error, /Only the requester/);

    const cancelled = await ctx.api(`/api/payment-approvals/${created.body.id}/cancel`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { cancelled_by: 'requester-2' },
    });
    assert.equal(cancelled.status, 200, cancelled.raw);
    assert.equal(cancelled.body.status, 'cancelled');

    const recancel = await ctx.api(`/api/payment-approvals/${created.body.id}/cancel`, {
      method: 'PUT',
      headers: { cookie: authCookie },
      body: { cancelled_by: 'requester-2' },
    });
    assert.equal(recancel.status, 409);
    assert.match(recancel.body.error, /Only pending/);
  });
});
