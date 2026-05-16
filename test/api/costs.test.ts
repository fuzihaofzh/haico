import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiTestHarness } from './helpers';
import { createApiTestHarness, createSinglePasswordSession } from './helpers';

describe('API cost reporting', () => {
  let ctx: ApiTestHarness;
  let sessionToken: string;

  before(async () => {
    ctx = await createApiTestHarness('costs');
    sessionToken = await createSinglePasswordSession(ctx);
  });

  after(async () => {
    await ctx?.close();
  });

  describe('Cost de-duplication (#489/#493/#494/#495)', () => {
    let dedupeProjectId: string;
    let dedupeAgentId: string;

    before(async () => {
      const createdProject = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'cost-dedupe-project',
          description: 'dedupe regression checks',
          task_description: 'verify cost de-duplication',
          command_template: 'echo',
        },
      });
      assert.equal(createdProject.status, 201);
      dedupeProjectId = createdProject.body.id;

      const createdAgent = await ctx.api(
        `/api/projects/${dedupeProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'cost-dedupe-agent', role: 'Cost dedupe verification' },
        }
      );
      assert.equal(createdAgent.status, 201);
      dedupeAgentId = createdAgent.body.id;

      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const insertLog = db.prepare(
        `INSERT INTO conversation_logs (agent_id, run_id, content, stream, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );

      insertLog.run(
        dedupeAgentId,
        'dedupe-run-1',
        JSON.stringify({ cost_usd: 0.1, input_tokens: 100, output_tokens: 50 }),
        'cost',
        '2026-01-01 10:00:00'
      );
      insertLog.run(
        dedupeAgentId,
        'dedupe-run-1',
        JSON.stringify({
          cost_usd: 0.3,
          input_tokens: 300,
          output_tokens: 150,
          duration_ms: 1000,
        }),
        'cost',
        '2026-01-01 10:05:00'
      );
      insertLog.run(
        dedupeAgentId,
        'dedupe-run-2',
        JSON.stringify({
          cost_usd: 0.2,
          input_tokens: 200,
          output_tokens: 80,
          duration_ms: 2000,
        }),
        'cost',
        '2026-01-02 09:00:00'
      );
    });

    it('GET /api/agents/:id/costs only counts the latest cumulative row per run_id', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${dedupeAgentId}/costs`
      );
      assert.equal(status, 200);
      assert.equal(body.total_runs, 2);
      assert.equal(body.total_cost_usd, 0.5);
      assert.equal(body.total_input_tokens, 500);
      assert.equal(body.total_output_tokens, 230);
      assert.deepEqual(
        body.runs.map((run: any) => ({
          run_id: run.run_id,
          cost_usd: run.cost_usd,
        })),
        [
          { run_id: 'dedupe-run-1', cost_usd: 0.3 },
          { run_id: 'dedupe-run-2', cost_usd: 0.2 },
        ]
      );
    });

    it('GET /api/agents/:id/runs uses the latest cost row for each run_id', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${dedupeAgentId}/runs`
      );
      assert.equal(status, 200);
      const byRunId = new Map(body.runs.map((run: any) => [run.run_id, run]));
      assert.equal(byRunId.get('dedupe-run-1')?.cost_usd, 0.3);
      assert.equal(byRunId.get('dedupe-run-1')?.input_tokens, 300);
      assert.equal(byRunId.get('dedupe-run-1')?.output_tokens, 150);
      assert.equal(byRunId.get('dedupe-run-2')?.cost_usd, 0.2);
    });

    it('project-level cost endpoints use de-duplicated totals', async () => {
      const costs = await ctx.api(
        `/api/projects/${dedupeProjectId}/costs?period=day`
      );
      assert.equal(costs.status, 200);
      assert.equal(costs.body.total_cost_usd, 0.5);
      assert.equal(costs.body.total_input_tokens, 500);
      assert.equal(costs.body.total_output_tokens, 230);
      assert.equal(costs.body.by_agent['cost-dedupe-agent'].cost, 0.5);
      assert.equal(costs.body.by_agent['cost-dedupe-agent'].runs, 2);

      const exported = await ctx.api(`/api/projects/${dedupeProjectId}/export`);
      assert.equal(exported.status, 200);
      assert.equal(exported.body.cost_summary.total_cost_usd, 0.5);
      assert.equal(exported.body.cost_summary.total_input_tokens, 500);
      assert.equal(exported.body.cost_summary.total_output_tokens, 230);
    });

    it('dashboard aggregates also use de-duplicated totals', async () => {
      const usage = await ctx.api(
        '/api/dashboard/usage-by-project?period=day',
        {
          headers: { cookie: `haico-auth=${sessionToken}` },
        }
      );
      assert.equal(usage.status, 200);
      const projectEntry = usage.body.projects.find(
        (project: any) => project.id === dedupeProjectId
      );
      assert.ok(
        projectEntry,
        'usage-by-project should include the dedupe test project'
      );

      let projectCost = 0;
      for (const bucket of usage.body.time_buckets) {
        projectCost += usage.body.data[bucket]?.[dedupeProjectId]?.cost || 0;
      }
      assert.equal(projectCost, 0.5);

      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const rawCostRows = db
        .prepare(
          `SELECT run_id, content, id
         FROM conversation_logs
         WHERE stream = 'cost'
         ORDER BY run_id, id DESC`
        )
        .all() as Array<{ run_id: string; content: string; id: number }>;
      const latestByRun = new Map<string, number>();
      for (const row of rawCostRows) {
        if (latestByRun.has(row.run_id)) continue;
        latestByRun.set(row.run_id, JSON.parse(row.content).cost_usd || 0);
      }
      const expectedTotal = Array.from(latestByRun.values()).reduce(
        (sum, value) => sum + value,
        0
      );

      const summaryAfter = await ctx.api('/api/dashboard/summary', {
        headers: { cookie: `haico-auth=${sessionToken}` },
      });
      assert.equal(summaryAfter.status, 200);
      assert.equal(summaryAfter.body.total_cost_usd, expectedTotal);
    });
  });

  describe('Codex zero-cost usage visibility (#548)', () => {
    let codexProjectId: string;
    let codexAgentId: string;

    before(async () => {
      const project = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'codex-cost-project',
          description: 'Codex cost test',
          task_description: 'test',
          command_template: 'echo',
        },
      });
      assert.equal(project.status, 201);
      codexProjectId = project.body.id;

      const agent = await ctx.api(`/api/projects/${codexProjectId}/agents`, {
        method: 'POST',
        body: { name: 'codex-agent', role: 'Codex cost test agent' },
      });
      assert.equal(agent.status, 201);
      codexAgentId = agent.body.id;

      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      db.prepare(
        `INSERT INTO conversation_logs (agent_id, run_id, content, stream, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        codexAgentId,
        'codex-run-1',
        JSON.stringify({
          cost_usd: 0,
          input_tokens: 5000,
          output_tokens: 1200,
          cache_read: 3000,
          cache_creation: 2000,
        }),
        'cost',
        '2026-03-15 12:00:00'
      );
    });

    it('agent costs API returns token data even when cost_usd is 0', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${codexAgentId}/costs`
      );
      assert.equal(status, 200);
      assert.equal(body.total_runs, 1);
      assert.equal(body.total_cost_usd, 0);
      assert.equal(body.total_input_tokens, 5000);
      assert.equal(body.total_output_tokens, 1200);
      assert.equal(body.runs[0].cost_usd, 0);
      assert.equal(body.runs[0].input_tokens, 5000);
      assert.equal(body.runs[0].output_tokens, 1200);
    });

    it('project costs API includes by_agent token data for zero-cost agents', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${codexProjectId}/costs`
      );
      assert.equal(status, 200);
      assert.equal(body.total_cost_usd, 0);
      assert.equal(body.total_input_tokens, 5000);
      assert.equal(body.total_output_tokens, 1200);
      const agentData = body.by_agent['codex-agent'];
      assert.ok(agentData, 'by_agent should include codex-agent');
      assert.equal(agentData.cost, 0);
      assert.equal(agentData.runs, 1);
      assert.equal(agentData.input_tokens, 5000);
      assert.equal(agentData.output_tokens, 1200);
    });

    it('run history returns token fields for zero-cost runs', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${codexAgentId}/runs`
      );
      assert.equal(status, 200);
      assert.ok(body.runs.length >= 1);
      const run = body.runs.find((r: any) => r.run_id === 'codex-run-1');
      assert.ok(run, 'should find the codex run');
      assert.equal(run.cost_usd, 0);
      assert.equal(run.input_tokens, 5000);
      assert.equal(run.output_tokens, 1200);
    });
  });
});
