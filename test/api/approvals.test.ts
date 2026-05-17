import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiTestHarness, createApiTestHarness } from './helpers';

describe('Approval service routes', () => {
  let ctx: ApiTestHarness;
  let ownerCookie: string;
  let outsiderCookie: string;
  let projectId: string;
  let agentId: string;

  before(async () => {
    ctx = await createApiTestHarness('approvals');

    const suffix = Date.now();
    const ownerRegister = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: {
        username: `approval-owner-${suffix}`,
        password: 'pass1234',
        display_name: 'Approval Owner',
      },
    });
    assert.equal(ownerRegister.status, 201, ownerRegister.raw);

    const outsiderRegister = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: {
        username: `approval-outsider-${suffix}`,
        password: 'pass1234',
        display_name: 'Approval Outsider',
      },
    });
    assert.equal(outsiderRegister.status, 201, outsiderRegister.raw);

    const ownerLogin = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { username: `approval-owner-${suffix}`, password: 'pass1234' },
    });
    assert.equal(ownerLogin.status, 200, ownerLogin.raw);
    ownerCookie = `haico-auth=${ownerLogin.body.token}`;

    const outsiderLogin = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { username: `approval-outsider-${suffix}`, password: 'pass1234' },
    });
    assert.equal(outsiderLogin.status, 200, outsiderLogin.raw);
    outsiderCookie = `haico-auth=${outsiderLogin.body.token}`;

    const createdProject = await ctx.api('/api/projects', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: {
        name: 'approval-route-project',
        task_description: 'verify approval route refactor',
        command_template: 'echo',
      },
    });
    assert.equal(createdProject.status, 201, createdProject.raw);
    projectId = createdProject.body.id;

    const agents = await ctx.api(`/api/projects/${projectId}/agents`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(agents.status, 200, agents.raw);
    assert.ok(Array.isArray(agents.body));
    assert.ok(agents.body.length > 0, 'project should have a default agent');
    agentId = agents.body[0].id;
  });

  after(async () => {
    await ctx?.close();
  });

  it('validates approval create and decision inputs through domain errors', async () => {
    const missingFields = await ctx.api(`/api/projects/${projectId}/approvals`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { title: '' },
    });
    assert.equal(missingFields.status, 400);
    assert.match(missingFields.body.error, /agent_id and title/);

    const unknownAgent = await ctx.api(`/api/projects/${projectId}/approvals`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { agent_id: 'missing-agent', title: 'Needs approval' },
    });
    assert.equal(unknownAgent.status, 404);
    assert.match(unknownAgent.body.error, /Agent not found/);

    const created = await ctx.api(`/api/projects/${projectId}/approvals`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: {
        agent_id: agentId,
        title: 'Deploy check',
        description: 'Approve deployment',
        risk_level: 'not-a-risk',
      },
    });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.risk_level, 'medium');
    assert.equal(created.body.status, 'pending');

    const listed = await ctx.api(`/api/projects/${projectId}/approvals?status=pending&limit=5`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(listed.status, 200, listed.raw);
    const listedApproval = listed.body.find((approval: any) => approval.id === created.body.id);
    assert.ok(listedApproval, 'created approval should appear in pending list');
    assert.ok(listedApproval.agent_name, 'list response should include agent_name');

    const invalidDecision = await ctx.api(`/api/approvals/${created.body.id}`, {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: { status: 'maybe' },
    });
    assert.equal(invalidDecision.status, 400);
    assert.match(invalidDecision.body.error, /approved or rejected/);

    const approved = await ctx.api(`/api/approvals/${created.body.id}`, {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: { status: 'approved', decision_note: 'ok', decided_by: 'owner' },
    });
    assert.equal(approved.status, 200, approved.raw);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.agent_name, listedApproval.agent_name);

    const duplicateDecision = await ctx.api(`/api/approvals/${created.body.id}`, {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: { status: 'rejected' },
    });
    assert.equal(duplicateDecision.status, 409);
    assert.match(duplicateDecision.body.error, /already been decided/);
  });

  it('returns 404 for missing approval decisions', async () => {
    const missing = await ctx.api('/api/approvals/not-found', {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: { status: 'approved' },
    });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /Approval request not found/);
  });

  it('enforces project access for direct approval reads and decisions', async () => {
    const created = await ctx.api(`/api/projects/${projectId}/approvals`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: {
        agent_id: agentId,
        title: 'Restricted approval',
      },
    });
    assert.equal(created.status, 201, created.raw);

    const ownerRead = await ctx.api(`/api/approvals/${created.body.id}`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(ownerRead.status, 200, ownerRead.raw);
    assert.equal(ownerRead.body.id, created.body.id);

    const outsiderRead = await ctx.api(`/api/approvals/${created.body.id}`, {
      headers: { cookie: outsiderCookie },
    });
    assert.equal(outsiderRead.status, 403);

    const outsiderDecision = await ctx.api(`/api/approvals/${created.body.id}`, {
      method: 'PUT',
      headers: { cookie: outsiderCookie },
      body: { status: 'approved' },
    });
    assert.equal(outsiderDecision.status, 403);
  });

  it('keeps workflow-status response shape intact', async () => {
    const status = await ctx.api(`/api/projects/${projectId}/workflow-status`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(status.status, 200, status.raw);
    assert.ok(Array.isArray(status.body.agents));
    assert.ok(Array.isArray(status.body.recent_messages));
    assert.ok(Array.isArray(status.body.pending_approvals));
    assert.equal(typeof status.body.total_active_issues, 'number');
    assert.ok(
      status.body.agents.every((agent: any) => Array.isArray(agent.current_issues)),
      'agents should include current_issues arrays'
    );
  });
});
