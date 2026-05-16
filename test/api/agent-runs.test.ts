import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiTestHarness } from './helpers';
import { createApiTestHarness } from './helpers';

describe('Agent Runs and Run Report', () => {
  let ctx: ApiTestHarness;
  let projectId: string;
  let agentId: string;

  before(async () => {
    ctx = await createApiTestHarness('agent-runs');
    const project = await ctx.api('/api/projects', {
      method: 'POST',
      body: {
        name: 'agent-runs-project',
        description: 'Agent runs test',
        task_description: 'Test agent run APIs',
        command_template: 'echo',
      },
    });
    assert.equal(project.status, 201);
    projectId = project.body.id;

    const agent = await ctx.api(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: { name: 'runs-agent', role: 'Runs test agent' },
    });
    assert.equal(agent.status, 201);
    agentId = agent.body.id;
  });

  after(async () => {
    await ctx?.close();
  });

  it('GET /api/agents/:id/runs returns run list structure', async () => {
    const { status, body } = await ctx.api(`/api/agents/${agentId}/runs`);
    assert.equal(status, 200);
    assert.ok(body.runs !== undefined, 'response should have runs array');
    assert.ok(Array.isArray(body.runs));
  });

  it('GET /api/agents/:id/runs returns 404 for nonexistent agent', async () => {
    const { status, body } = await ctx.api('/api/agents/nonexistent-id/runs');
    assert.equal(status, 404);
    assert.equal(body.error, 'Agent not found');
  });

  it('run items contain expected fields when present', async () => {
    const { body } = await ctx.api(`/api/agents/${agentId}/runs`);
    if (body.runs.length > 0) {
      const run = body.runs[0];
      assert.equal(typeof run.run_id, 'string');
      assert.equal(typeof run.started_at, 'string');
      assert.equal(typeof run.status, 'string');
      assert.ok(run.status === 'success' || run.status === 'error');
      assert.equal(typeof run.cost_usd, 'number');
      assert.equal(typeof run.tool_call_count, 'number');
      assert.ok('result_snippet' in run);
    }
  });

  it('GET /api/agents/:id/runs respects limit param', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${agentId}/runs?limit=1`
    );
    assert.equal(status, 200);
    assert.ok(body.runs.length <= 1);
  });

  it('GET /api/agents/:id/runs/:runId/report returns 404 for nonexistent run', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${agentId}/runs/fake-run-id/report`
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'Run not found');
  });

  it('GET /api/agents/:id/runs/:runId/report returns 404 for nonexistent agent', async () => {
    const { status, body } = await ctx.api(
      '/api/agents/nonexistent-id/runs/fake/report'
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'Agent not found');
  });
});
