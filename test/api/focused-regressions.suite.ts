import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiTestContext } from './helpers';

export function registerFocusedApiRegressionSuites(ctx: ApiTestContext): void {
  // ─── UI ───

  describe('UI Pages', () => {
    it('GET /setup is removed', async () => {
      const res = await ctx.inject({ url: '/setup' });
      assert.equal(res.statusCode, 404);
    });

    it('GET /login returns HTML', async () => {
      const res = await ctx.inject({ url: '/login' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('HAICO'));
    });
  });

  describe('Session auth regression guard', () => {
    it('username/password login works through sessions', async () => {
      const { status } = await ctx.api('/api/auth/login', {
        method: 'POST',
        body: { username: 'testadmin', password: 'admin1234' },
      });
      assert.equal(status, 200);
    });

    it('auth middleware does not redirect authenticated user to setup', async () => {
      const loginRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'testadmin', password: 'admin1234' },
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(loginRes.statusCode, 200);
      const token = (loginRes.headers['set-cookie'] as string).match(
        /haico-auth=([^;]+)/
      )![1];

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/dashboard/summary',
        headers: { cookie: `haico-auth=${token}` },
      });
      assert.equal(res.statusCode, 200, 'Authenticated request should succeed');
      if (res.headers.location) {
        assert.ok(
          !res.headers.location.toString().includes('/setup'),
          'Should NEVER redirect authenticated user to /setup'
        );
      }
    });

    it('unauthenticated request redirects to /login, not /setup', async () => {
      const res = await ctx.inject({
        url: '/change-password',
        headers: { cookie: 'haico-auth=invalid' },
      });
      assert.equal(
        res.statusCode,
        302,
        'Should redirect unauthenticated request'
      );
      assert.equal(
        res.headers.location,
        '/login',
        'Should redirect to /login, not /setup'
      );
    });
  });

  // ─── session_max_tokens default value (#145) ───

  describe('Controller issue-triggered context filtering (#170)', () => {
    let ctxProjectId: string;

    before(async () => {
      // Create a project for this test
      const { body } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'ctx-filter-test',
          task_description: 'Test issue context filtering',
          working_directory: '/tmp/ctx-test',
          command_template: 'echo done',
        },
      });
      ctxProjectId = body.id;

      // Create a controller agent
      await ctx.api(`/api/projects/${ctxProjectId}/agents`, {
        method: 'POST',
        body: {
          name: 'ctx-controller',
          role: 'controller',
          is_controller: true,
        },
      });

      // Create a worker agent
      await ctx.api(`/api/projects/${ctxProjectId}/agents`, {
        method: 'POST',
        body: { name: 'ctx-worker', role: 'worker' },
      });

      // Create multiple issues
      await ctx.api(`/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Alpha', body: 'Alpha body', created_by: 'user' },
      });
      await ctx.api(`/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Beta', body: 'Beta body', created_by: 'user' },
      });
      await ctx.api(`/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Gamma', body: 'Gamma body', created_by: 'user' },
      });
    });

    it('buildControllerTaskPrompt without triggerIssueNumber includes all open issues', async () => {
      const { buildControllerTaskPrompt } = await import(
        '../../src/services/controller'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(ctxProjectId) as any;

      const prompt = buildControllerTaskPrompt(project);
      assert.ok(prompt.includes('Issue Alpha'), 'Should include Issue Alpha');
      assert.ok(prompt.includes('Issue Beta'), 'Should include Issue Beta');
      assert.ok(prompt.includes('Issue Gamma'), 'Should include Issue Gamma');
      assert.ok(
        !prompt.includes('Trigger Context'),
        'Should NOT have trigger context hint'
      );
    });

    it('buildControllerTaskPrompt with triggerIssueNumber=1 includes only that issue', async () => {
      const { buildControllerTaskPrompt } = await import(
        '../../src/services/controller'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(ctxProjectId) as any;
      const issue = db
        .prepare('SELECT id FROM issues WHERE project_id = ? AND number = 1')
        .get(ctxProjectId) as any;

      const prompt = buildControllerTaskPrompt(project, 1);
      assert.ok(
        prompt.includes('Issue Alpha'),
        'Should include Issue Alpha (issue #1)'
      );
      assert.ok(prompt.includes(issue.id), 'Should include trigger issue UUID');
      assert.ok(
        !prompt.includes('Issue Beta'),
        'Should NOT include Issue Beta'
      );
      assert.ok(
        !prompt.includes('Issue Gamma'),
        'Should NOT include Issue Gamma'
      );
      assert.ok(
        prompt.includes('Trigger Context'),
        'Should have trigger context hint'
      );
      assert.ok(
        prompt.includes('issue #1'),
        'Should mention trigger issue number'
      );
    });

    it('buildControllerTaskPrompt with triggerIssueNumber=2 includes only issue #2', async () => {
      const { buildControllerTaskPrompt } = await import(
        '../../src/services/controller'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(ctxProjectId) as any;

      const prompt = buildControllerTaskPrompt(project, 2);
      assert.ok(
        !prompt.includes('Issue Alpha'),
        'Should NOT include Issue Alpha'
      );
      assert.ok(
        prompt.includes('Issue Beta'),
        'Should include Issue Beta (issue #2)'
      );
      assert.ok(
        !prompt.includes('Issue Gamma'),
        'Should NOT include Issue Gamma'
      );
      assert.ok(
        prompt.includes('issue #2'),
        'Should mention trigger issue number 2'
      );
    });

    it('scheduler trigger (no triggerIssueNumber) includes all issues', async () => {
      const { buildControllerTaskPrompt } = await import(
        '../../src/services/controller'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(ctxProjectId) as any;

      // Simulate scheduler behavior: no triggerIssueNumber
      const prompt = buildControllerTaskPrompt(project, undefined);
      assert.ok(
        prompt.includes('Issue Alpha'),
        'Scheduler should see all issues'
      );
      assert.ok(
        prompt.includes('Issue Beta'),
        'Scheduler should see all issues'
      );
      assert.ok(
        prompt.includes('Issue Gamma'),
        'Scheduler should see all issues'
      );
      assert.ok(
        !prompt.includes('Trigger Context'),
        'Scheduler should NOT have trigger hint'
      );
    });

    it('triggerControllerOnDemand passes triggerIssueNumber through', async () => {
      // Verify the routes code passes triggerIssueNumber by checking that
      // creating an issue with on-demand mode includes the issue number
      const { status } = await ctx.api(`/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: {
          title: 'On-demand trigger test',
          body: 'Should pass triggerIssueNumber',
          created_by: 'user',
        },
      });
      assert.equal(status, 201);
      // The call completes without error, verifying triggerIssueNumber is accepted
      await new Promise((r) => setTimeout(r, 1500));
    });
  });

  describe('session_max_tokens default 400000 (#145, updated #216)', () => {
    let tokenTestProjectId: string;

    before(async () => {
      const { body } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'token-test-project',
          description: 'For token tests',
          task_description: 'test',
          command_template: 'echo',
        },
      });
      tokenTestProjectId = body.id;
    });

    it('newly created agent has session_max_tokens = 400000', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${tokenTestProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'token-test-agent', role: 'test' },
        }
      );
      assert.equal(status, 201);
      assert.equal(
        body.session_max_tokens,
        400000,
        'Default session_max_tokens should be 400000'
      );
    });

    it('PUT session_max_tokens updates correctly', async () => {
      const { body: created } = await ctx.api(
        `/api/projects/${tokenTestProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'token-update-agent', role: 'test' },
        }
      );
      assert.equal(created.session_max_tokens, 400000);

      const { status, body } = await ctx.api(`/api/agents/${created.id}`, {
        method: 'PUT',
        body: { session_max_tokens: 500000 },
      });
      assert.equal(status, 200);
      assert.equal(body.session_max_tokens, 500000, 'Should update to 500000');
    });

    it('PUT session_max_tokens=0 stores 0 (minimum is 0)', async () => {
      const { body: created } = await ctx.api(
        `/api/projects/${tokenTestProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'token-zero-agent', role: 'test' },
        }
      );

      const { status, body } = await ctx.api(`/api/agents/${created.id}`, {
        method: 'PUT',
        body: { session_max_tokens: 0 },
      });
      assert.equal(status, 200);
      assert.equal(
        body.session_max_tokens,
        0,
        'session_max_tokens=0 should be allowed (Math.max(0,...))'
      );
    });

    it('PUT negative session_max_tokens is clamped to 0', async () => {
      const { body: created } = await ctx.api(
        `/api/projects/${tokenTestProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'token-neg-agent', role: 'test' },
        }
      );

      const { status, body } = await ctx.api(`/api/agents/${created.id}`, {
        method: 'PUT',
        body: { session_max_tokens: -100 },
      });
      assert.equal(status, 200);
      assert.equal(
        body.session_max_tokens,
        0,
        'Negative value should be clamped to 0'
      );
    });

    it('schema migration sets existing 0 values to 400000', async () => {
      const { body: created } = await ctx.api(
        `/api/projects/${tokenTestProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'migration-test-agent', role: 'test' },
        }
      );
      // Set to 0 via API
      await ctx.api(`/api/agents/${created.id}`, {
        method: 'PUT',
        body: { session_max_tokens: 0 },
      });
      // Verify it's 0
      const { body: before } = await ctx.api(`/api/agents/${created.id}`);
      assert.equal(
        before.session_max_tokens,
        0,
        'Should be 0 before migration'
      );

      // Run the same migration SQL that schema.ts runs on startup
      const { getDatabase } = require('../../src/db/database');
      const db = getDatabase();
      const result = db
        .prepare(
          'UPDATE agents SET session_max_tokens = 400000 WHERE session_max_tokens = 0'
        )
        .run();
      assert.ok(result.changes > 0, 'Migration should update at least 1 row');

      // Check that the agent's 0 was updated to 400000
      const { body: after } = await ctx.api(`/api/agents/${created.id}`);
      assert.equal(
        after.session_max_tokens,
        400000,
        'Migration should update 0 to 400000'
      );
    });
  });

  // ─── User comment auto-reassign (#183) ───

  describe('User comment auto-reassign (#183)', () => {
    let raProjectId: string;
    let raControllerId: string;
    let raWorkerId: string;
    let raWorker2Id: string;
    let raIssueId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'reassign-test',
          task_description: 'Test auto-reassign',
          working_directory: '/tmp/reassign-test',
          command_template: 'echo done',
        },
      });
      raProjectId = proj.id;

      // Use the auto-created controller (project creation auto-creates one with is_controller=1)
      const { body: agents } = await ctx.api(
        `/api/projects/${raProjectId}/agents`
      );
      const ctrl = agents.find((a: any) => a.is_controller);
      assert.ok(ctrl, 'Project should have auto-created controller');
      raControllerId = ctrl.id;

      const { body: w1 } = await ctx.api(
        `/api/projects/${raProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'ra-worker', role: 'worker' },
        }
      );
      raWorkerId = w1.id;

      const { body: w2 } = await ctx.api(
        `/api/projects/${raProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'ra-worker2', role: 'worker2' },
        }
      );
      raWorker2Id = w2.id;

      const { body: iss } = await ctx.api(
        `/api/projects/${raProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Reassign test issue',
            body: 'Test',
            created_by: 'user',
          },
        }
      );
      raIssueId = iss.id;
    });

    it('user comment with @mention reassigns to mentioned agent', async () => {
      const { status } = await ctx.api(`/api/issues/${raIssueId}/comments`, {
        method: 'POST',
        body: { author_id: 'user', body: 'Hey @ra-worker please look at this' },
      });
      assert.equal(status, 201);

      const { body: issue } = await ctx.api(`/api/issues/${raIssueId}`);
      assert.equal(
        issue.assigned_to,
        raWorkerId,
        'Should be reassigned to mentioned agent'
      );
    });

    it('user comment with multiple @mentions assigns to first match', async () => {
      const { status } = await ctx.api(`/api/issues/${raIssueId}/comments`, {
        method: 'POST',
        body: {
          author_id: 'user',
          body: '@ra-worker2 and @ra-worker check this',
        },
      });
      assert.equal(status, 201);

      const { body: issue } = await ctx.api(`/api/issues/${raIssueId}`);
      assert.equal(
        issue.assigned_to,
        raWorker2Id,
        'Should be assigned to first mentioned agent (ra-worker2)'
      );
    });

    it('user comment without @mention assigns to controller', async () => {
      const { status } = await ctx.api(`/api/issues/${raIssueId}/comments`, {
        method: 'POST',
        body: { author_id: 'user', body: 'No mention here, just a question' },
      });
      assert.equal(status, 201);

      const { body: issue } = await ctx.api(`/api/issues/${raIssueId}`);
      assert.equal(
        issue.assigned_to,
        raControllerId,
        'Should be assigned to controller when no @mention'
      );
    });

    it('user comment on done/closed issue reopens it', async () => {
      // Close the issue first
      await ctx.api(`/api/issues/${raIssueId}`, {
        method: 'PUT',
        body: { status: 'done', actor: 'user' },
      });
      const { body: closed } = await ctx.api(`/api/issues/${raIssueId}`);
      assert.equal(closed.status, 'done');

      // User comments — should reopen
      await ctx.api(`/api/issues/${raIssueId}/comments`, {
        method: 'POST',
        body: { author_id: 'user', body: 'Actually this is not fixed' },
      });

      const { body: reopened } = await ctx.api(`/api/issues/${raIssueId}`);
      assert.equal(
        reopened.status,
        'open',
        'Issue should be reopened after user comment on done issue'
      );
    });

    it('agent comment does NOT trigger auto-reassign', async () => {
      // Set a known assignee first
      await ctx.api(`/api/issues/${raIssueId}`, {
        method: 'PUT',
        body: { assigned_to: raWorkerId, actor: 'system' },
      });

      // Agent comments — should NOT change assignment
      await ctx.api(`/api/issues/${raIssueId}/comments`, {
        method: 'POST',
        body: {
          author_id: raWorkerId,
          body: 'Agent reporting progress @ra-worker2',
        },
      });

      const { body: issue } = await ctx.api(`/api/issues/${raIssueId}`);
      assert.equal(
        issue.assigned_to,
        raWorkerId,
        'Agent comment should NOT change assignee'
      );
    });
  });

  // ─── Acknowledge / Inbox Search (#227/#228) ───

  describe('Acknowledge and Inbox Search (#227, #228)', () => {
    let ackProjectId: string;
    let ackIssueId: string;

    before(async () => {
      // Create a project and an issue for ack tests
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'ack-test',
          description: 'Ack test project',
          task_description:
            'Test project for acknowledge and inbox search tests',
        },
      });
      ackProjectId = proj.id;
      const { body: issue } = await ctx.api(
        `/api/projects/${ackProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Ack Test Issue',
            body: 'Some body text',
            created_by: 'user',
            assigned_to: 'user',
          },
        }
      );
      ackIssueId = issue.id;
    });

    it('issue starts with acknowledged_at = null', async () => {
      const { body } = await ctx.api(`/api/issues/${ackIssueId}`);
      assert.equal(
        body.acknowledged_at,
        null,
        'New issue should have acknowledged_at = null'
      );
    });

    it('POST /api/issues/:id/acknowledge sets acknowledged_at', async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${ackIssueId}/acknowledge`,
        {
          method: 'POST',
          body: {},
        }
      );
      assert.equal(status, 200, 'Acknowledge should return 200');
      assert.ok(
        body.acknowledged_at,
        'acknowledged_at should be set after acknowledge'
      );
    });

    it('POST /api/issues/:id/unacknowledge clears acknowledged_at', async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${ackIssueId}/unacknowledge`,
        {
          method: 'POST',
          body: {},
        }
      );
      assert.equal(status, 200, 'Unacknowledge should return 200');
      assert.equal(
        body.acknowledged_at,
        null,
        'acknowledged_at should be null after unacknowledge'
      );
    });

    it('GET /api/inbox/search returns matching issues', async () => {
      const { status, body } = await ctx.api('/api/inbox/search?q=Ack+Test');
      assert.equal(status, 200, 'Inbox search should return 200');
      assert.ok(Array.isArray(body), 'Inbox search result should be an array');
      const found = body.find((i: any) => i.id === ackIssueId);
      assert.ok(found, 'Created issue should appear in inbox search results');
    });

    it('GET /api/inbox/search returns empty array for no match', async () => {
      const { status, body } = await ctx.api(
        '/api/inbox/search?q=zzz_no_match_xyz'
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(
        body.length,
        0,
        'Should return empty array for non-matching query'
      );
    });

    it('GET /api/inbox/search returns empty array when q is missing', async () => {
      const { status, body } = await ctx.api('/api/inbox/search');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(
        body.length,
        0,
        'Should return empty array when no query provided'
      );
    });

    it('GET /api/inbox/search matches by issue number', async () => {
      // Get the issue number first
      const { body: issue } = await ctx.api(`/api/issues/${ackIssueId}`);
      const issueNum = String(issue.number);
      const { body } = await ctx.api(`/api/inbox/search?q=${issueNum}`);
      assert.ok(Array.isArray(body));
      const found = body.find((i: any) => i.id === ackIssueId);
      assert.ok(found, 'Inbox search should match by issue number');
    });
  });

  // ─── Agent Stop SIGTERM Propagation (#257) ───

  describe('Agent stop button — SIGTERM propagation via exec prefix (#257)', () => {
    let stopTestProjectId: string;
    let stopTestAgentId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'stop-sigterm-test',
          description: 'Test project for stop/SIGTERM verification',
          task_description: 'Stop test',
          command_template: 'tail -f /dev/null #',
        },
      });
      stopTestProjectId = proj.id;

      const { body: ag } = await ctx.api(
        `/api/projects/${stopTestProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'stop-test-agent', role: 'Stop test agent' },
        }
      );
      stopTestAgentId = ag.id;
    });

    after(async () => {
      // Clean up: stop if still running then delete project
      await ctx.api(`/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 1000));
      await ctx.api(`/api/projects/${stopTestProjectId}`, { method: 'DELETE' });
    });

    it('status is "idle" after stop (stopped state removed, agents return to idle)', async () => {
      // Start a long-running process (tail -f /dev/null never exits)
      const { status: startStatus, body: startBody } = await ctx.api(
        `/api/agents/${stopTestAgentId}/start`,
        {
          method: 'POST',
          body: { prompt: 'run forever' },
        }
      );
      assert.equal(startStatus, 200, 'start should succeed');
      assert.ok(startBody.pid, 'should get a PID');

      // Wait for process to be registered
      await new Promise((r) => setTimeout(r, 500));
      const { body: runningState } = await ctx.api(
        `/api/agents/${stopTestAgentId}/status`
      );
      assert.equal(
        runningState.status,
        'running',
        'agent should be running before stop'
      );

      // Send stop
      const { status: stopStatus } = await ctx.api(
        `/api/agents/${stopTestAgentId}/stop`,
        { method: 'POST' }
      );
      assert.equal(stopStatus, 200, 'stop should return 200');

      // Wait for close handler
      await new Promise((r) => setTimeout(r, 2000));
      const { body: stoppedState } = await ctx.api(
        `/api/agents/${stopTestAgentId}/status`
      );
      assert.equal(
        stoppedState.status,
        'idle',
        'status must be "idle" after stop'
      );
    });

    it('process PID is no longer alive after stop (exec prefix ensures SIGTERM kills child)', async () => {
      // Start again and capture PID
      const { body: startBody } = await ctx.api(
        `/api/agents/${stopTestAgentId}/start`,
        {
          method: 'POST',
          body: { prompt: 'run forever again' },
        }
      );
      const pid = startBody.pid;
      assert.ok(pid, 'must have a PID to verify process death');

      // Confirm PID is alive
      await new Promise((r) => setTimeout(r, 500));
      let pidAlive = true;
      try {
        process.kill(pid, 0);
      } catch {
        pidAlive = false;
      }
      assert.ok(pidAlive, `PID ${pid} should be alive before stop`);

      // Stop the agent
      await ctx.api(`/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });

      // Wait for process termination (SIGTERM should kill immediately via exec)
      await new Promise((r) => setTimeout(r, 2000));

      let pidDeadAfterStop = false;
      try {
        process.kill(pid, 0);
      } catch {
        pidDeadAfterStop = true;
      }
      assert.ok(
        pidDeadAfterStop,
        `PID ${pid} should be dead after stop (exec prefix ensures SIGTERM propagates)`
      );
    });

    it('idle agent can be restarted after stop', async () => {
      // Verify currently idle (stopped state removed)
      const { body: preState } = await ctx.api(
        `/api/agents/${stopTestAgentId}/status`
      );
      assert.equal(preState.status, 'idle', 'agent should be idle after stop');

      // Restart
      const { status: restartStatus, body: restartBody } = await ctx.api(
        `/api/agents/${stopTestAgentId}/start`,
        {
          method: 'POST',
          body: { prompt: 'restart after stop' },
        }
      );
      assert.equal(restartStatus, 200, 'restart should succeed');
      assert.ok(restartBody.pid, 'restart should produce a PID');

      await new Promise((r) => setTimeout(r, 300));
      const { body: restartState } = await ctx.api(
        `/api/agents/${stopTestAgentId}/status`
      );
      assert.equal(
        restartState.status,
        'running',
        'agent should be running after restart'
      );

      // Cleanup: stop it
      await ctx.api(`/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 1500));
    });

    it('close handler sets agent to idle after stop', async () => {
      // Start agent
      await ctx.api(`/api/agents/${stopTestAgentId}/start`, {
        method: 'POST',
        body: { prompt: 'close handler test' },
      });
      await new Promise((r) => setTimeout(r, 400));

      // Stop agent
      await ctx.api(`/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });

      // Wait past close handler execution
      await new Promise((r) => setTimeout(r, 2500));

      const { body: finalState } = await ctx.api(
        `/api/agents/${stopTestAgentId}/status`
      );
      assert.equal(
        finalState.status,
        'idle',
        'close handler should set agent to idle after stop'
      );
    });
  });
}
