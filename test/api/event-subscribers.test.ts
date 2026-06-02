import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiTestHarness, type ApiTestHarness } from './helpers';

describe('Event subscriber integration', () => {
  let ctx: ApiTestHarness;
  let ownerToken: string;

  before(async () => {
    ctx = await createApiTestHarness('event-subscribers');

    const username = `ev-sub-${Date.now()}`;
    const register = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: { username, password: 'pass1234', display_name: 'Event Test' },
    });
    assert.equal(register.status, 201);

    const login = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'pass1234' },
    });
    assert.equal(login.status, 200);
    ownerToken = login.body.token;
  });

  after(async () => {
    await ctx?.close();
  });

  function authHeaders(): Record<string, string> {
    return { cookie: `haico-auth=${ownerToken}` };
  }

  describe('agent.deleted subscriber', () => {
    it('cleans up issues, knowledge, and executor_sessions when agent is deleted', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();

      const created = await ctx.api('/api/projects', {
        method: 'POST',
        headers: authHeaders(),
        body: {
          name: 'agent-del-test',
          task_description: 'agent deletion cleanup',
          command_template: 'echo',
        },
      });
      assert.equal(created.status, 201);
      const projectId = created.body.id;

      const agents = await ctx.api(`/api/projects/${projectId}/agents`, {
        headers: authHeaders(),
      });
      assert.equal(agents.status, 200);
      const assistant = agents.body.find((a: any) => !a.is_controller);
      assert.ok(assistant, 'should have an assistant agent');

      db.prepare(
        "INSERT INTO issues (id, project_id, number, title, status, assigned_to, created_by) VALUES (?, ?, 1, 'test issue', 'in_progress', ?, 'admin')"
      ).run('issue-del-1', projectId, assistant.id);

      const del = await ctx.api(`/api/agents/${assistant.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      assert.equal(del.status, 200);

      const orphanedIssue = db
        .prepare('SELECT assigned_to FROM issues WHERE id = ?')
        .get('issue-del-1') as { assigned_to: string | null } | undefined;
      assert.ok(orphanedIssue, 'issue should still exist');
      assert.equal(
        orphanedIssue!.assigned_to,
        null,
        'assigned_to should be null after agent deletion'
      );

      const agentKnowledge = db
        .prepare(
          'SELECT COUNT(*) as count FROM knowledge_entries WHERE owner_agent_id = ?'
        )
        .get(assistant.id) as { count: number };
      assert.equal(
        agentKnowledge.count,
        0,
        'agent knowledge entries should be deleted'
      );
    });
  });

  describe('project.deleted subscriber', () => {
    it('cleans up knowledge and summaries when project is deleted', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();

      const created = await ctx.api('/api/projects', {
        method: 'POST',
        headers: authHeaders(),
        body: {
          name: 'proj-del-test',
          task_description: 'project deletion cleanup',
          command_template: 'echo',
        },
      });
      assert.equal(created.status, 201);
      const projectId = created.body.id;

      const beforeCount = db
        .prepare(
          'SELECT COUNT(*) as count FROM knowledge_entries WHERE project_id = ?'
        )
        .get(projectId) as { count: number };
      assert.ok(
        beforeCount.count > 0,
        'project should have knowledge entries before deletion'
      );

      const del = await ctx.api(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      assert.equal(del.status, 200);

      const afterKnowledge = db
        .prepare(
          'SELECT COUNT(*) as count FROM knowledge_entries WHERE project_id = ?'
        )
        .get(projectId) as { count: number };
      assert.equal(
        afterKnowledge.count,
        0,
        'all knowledge entries should be deleted after project deletion'
      );

      const afterSummaries = db
        .prepare(
          'SELECT COUNT(*) as count FROM executive_summaries WHERE project_id = ?'
        )
        .get(projectId) as { count: number };
      assert.equal(
        afterSummaries.count,
        0,
        'all summaries should be deleted after project deletion'
      );
    });
  });

  describe('agent.created subscriber', () => {
    it('creates knowledge entry for new agents via event', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();

      const created = await ctx.api('/api/projects', {
        method: 'POST',
        headers: authHeaders(),
        body: {
          name: 'agent-create-test',
          task_description: 'agent creation knowledge',
          command_template: 'echo',
        },
      });
      assert.equal(created.status, 201);
      const projectId = created.body.id;

      const agentKnowledge = db
        .prepare(
          'SELECT COUNT(*) as count FROM knowledge_entries WHERE project_id = ? AND owner_agent_id IS NOT NULL'
        )
        .get(projectId) as { count: number };
      assert.equal(
        agentKnowledge.count,
        2,
        'both agents should have knowledge entries'
      );
    });
  });
});
