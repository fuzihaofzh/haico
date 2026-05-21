import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiTestHarness } from './helpers';
import { createApiTestHarness, createTestSession } from './helpers';

describe('Breadcrumb Navigation', () => {
  let ctx: ApiTestHarness;
  let sessionToken: string;
  let projectId: string;
  let agentId: string;

  before(async () => {
    ctx = await createApiTestHarness('breadcrumb-navigation');
    sessionToken = await createTestSession(ctx);

    const project = await ctx.api('/api/projects', {
      method: 'POST',
      body: {
        name: 'breadcrumb-project',
        description: 'Breadcrumb navigation project',
        task_description: 'Test breadcrumb pages',
        command_template: 'echo',
      },
    });
    assert.equal(project.status, 201);
    projectId = project.body.id;

    const agent = await ctx.api(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: { name: 'breadcrumb-agent', role: 'Breadcrumb test agent' },
    });
    assert.equal(agent.status, 201);
    agentId = agent.body.id;
  });

  after(async () => {
    await ctx?.close();
  });

  it('issue.html has breadcrumb with Issues link', async () => {
    const res = await ctx.inject({
      url: '/issues/nonexistent',
      headers: { cookie: `haico-auth=${sessionToken}` },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(
      res.body.includes('id="issues-link"'),
      'Should have issues-link element'
    );
    assert.ok(
      res.body.includes('id="project-link"'),
      'Should have project-link element'
    );
    assert.ok(
      res.body.includes('id="issue-title-breadcrumb"'),
      'Should have issue-title breadcrumb'
    );
  });

  it('project overview page has breadcrumb with section span', async () => {
    const res = await ctx.inject({
      url: `/projects/${projectId}`,
      headers: { cookie: `haico-auth=${sessionToken}` },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(
      res.body.includes('id="breadcrumb-section"'),
      'Should have breadcrumb-section element'
    );
    assert.ok(
      res.body.includes('id="project-name"'),
      'Should have project-name element'
    );
  });

  it('project pages expose real section routes in the project nav', async () => {
    const res = await ctx.inject({
      url: `/projects/${projectId}`,
      headers: { cookie: `haico-auth=${sessionToken}` },
    });
    assert.equal(res.statusCode, 200);
    for (const view of ['overview', 'agents', 'issues', 'activity', 'git', 'knowledge', 'files', 'workflow']) {
      assert.ok(
        res.body.includes(`data-project-section-link="${view}"`),
        `Should have ${view} project section link`
      );
    }
    assert.ok(!res.body.includes('switchTab('), 'Project overview should not use hash tab switching');
  });

  it('project child routes render their dedicated project views', async () => {
    for (const view of ['agents', 'issues', 'activity', 'git', 'knowledge', 'files', 'workflow']) {
      const res = await ctx.inject({
        url: `/projects/${projectId}/${view}`,
        headers: { cookie: `haico-auth=${sessionToken}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes(`data-project-view="${view}"`));
      assert.ok(res.body.includes(`project/${view}.js`));
    }
  });

  it('agent.html no longer renders the embedded Files workspace tab', async () => {
    const res = await ctx.inject({
      url: `/agents/${agentId}`,
      headers: { cookie: `haico-auth=${sessionToken}` },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(
      !res.body.includes('data-panel="files"'),
      'Agent page should not render the old Files workspace tab'
    );
    assert.ok(
      !res.body.includes('workspace-files-panel'),
      'Agent page should not render the old Files workspace panel'
    );
  });
});
