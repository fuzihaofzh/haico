import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiTestHarness } from './helpers';
import { createApiTestHarness, createTestSession } from './helpers';

describe('Project export and cost endpoints', () => {
  let ctx: ApiTestHarness;
  let projectId: string;
  let agentId: string;

  before(async () => {
    ctx = await createApiTestHarness('project-export');
    await createTestSession(ctx);

    const project = await ctx.api('/api/projects', {
      method: 'POST',
      body: {
        name: 'export-project',
        description: 'Project export test',
        task_description: 'Test project export',
        command_template: 'echo',
      },
    });
    assert.equal(project.status, 201);
    projectId = project.body.id;

    const agent = await ctx.api(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: { name: 'export-agent', role: 'Export test agent' },
    });
    assert.equal(agent.status, 201);
    agentId = agent.body.id;

    const issue = await ctx.api(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: { title: 'Exported issue', body: 'Issue body', created_by: 'user' },
    });
    assert.equal(issue.status, 201);

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    db.prepare(
      `INSERT INTO conversation_logs (agent_id, run_id, content, stream, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      agentId,
      'export-cost-run',
      JSON.stringify({ cost_usd: 0.12, input_tokens: 12, output_tokens: 34 }),
      'cost',
      '2026-03-15 12:00:00'
    );
  });

  after(async () => {
    await ctx?.close();
  });

  it('GET /api/projects/:id/export returns full project data', async () => {
    const { status, body } = await ctx.api(`/api/projects/${projectId}/export`);
    assert.equal(status, 200);
    assert.ok(body.exported_at);
    assert.ok(body.project);
    assert.ok(Array.isArray(body.agents));
    assert.ok(Array.isArray(body.issues));
    assert.ok(body.cost_summary);
    assert.equal(typeof body.cost_summary.total_cost_usd, 'number');
  });

  it('GET /api/projects/:id/export returns 404 for nonexistent project', async () => {
    const { status } = await ctx.api('/api/projects/nonexistent/export');
    assert.equal(status, 404);
  });

  it('GET /api/projects/:id/export/issues.csv returns CSV', async () => {
    const res = await ctx.inject({
      url: `/api/projects/${projectId}/export/issues.csv`,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.toString().includes('text/csv'));
    assert.ok(res.body.includes('number,title,status'));
  });

  it('CSV export returns 404 for nonexistent project', async () => {
    const { status } = await ctx.api(
      '/api/projects/nonexistent/export/issues.csv'
    );
    assert.equal(status, 404);
  });

  it('GET /api/projects/:id/costs with period=day returns time_series', async () => {
    const { status, body } = await ctx.api(
      `/api/projects/${projectId}/costs?period=day`
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.time_series));
    assert.ok(Array.isArray(body.runs));
  });
});
