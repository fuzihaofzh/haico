import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiTestHarness, ApiTestHarness } from './helpers';

describe('Project service refactor boundaries', () => {
  let ctx: ApiTestHarness;
  let ownerToken: string;
  let memberToken: string;
  let memberUser: { id: string; username: string };

  before(async () => {
    ctx = await createApiTestHarness('projects-service');

    const ownerUsername = `project-owner-${Date.now()}`;
    const memberUsername = `project-member-${Date.now()}`;

    const ownerRegister = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: { username: ownerUsername, password: 'pass1234', display_name: 'Project Owner' },
    });
    assert.equal(ownerRegister.status, 201);

    const memberRegister = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: { username: memberUsername, password: 'pass1234', display_name: 'Project Member' },
    });
    assert.equal(memberRegister.status, 201);

    const ownerLogin = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { username: ownerUsername, password: 'pass1234' },
    });
    assert.equal(ownerLogin.status, 200);
    ownerToken = ownerLogin.body.token;

    const memberLogin = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { username: memberUsername, password: 'pass1234' },
    });
    assert.equal(memberLogin.status, 200);
    memberToken = memberLogin.body.token;
    memberUser = memberLogin.body.user;
  });

  after(async () => {
    await ctx?.close();
  });

  it('creates a project atomically with controller, assistant, knowledge, and owner membership', async () => {
    const created = await ctx.api('/api/projects', {
      method: 'POST',
      headers: { cookie: `haico-auth=${ownerToken}` },
      body: {
        name: 'service-boundary-project',
        description: 'project service regression',
        task_description: 'verify service-owned create workflow',
        command_template: 'echo',
      },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.id);

    const agents = await ctx.api(`/api/projects/${created.body.id}/agents`, {
      headers: { cookie: `haico-auth=${ownerToken}` },
    });
    assert.equal(agents.status, 200);
    assert.equal(agents.body.length, 2);
    assert.ok(agents.body.some((agent: any) => agent.is_controller));
    assert.ok(agents.body.some((agent: any) => !agent.is_controller));

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const ownerMember = db.prepare(
      "SELECT role FROM project_members WHERE project_id = ? AND role = 'owner'"
    ).get(created.body.id) as { role: string } | undefined;
    assert.equal(ownerMember?.role, 'owner');

    const knowledgeCount = db.prepare(
      'SELECT COUNT(*) as count FROM knowledge_entries WHERE project_id = ? AND owner_agent_id IS NOT NULL'
    ).get(created.body.id) as { count: number };
    assert.equal(knowledgeCount.count, 2);
  });

  it('maps invalid project orchestrator engine through project domain errors', async () => {
    const res = await ctx.api('/api/projects', {
      method: 'POST',
      headers: { cookie: `haico-auth=${ownerToken}` },
      body: {
        name: 'bad-engine-project',
        task_description: 'should be rejected',
        command_template: 'echo',
        orchestrator_engine: 'bogus',
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /orchestrator_engine/);
  });

  it('keeps owner membership protected while allowing normal member lifecycle', async () => {
    const project = await ctx.api('/api/projects', {
      method: 'POST',
      headers: { cookie: `haico-auth=${ownerToken}` },
      body: {
        name: 'member-boundary-project',
        task_description: 'verify member service rules',
        command_template: 'echo',
      },
    });
    assert.equal(project.status, 201);

    const added = await ctx.api(`/api/projects/${project.body.id}/members`, {
      method: 'POST',
      headers: { cookie: `haico-auth=${ownerToken}` },
      body: { username: memberUser.username, role: 'editor' },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.role, 'editor');

    const patched = await ctx.api(`/api/projects/${project.body.id}/members/${memberUser.id}`, {
      method: 'PATCH',
      headers: { cookie: `haico-auth=${ownerToken}` },
      body: { role: 'member' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.role, 'member');

    const ownerRemove = await ctx.api(`/api/projects/${project.body.id}/members/${project.body.owner.id}`, {
      method: 'DELETE',
      headers: { cookie: `haico-auth=${ownerToken}` },
    });
    assert.equal(ownerRemove.status, 400);
    assert.match(ownerRemove.body.error, /owner/i);
  });
});
