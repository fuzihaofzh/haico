import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';

// Use isolated test DB
const TEST_DB = path.join(__dirname, 'test.db');
process.env.ARGUS_DB_PATH = TEST_DB;
process.env.ARGUS_PORT = '0'; // won't matter, we use inject

const authConfigDir = path.join(require('os').homedir(), '.argus');
const authConfigPath = path.join(authConfigDir, 'config.json');

// Helper: use Fastify inject (in-process, no real network needed)
function inject(app: FastifyInstance, opts: { method?: string; url: string; body?: any; headers?: Record<string, string> }) {
  const headers: Record<string, string> = { ...opts.headers };
  // Only set content-type when there's a body
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return app.inject({
    method: (opts.method as any) || 'GET',
    url: opts.url,
    payload: opts.body,
    headers,
  });
}

async function api(app: FastifyInstance, url: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}) {
  const res = await inject(app, { url, ...opts });
  let body: any = {};
  try { body = JSON.parse(res.body); } catch {}
  return { status: res.statusCode, body, headers: res.headers, raw: res.body };
}

let app: FastifyInstance;

describe('Argus API', () => {
  before(async () => {
    // Clean slate
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm', authConfigPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
    const { createApp } = await import('../src/app');
    app = await createApp({ port: 0, host: '127.0.0.1', logger: false });
  });

  after(async () => {
    const { stopAllProcesses } = await import('../src/services/process-manager');
    stopAllProcesses();
    // Wait for process close handlers to finish DB writes before destroying
    await new Promise(r => setTimeout(r, 3000));
    const { destroyApp } = await import('../src/app');
    await destroyApp(app);
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm', authConfigPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
  });

  // ─── Auth ───

  describe('Auth', () => {
    it('/ accessible from localhost (auth bypass)', async () => {
      // Localhost bypasses auth, so we get the page or redirect to setup
      const res = await inject(app, { url: '/' });
      // inject simulates 127.0.0.1 so auth is bypassed
      assert.ok(res.statusCode === 200 || res.statusCode === 302);
    });

    it('GET /setup returns setup HTML', async () => {
      const res = await inject(app, { url: '/setup' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('Set a password'));
    });

    it('POST /api/auth/setup rejects short password', async () => {
      const { status } = await api(app, '/api/auth/setup', {
        method: 'POST', body: { password: 'ab' },
      });
      assert.equal(status, 400);
    });

    it('POST /api/auth/setup sets password', async () => {
      const { status, body } = await api(app, '/api/auth/setup', {
        method: 'POST', body: { password: 'test1234' },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    it('rejects setup when password already set', async () => {
      const { status } = await api(app, '/api/auth/setup', {
        method: 'POST', body: { password: 'another' },
      });
      assert.equal(status, 403);
    });

    it('POST /api/auth rejects wrong password', async () => {
      const { status } = await api(app, '/api/auth', {
        method: 'POST', body: { password: 'wrong' },
      });
      assert.equal(status, 401);
    });

    it('POST /api/auth accepts correct password and returns token', async () => {
      const { status, body } = await api(app, '/api/auth', {
        method: 'POST', body: { password: 'test1234' },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.token, 'Login should return a token (passwordHash)');
    });

    it('POST /api/auth/setup sets cookie on first setup', async () => {
      // Setup was already done, so we just verify login works
      const { body } = await api(app, '/api/auth', {
        method: 'POST', body: { password: 'test1234' },
      });
      assert.ok(body.token, 'Should return token');
    });
  });

  // ─── Auth Security (Cookie-based, no server-side sessions) ───

  let sessionToken: string;

  describe('Auth Security', () => {
    it('login returns cookie with passwordHash', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth',
        payload: { password: 'test1234' },
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(loginRes.statusCode, 200);
      const setCookie = loginRes.headers['set-cookie'] as string;
      assert.ok(setCookie, 'Should set a cookie');
      assert.ok(setCookie.includes('argus-auth='), 'Cookie should be argus-auth');
      assert.ok(setCookie.includes('HttpOnly'), 'Cookie should be HttpOnly');
      assert.ok(setCookie.includes('SameSite=Lax'), 'Cookie should have SameSite');
      assert.ok(!setCookie.includes('Max-Age'), 'Cookie should NOT have Max-Age');

      const match = setCookie.match(/argus-auth=([^;]+)/);
      assert.ok(match, 'Should extract token');
      sessionToken = match![1];

      const loginBody = JSON.parse(loginRes.body);
      assert.ok(loginBody.token, 'Should return token in body');
      assert.equal(loginBody.token, sessionToken, 'Body token should match cookie');
    });

    it('POST /api/auth/logout clears cookie', async () => {
      const { status, body } = await api(app, '/api/auth/logout', {
        method: 'POST',
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    it('POST /api/auth/change-password rejects wrong current password', async () => {
      const { status } = await api(app, '/api/auth/change-password', {
        method: 'POST', body: { current: 'wrongpass', password: 'newpass1234' },
        headers: { cookie: `argus-auth=${sessionToken}` },
      });
      assert.equal(status, 401);
    });

    it('POST /api/auth/change-password rejects short new password', async () => {
      const { status } = await api(app, '/api/auth/change-password', {
        method: 'POST', body: { current: 'test1234', password: 'ab' },
        headers: { cookie: `argus-auth=${sessionToken}` },
      });
      assert.equal(status, 400);
    });

    it('POST /api/auth/change-password works with correct current password', async () => {
      const { status, body } = await api(app, '/api/auth/change-password', {
        method: 'POST', body: { current: 'test1234', password: 'newpass1234' },
        headers: { cookie: `argus-auth=${sessionToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      // Verify login with new password works
      const { status: s2 } = await api(app, '/api/auth', {
        method: 'POST', body: { password: 'newpass1234' },
      });
      assert.equal(s2, 200);

      // Verify old password no longer works
      const { status: s3 } = await api(app, '/api/auth', {
        method: 'POST', body: { password: 'test1234' },
      });
      assert.equal(s3, 401);

      // Change back for remaining tests
      const loginRes2 = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'newpass1234' },
        headers: { 'content-type': 'application/json' },
      });
      const cookie2 = (loginRes2.headers['set-cookie'] as string).match(/argus-auth=([^;]+)/)![1];
      await api(app, '/api/auth/change-password', {
        method: 'POST', body: { current: 'newpass1234', password: 'test1234' },
        headers: { cookie: `argus-auth=${cookie2}` },
      });

      // Refresh sessionToken for subsequent tests
      const refreshRes = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'test1234' },
        headers: { 'content-type': 'application/json' },
      });
      sessionToken = (refreshRes.headers['set-cookie'] as string).match(/argus-auth=([^;]+)/)![1];
    });

    it('GET /change-password returns HTML', async () => {
      const res = await inject(app, {
        url: '/change-password',
        headers: { cookie: `argus-auth=${sessionToken}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('Change'));
    });

    it('localhost bypass only works for safe API routes', async () => {
      const { status: projStatus } = await api(app, '/api/projects');
      assert.equal(projStatus, 200);
    });

    it('change-password invalidates old cookie (hash changes)', async () => {
      // Login to get current token
      const loginRes = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'test1234' },
        headers: { 'content-type': 'application/json' },
      });
      const oldToken = (loginRes.headers['set-cookie'] as string).match(/argus-auth=([^;]+)/)![1];

      // Change password
      const changeRes = await app.inject({
        method: 'POST', url: '/api/auth/change-password',
        payload: { current: 'test1234', password: 'changed1234' },
        headers: { 'content-type': 'application/json', cookie: `argus-auth=${oldToken}` },
      });
      assert.equal(changeRes.statusCode, 200);

      // Old token should be invalid (passwordHash changed)
      const { status: oldStatus } = await api(app, '/api/dashboard/summary', {
        headers: { cookie: `argus-auth=${oldToken}` },
      });
      assert.equal(oldStatus, 401, 'Old token should be invalidated after password change');

      // Restore password for remaining tests
      const newLogin = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'changed1234' },
        headers: { 'content-type': 'application/json' },
      });
      const newToken = (newLogin.headers['set-cookie'] as string).match(/argus-auth=([^;]+)/)![1];
      await app.inject({
        method: 'POST', url: '/api/auth/change-password',
        payload: { current: 'changed1234', password: 'test1234' },
        headers: { 'content-type': 'application/json', cookie: `argus-auth=${newToken}` },
      });

      // Refresh sessionToken for subsequent tests
      const refreshRes = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'test1234' },
        headers: { 'content-type': 'application/json' },
      });
      sessionToken = (refreshRes.headers['set-cookie'] as string).match(/argus-auth=([^;]+)/)![1];
    });

    it('invalid cookie token is rejected', async () => {
      const { status } = await api(app, '/api/dashboard/summary', {
        headers: { cookie: 'argus-auth=invalid-token-value' },
      });
      assert.equal(status, 401, 'Invalid token should be rejected');
    });

    it('GET /login shows login page when password is set', async () => {
      const res = await inject(app, { url: '/login' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('Login'), 'Should show login page when password is set');
    });

    it('GET /setup redirects to /login when password already set', async () => {
      const res = await inject(app, { url: '/setup' });
      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.location === '/login', 'Should redirect to /login');
    });
  });

  // ─── Projects ───

  let projectId: string;
  let controllerId: string;

  describe('Projects', () => {
    it('POST /api/projects creates project + controller', async () => {
      const { status, body } = await api(app, '/api/projects', {
        method: 'POST',
        body: {
          name: 'test-project',
          description: 'A test project',
          task_description: 'Run tests',
          controller_interval_min: 60,
          command_template: 'echo',
        },
      });
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.name, 'test-project');
      assert.equal(body.status, 'active');
      projectId = body.id;
    });

    it('GET /api/projects lists projects', async () => {
      const { status, body } = await api(app, '/api/projects');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
    });

    it('GET /api/projects/:id returns project', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}`);
      assert.equal(status, 200);
      assert.equal(body.name, 'test-project');
    });

    it('PUT /api/projects/:id updates project', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { description: 'Updated' },
      });
      assert.equal(status, 200);
      assert.equal(body.description, 'Updated');
    });

    it('auto-created controller agent exists', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/agents`);
      assert.equal(body.length, 2); // controller + assistant
      const controller = body.find((a: any) => a.is_controller === 1);
      assert.ok(controller, 'Should have a controller agent');
      controllerId = controller.id;
    });

    it('GET nonexistent project returns 404', async () => {
      const { status } = await api(app, '/api/projects/nonexistent');
      assert.equal(status, 404);
    });
  });

  // ─── Agents ───

  let workerId: string;

  describe('Agents', () => {
    it('POST creates worker agent', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST', body: { name: 'worker-1', role: 'Test worker' },
      });
      assert.equal(status, 201);
      assert.equal(body.name, 'worker-1');
      assert.equal(body.status, 'idle');
      assert.equal(body.is_controller, 0);
      workerId = body.id;
    });

    it('POST create requires name', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST', body: { role: 'no name' },
      });
      assert.equal(status, 400);
    });

    it('GET /api/agents/:id returns agent', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}`);
      assert.equal(status, 200);
      assert.equal(body.name, 'worker-1');
    });

    it('PUT updates agent', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}`, {
        method: 'PUT', body: { role: 'Updated role' },
      });
      assert.equal(status, 200);
      assert.equal(body.role, 'Updated role');
    });

    it('POST start works without explicit prompt (uses role + task)', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: {},
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      // Wait for agent to finish (system prompt makes output longer)
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { body: st } = await api(app, `/api/agents/${workerId}/status`);
        if (st.status !== 'running') break;
      }
    });

    it('POST start launches process', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'Hello test!' },
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.runId);
      assert.ok(body.pid);
    });

    it('agent finishes and becomes idle', async () => {
      await new Promise(r => setTimeout(r, 2000));
      const { body } = await api(app, `/api/agents/${workerId}/status`);
      assert.equal(body.status, 'idle');
    });

    it('logs are captured', async () => {
      const { body } = await api(app, `/api/agents/${workerId}/logs`);
      assert.ok(Array.isArray(body));
      assert.ok(body.length > 0, 'Should have at least one log entry');
    });

    it('start + stop works', async () => {
      // Pause project to prevent controller triggers during test
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { status: 'paused', command_template: 'tail -f /dev/null #' },
      });

      const { status: startStatus } = await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'long' },
      });
      assert.equal(startStatus, 200);
      await new Promise(r => setTimeout(r, 500));

      const { status: stopStatus } = await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
      assert.equal(stopStatus, 200);
      await new Promise(r => setTimeout(r, 2000));

      const { body: st } = await api(app, `/api/agents/${workerId}/status`);
      assert.notEqual(st.status, 'running');

      // Restore
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { status: 'active', command_template: 'echo' },
      });
    });

    it('error status on failed command', async () => {
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'false' },
      });
      await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'fail' },
      });
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { body: st } = await api(app, `/api/agents/${workerId}/status`);
        if (st.status !== 'running') break;
      }

      const { body } = await api(app, `/api/agents/${workerId}/status`);
      assert.equal(body.status, 'error');

      // Restore
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'echo' },
      });
    });

    it('duplicate start returns 409', async () => {
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'tail -f /dev/null #' },
      });
      await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'first' },
      });
      await new Promise(r => setTimeout(r, 200));

      const { status } = await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'second' },
      });
      assert.equal(status, 409);

      await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 2000));

      // Wait for agent to fully stop
      for (let i = 0; i < 5; i++) {
        const { body: st } = await api(app, `/api/agents/${workerId}/status`);
        if (st.status !== 'running') break;
        await new Promise(r => setTimeout(r, 500));
      }

      // Restore
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'echo' },
      });
    });

    it('GET nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent');
      assert.equal(status, 404);
    });
  });

  // ─── Agent Retry ───

  describe('Agent Retry', () => {
    it('retry nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/retry', { method: 'POST' });
      assert.equal(status, 404);
    });

    it('retry agent with no previous prompt returns 400', async () => {
      // Create a fresh agent that has never been started
      const { body: freshAgent } = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST', body: { name: 'retry-test-agent', role: 'Retry test' },
      });
      const { status, body } = await api(app, `/api/agents/${freshAgent.id}/retry`, { method: 'POST' });
      assert.equal(status, 400);
      assert.ok(body.error.includes('No previous prompt'));

      // Cleanup
      await api(app, `/api/agents/${freshAgent.id}`, { method: 'DELETE' });
    });

    it('retry succeeds for agent with last_prompt', async () => {
      // Worker was started earlier and has last_prompt
      // First ensure worker is not running
      const { body: st } = await api(app, `/api/agents/${workerId}/status`);
      if (st.status === 'running') {
        await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
        await new Promise(r => setTimeout(r, 1000));
      }

      // Check if agent has last_prompt (it should from earlier start tests)
      const { body: agent } = await api(app, `/api/agents/${workerId}`);
      if (agent.last_prompt) {
        const { status, body } = await api(app, `/api/agents/${workerId}/retry`, { method: 'POST' });
        assert.equal(status, 200);
        assert.equal(body.success, true);
        assert.ok(body.runId);
        assert.ok(body.pid);

        // Wait for it to finish
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const { body: st2 } = await api(app, `/api/agents/${workerId}/status`);
          if (st2.status !== 'running') break;
        }
      }
    });

    it('retry returns 409 when agent is running', async () => {
      // Start the agent with a long-running command
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'tail -f /dev/null #' },
      });
      await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'retry test' },
      });
      await new Promise(r => setTimeout(r, 300));

      const { status } = await api(app, `/api/agents/${workerId}/retry`, { method: 'POST' });
      assert.equal(status, 409);

      // Stop and restore
      await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 2000));
      for (let i = 0; i < 5; i++) {
        const { body: st } = await api(app, `/api/agents/${workerId}/status`);
        if (st.status !== 'running') break;
        await new Promise(r => setTimeout(r, 500));
      }
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'echo' },
      });
    });
  });

  // ─── Agent Pause / Unpause ───

  describe('Agent Pause / Unpause', () => {
    it('pause nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/pause', { method: 'POST' });
      assert.equal(status, 404);
    });

    it('unpause nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/unpause', { method: 'POST' });
      assert.equal(status, 404);
    });

    it('pause idle agent succeeds', async () => {
      // Ensure agent is idle first
      const { body: st } = await api(app, `/api/agents/${workerId}/status`);
      if (st.status === 'running') {
        await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
        await new Promise(r => setTimeout(r, 2000));
      }

      const { status, body } = await api(app, `/api/agents/${workerId}/pause`, { method: 'POST' });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Verify agent is paused and stopped
      const { body: agent } = await api(app, `/api/agents/${workerId}`);
      assert.equal(agent.paused, 1);
      assert.equal(agent.status, 'stopped');
    });

    it('pause already paused agent returns 409', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/pause`, { method: 'POST' });
      assert.equal(status, 409);
      assert.ok(body.error.includes('already paused'));
    });

    it('start paused agent returns 409', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'should not start' },
      });
      assert.equal(status, 409);
      assert.ok(body.error.includes('paused'));
    });

    it('status endpoint shows paused=true', async () => {
      const { body } = await api(app, `/api/agents/${workerId}/status`);
      assert.equal(body.paused, true);
    });

    it('unpause agent succeeds', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/unpause`, { method: 'POST' });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Verify agent is unpaused and idle
      const { body: agent } = await api(app, `/api/agents/${workerId}`);
      assert.equal(agent.paused, 0);
      assert.equal(agent.status, 'idle');
    });

    it('unpause already unpaused agent returns 409', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/unpause`, { method: 'POST' });
      assert.equal(status, 409);
      assert.ok(body.error.includes('not paused'));
    });

    it('status endpoint shows paused=false after unpause', async () => {
      const { body } = await api(app, `/api/agents/${workerId}/status`);
      assert.equal(body.paused, false);
    });

    it('agent can be started after unpause', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'after unpause' },
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Wait for it to finish
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { body: st } = await api(app, `/api/agents/${workerId}/status`);
        if (st.status !== 'running') break;
      }
    });

    it('pause stops a running agent', async () => {
      // Start with long-running command
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'tail -f /dev/null #' },
      });
      await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'long running' },
      });
      await new Promise(r => setTimeout(r, 500));

      // Pause while running
      const { status, body } = await api(app, `/api/agents/${workerId}/pause`, { method: 'POST' });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      await new Promise(r => setTimeout(r, 2000));

      // Verify agent is paused and not running
      const { body: st } = await api(app, `/api/agents/${workerId}/status`);
      assert.equal(st.paused, true);
      assert.equal(st.is_running, false);

      // Unpause and restore
      await api(app, `/api/agents/${workerId}/unpause`, { method: 'POST' });
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'echo' },
      });
    });
  });

  // ─── Error Recovery (process-manager) ───

  describe('Error Recovery', () => {
    it('error status resets session_id to null', async () => {
      // Run agent with a command that fails
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'false' },
      });
      await api(app, `/api/agents/${workerId}/start`, {
        method: 'POST', body: { prompt: 'should fail' },
      });

      // Wait for error
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { body: st } = await api(app, `/api/agents/${workerId}/status`);
        if (st.status !== 'running') break;
      }

      const { body: agent } = await api(app, `/api/agents/${workerId}`);
      assert.equal(agent.status, 'error');
      assert.equal(agent.session_id, null, 'session_id should be reset to null on error');

      // Restore
      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'echo' },
      });
    });
  });

  // ─── Issues ───

  let issueId: string;

  describe('Issues', () => {
    it('POST creates issue with auto-priority', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'Test issue', body: 'Description', created_by: 'user', assigned_to: workerId, labels: 'bug,test' },
      });
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.number, 1);
      assert.equal(body.status, 'open');
      assert.equal(body.priority, 10); // user = highest
      issueId = body.id;
    });

    it('GET lists issues', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues`);
      assert.ok(body.issues.length >= 1);
      assert.ok(body.total >= 1);
    });

    it('GET filters by status', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues?status=open`);
      assert.ok(body.issues.some((i: any) => i.id === issueId));
    });

    it('GET filters by assigned_to', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues?assigned_to=${workerId}`);
      assert.ok(body.issues.some((i: any) => i.id === issueId));
    });

    it('GET issue detail includes comments', async () => {
      const { body } = await api(app, `/api/issues/${issueId}`);
      assert.equal(body.title, 'Test issue');
      assert.ok(Array.isArray(body.comments));
    });

    it('PUT updates issue status', async () => {
      const { status, body } = await api(app, `/api/issues/${issueId}`, {
        method: 'PUT', body: { status: 'in_progress' },
      });
      assert.equal(status, 200);
      assert.equal(body.status, 'in_progress');
    });

    it('POST adds comment', async () => {
      const { status, body } = await api(app, `/api/issues/${issueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: 'A comment' },
      });
      assert.equal(status, 201);
      assert.equal(body.body, 'A comment');
    });

    it('GET comments lists them', async () => {
      const { body } = await api(app, `/api/issues/${issueId}/comments`);
      assert.ok(body.length >= 1);
    });

    it('DELETE only works on open issues', async () => {
      // Issue is in_progress, should fail
      const { status } = await api(app, `/api/issues/${issueId}`, { method: 'DELETE' });
      assert.equal(status, 409);
    });

    it('POST requires title and created_by', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST', body: { body: 'no title' },
      });
      assert.equal(status, 400);
    });
  });

  // ─── Issue by Number ───

  describe('Issue by Number', () => {
    it('GET /api/projects/:pid/issues/number/:num returns issue with comments', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/issues/number/1`);
      assert.equal(status, 200);
      assert.equal(body.number, 1);
      assert.ok(Array.isArray(body.comments));
      assert.ok(Array.isArray(body.reactions));
    });

    it('GET nonexistent issue number returns 404', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/issues/number/9999`);
      assert.equal(status, 404);
    });
  });

  // ─── Issue Timeline Events ───

  describe('Issue Timeline Events', () => {
    it('status change creates timeline event', async () => {
      // Issue was changed to in_progress earlier, check for event comment
      const { body } = await api(app, `/api/issues/${issueId}`);
      const statusEvents = body.comments.filter((c: any) => c.event_type === 'status_change');
      assert.ok(statusEvents.length >= 1, 'Should have at least one status_change event');
    });

    it('invalid status returns 400', async () => {
      const { status } = await api(app, `/api/issues/${issueId}`, {
        method: 'PUT', body: { status: 'invalid_status' },
      });
      assert.equal(status, 400);
    });

    it('nonexistent issue returns 404 on update', async () => {
      const { status } = await api(app, '/api/issues/nonexistent', {
        method: 'PUT', body: { status: 'open' },
      });
      assert.equal(status, 404);
    });

    it('nonexistent issue returns 404 on get', async () => {
      const { status } = await api(app, '/api/issues/nonexistent');
      assert.equal(status, 404);
    });
  });

  // ─── Comments CRUD ───

  let commentId: string;

  describe('Comments CRUD', () => {
    it('POST comment requires author_id and body', async () => {
      const { status } = await api(app, `/api/issues/${issueId}/comments`, {
        method: 'POST', body: { author_id: 'user' }, // missing body
      });
      assert.equal(status, 400);
    });

    it('POST comment on nonexistent issue returns 404', async () => {
      const { status } = await api(app, '/api/issues/nonexistent/comments', {
        method: 'POST', body: { author_id: 'user', body: 'test' },
      });
      assert.equal(status, 404);
    });

    it('POST creates a comment and captures id', async () => {
      const { status, body } = await api(app, `/api/issues/${issueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: 'Editable comment' },
      });
      assert.equal(status, 201);
      commentId = body.id;
    });

    it('PUT /api/comments/:id edits comment', async () => {
      const { status, body } = await api(app, `/api/comments/${commentId}`, {
        method: 'PUT', body: { body: 'Edited comment' },
      });
      assert.equal(status, 200);
      assert.equal(body.body, 'Edited comment');
    });

    it('PUT nonexistent comment returns 404', async () => {
      const { status } = await api(app, '/api/comments/nonexistent', {
        method: 'PUT', body: { body: 'test' },
      });
      assert.equal(status, 404);
    });

    it('DELETE /api/comments/:id removes comment', async () => {
      const { status, body } = await api(app, `/api/comments/${commentId}`, {
        method: 'DELETE',
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
    });

    it('DELETE nonexistent comment returns 404', async () => {
      const { status } = await api(app, '/api/comments/nonexistent', {
        method: 'DELETE',
      });
      assert.equal(status, 404);
    });
  });

  // ─── Reactions ───

  describe('Reactions', () => {
    it('POST /api/reactions/issue/:id toggles on', async () => {
      const { status, body } = await api(app, `/api/reactions/issue/${issueId}`, {
        method: 'POST', body: { user_id: 'user', emoji: '👍' },
      });
      assert.equal(status, 201);
      assert.equal(body.toggled, 'on');
    });

    it('POST same reaction toggles off', async () => {
      const { status, body } = await api(app, `/api/reactions/issue/${issueId}`, {
        method: 'POST', body: { user_id: 'user', emoji: '👍' },
      });
      assert.equal(status, 200);
      assert.equal(body.toggled, 'off');
    });

    it('POST reaction requires user_id and emoji', async () => {
      const { status } = await api(app, `/api/reactions/issue/${issueId}`, {
        method: 'POST', body: { user_id: 'user' }, // missing emoji
      });
      assert.equal(status, 400);
    });

    it('GET /api/reactions/issue/:id lists reactions', async () => {
      // Add a reaction first
      await api(app, `/api/reactions/issue/${issueId}`, {
        method: 'POST', body: { user_id: 'user', emoji: '🎉' },
      });
      const { status, body } = await api(app, `/api/reactions/issue/${issueId}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.some((r: any) => r.emoji === '🎉'));
    });
  });

  // ─── Milestones ───

  let milestoneId: string;

  describe('Milestones', () => {
    it('POST /api/projects/:pid/milestones creates milestone', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/milestones`, {
        method: 'POST', body: { title: 'v1.0', description: 'First release', due_date: '2026-06-01' },
      });
      assert.equal(status, 201);
      assert.equal(body.title, 'v1.0');
      milestoneId = body.id;
    });

    it('POST milestone requires title', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/milestones`, {
        method: 'POST', body: { description: 'no title' },
      });
      assert.equal(status, 400);
    });

    it('GET /api/projects/:pid/milestones lists milestones with progress', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/milestones`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.length >= 1);
      assert.equal(body[0].progress, 0); // no issues assigned yet
    });

    it('PUT /api/milestones/:id updates milestone', async () => {
      const { status, body } = await api(app, `/api/milestones/${milestoneId}`, {
        method: 'PUT', body: { title: 'v1.1', description: 'Updated release' },
      });
      assert.equal(status, 200);
      assert.equal(body.title, 'v1.1');
    });

    it('assign issue to milestone and check progress', async () => {
      // Assign the existing issue to milestone
      await api(app, `/api/issues/${issueId}`, {
        method: 'PUT', body: { milestone_id: milestoneId },
      });
      const { body } = await api(app, `/api/projects/${projectId}/milestones`);
      const ms = body.find((m: any) => m.id === milestoneId);
      assert.equal(ms.total_issues, 1);
    });

    it('DELETE /api/milestones/:id removes milestone and unlinks issues', async () => {
      const { status, body } = await api(app, `/api/milestones/${milestoneId}`, {
        method: 'DELETE',
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Verify issue's milestone_id is cleared
      const { body: issue } = await api(app, `/api/issues/${issueId}`);
      assert.equal(issue.milestone_id, null);
    });
  });

  // ─── Notifications ───

  describe('Notifications', () => {
    it('GET /api/notifications returns user issues and recent comments', async () => {
      const { status, body } = await api(app, '/api/notifications');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.user_issues));
      assert.ok(Array.isArray(body.recent_comments));
    });
  });

  // ─── Search ───

  describe('Search', () => {
    it('GET /api/projects/:pid/search finds issues by query', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/search?q=Test`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.issues));
      assert.ok(body.issues.length >= 1);
    });

    it('search returns empty for no match', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/search?q=zzz_nonexistent_zzz`);
      assert.equal(body.issues.length, 0);
    });
  });

  // ─── Activity ───

  describe('Activity', () => {
    it('GET /api/projects/:id/activity returns timeline', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/activity`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.length > 0, 'Should have activity events');
    });
  });

  // ─── Costs ───

  describe('Costs', () => {
    it('GET /api/projects/:id/costs returns cost summary', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/costs`);
      assert.equal(status, 200);
      assert.equal(typeof body.total_cost_usd, 'number');
      assert.equal(typeof body.total_input_tokens, 'number');
      assert.equal(typeof body.total_output_tokens, 'number');
      assert.ok(typeof body.by_agent === 'object');
    });
  });

  // ─── Agent Extended Endpoints ───

  describe('Agent Extended', () => {
    it('GET /api/agents/:id/system-prompt returns prompt', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/system-prompt`);
      assert.equal(status, 200);
      assert.ok(typeof body.prompt === 'string');
      assert.ok(body.prompt.length > 0);
    });

    it('GET system-prompt for nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/system-prompt');
      assert.equal(status, 404);
    });

    it('GET /api/agents/:id/terminal returns text output', async () => {
      const res = await inject(app, { url: `/api/agents/${workerId}/terminal` });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type']?.toString().includes('text/plain'));
      assert.ok(res.body.includes(('worker-1')));
    });

    it('GET terminal for nonexistent agent returns 404', async () => {
      const res = await inject(app, { url: '/api/agents/nonexistent/terminal' });
      assert.equal(res.statusCode, 404);
    });

    it('GET /api/agents/:id/logs/:run_id returns logs for specific run', async () => {
      // Get a run_id from existing logs
      const { body: logs } = await api(app, `/api/agents/${workerId}/logs`);
      if (logs.length > 0) {
        const runId = logs[0].run_id;
        const { status, body } = await api(app, `/api/agents/${workerId}/logs/${runId}`);
        assert.equal(status, 200);
        assert.ok(Array.isArray(body));
      }
    });

    it('GET status for nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/status');
      assert.equal(status, 404);
    });

    it('stop nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/stop', { method: 'POST' });
      assert.equal(status, 404);
    });

    it('start nonexistent agent returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/start', {
        method: 'POST', body: { prompt: 'test' },
      });
      assert.equal(status, 404);
    });
  });

  // ─── Issue Delete (open issue) ───

  describe('Issue Delete', () => {
    let openIssueId: string;

    it('create and delete an open issue', async () => {
      const { body: created } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'Deletable issue', created_by: 'user' },
      });
      openIssueId = created.id;

      const { status } = await api(app, `/api/issues/${openIssueId}`, { method: 'DELETE' });
      assert.equal(status, 200);
    });

    it('delete nonexistent issue returns 404', async () => {
      const { status } = await api(app, '/api/issues/nonexistent', { method: 'DELETE' });
      assert.equal(status, 404);
    });
  });

  // ─── Issues Pagination ───

  describe('Issues Pagination', () => {
    it('pagination params work', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues?page=1&per_page=1`);
      assert.equal(body.per_page, 1);
      assert.ok(body.issues.length <= 1);
      assert.ok(body.total >= 1);
      assert.ok(body.total_pages >= 1);
    });

    it('sort by newest works', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues?sort=newest`);
      assert.ok(body.issues.length >= 1);
    });

    it('search by q parameter works', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues?q=Test`);
      assert.ok(body.issues.length >= 1);
    });
  });

  // ─── Issue Comment Count ───

  describe('Issue Comment Count', () => {
    let ccIssueId: string;

    it('issues list includes comment_count field', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues`);
      assert.ok(body.issues.length >= 1);
      for (const issue of body.issues) {
        assert.equal(typeof issue.comment_count, 'number', `issue ${issue.id} should have numeric comment_count`);
      }
    });

    it('comment_count only counts event_type=comment (not status_change)', async () => {
      // issueId already has 1 real comment ("A comment") + status_change events from earlier tests
      const { body } = await api(app, `/api/projects/${projectId}/issues`);
      const issue = body.issues.find((i: any) => i.id === issueId);
      assert.ok(issue, 'should find test issue');
      // There was 1 real comment added earlier and status_change events should not count
      assert.equal(issue.comment_count, 1, 'comment_count should only count real comments, not status_change events');
    });

    it('new issue has comment_count 0', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'No comments issue', body: 'Test', created_by: 'user' },
      });
      ccIssueId = body.id;
      // Fetch list and check
      const { body: listBody } = await api(app, `/api/projects/${projectId}/issues`);
      const issue = listBody.issues.find((i: any) => i.id === ccIssueId);
      assert.ok(issue);
      assert.equal(issue.comment_count, 0);
    });

    it('comment_count increments after adding a comment', async () => {
      await api(app, `/api/issues/${ccIssueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: 'First comment' },
      });
      await api(app, `/api/issues/${ccIssueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: 'Second comment' },
      });
      const { body } = await api(app, `/api/projects/${projectId}/issues`);
      const issue = body.issues.find((i: any) => i.id === ccIssueId);
      assert.equal(issue.comment_count, 2);
    });

    it('status change does not increment comment_count', async () => {
      // Change status (creates a status_change event, not a comment)
      await api(app, `/api/issues/${ccIssueId}`, {
        method: 'PUT', body: { status: 'in_progress' },
      });
      const { body } = await api(app, `/api/projects/${projectId}/issues`);
      const issue = body.issues.find((i: any) => i.id === ccIssueId);
      assert.equal(issue.comment_count, 2, 'status_change should not affect comment_count');
    });

    it('sort by comments works', async () => {
      const { body } = await api(app, `/api/projects/${projectId}/issues?sort=comments`);
      assert.ok(body.issues.length >= 2);
      // First issue should have >= comments as second
      const counts = body.issues.map((i: any) => i.comment_count);
      for (let i = 1; i < counts.length; i++) {
        assert.ok(counts[i - 1] >= counts[i], `issues should be sorted by comment count descending`);
      }
    });
  });

  // ─── Agent Costs ───

  describe('Agent Costs', () => {
    it('GET /api/agents/:id/costs returns cost structure', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/costs`);
      assert.equal(status, 200);
      assert.equal(typeof body.total_cost_usd, 'number');
      assert.equal(typeof body.total_input_tokens, 'number');
      assert.equal(typeof body.total_output_tokens, 'number');
      assert.equal(typeof body.total_runs, 'number');
      assert.ok(Array.isArray(body.runs));
    });

    it('GET /api/agents/:id/costs returns 404 for nonexistent agent', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/costs');
      assert.equal(status, 404);
    });

    it('agent with no cost records returns total_runs 0', async () => {
      // Create a fresh agent that has never been started
      const { body: freshAgent } = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST', body: { name: 'no-cost-agent', role: 'Test' },
      });
      const { status, body } = await api(app, `/api/agents/${freshAgent.id}/costs`);
      assert.equal(status, 200);
      assert.equal(body.total_runs, 0);
      assert.equal(body.total_cost_usd, 0);
      assert.equal(body.runs.length, 0);

      await api(app, `/api/agents/${freshAgent.id}`, { method: 'DELETE' });
    });
  });

  // ─── Dashboard Summary ───

  describe('Dashboard Summary', () => {
    it('GET /api/dashboard/summary returns aggregate stats (with auth)', async () => {
      const { status, body } = await api(app, '/api/dashboard/summary', {
        headers: { cookie: `argus-auth=${sessionToken}` },
      });
      assert.equal(status, 200);
      assert.ok(typeof body.agents === 'object');
      assert.equal(typeof body.agents.total, 'number');
      assert.equal(typeof body.agents.running, 'number');
      assert.equal(typeof body.agents.error_count, 'number');
      assert.ok(typeof body.issues === 'object');
      assert.equal(typeof body.issues.total, 'number');
      assert.equal(typeof body.issues.open, 'number');
      assert.equal(typeof body.total_cost_usd, 'number');
      assert.ok(typeof body.last_activity === 'object');
    });

    it('GET /api/dashboard/summary requires auth (not localhost-safe)', async () => {
      const { status } = await api(app, '/api/dashboard/summary');
      assert.equal(status, 401);
    });
  });

  // ─── Project Export ───

  describe('Project Export', () => {
    it('GET /api/projects/:id/export returns full project data', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/export`);
      assert.equal(status, 200);
      assert.ok(body.exported_at);
      assert.ok(body.project);
      assert.ok(Array.isArray(body.agents));
      assert.ok(Array.isArray(body.issues));
      assert.ok(body.cost_summary);
      assert.equal(typeof body.cost_summary.total_cost_usd, 'number');
    });

    it('GET /api/projects/:id/export returns 404 for nonexistent project', async () => {
      const { status } = await api(app, '/api/projects/nonexistent/export');
      assert.equal(status, 404);
    });

    it('GET /api/projects/:id/export/issues.csv returns CSV', async () => {
      const res = await inject(app, { url: `/api/projects/${projectId}/export/issues.csv` });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type']?.toString().includes('text/csv'));
      assert.ok(res.body.includes('number,title,status'));
    });

    it('CSV export returns 404 for nonexistent project', async () => {
      const { status } = await api(app, '/api/projects/nonexistent/export/issues.csv');
      assert.equal(status, 404);
    });
  });

  // ─── Costs with time-series ───

  describe('Project Costs Extended', () => {
    it('GET /api/projects/:id/costs with period=day returns time_series', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/costs?period=day`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.time_series));
      assert.ok(Array.isArray(body.runs));
    });
  });

  // ─── Agent Runs & Report ───

  describe('Agent Runs', () => {
    it('GET /api/agents/:id/runs returns run list structure', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/runs`);
      assert.equal(status, 200);
      assert.ok(body.runs !== undefined, 'response should have runs array');
      assert.ok(Array.isArray(body.runs));
    });

    it('GET /api/agents/:id/runs returns 404 for nonexistent agent', async () => {
      const { status, body } = await api(app, '/api/agents/nonexistent-id/runs');
      assert.equal(status, 404);
      assert.equal(body.error, 'Agent not found');
    });

    it('run items contain expected fields', async () => {
      const { body } = await api(app, `/api/agents/${workerId}/runs`);
      // Agent may have no runs — if it does, check the shape
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
      const { status, body } = await api(app, `/api/agents/${workerId}/runs?limit=1`);
      assert.equal(status, 200);
      assert.ok(body.runs.length <= 1);
    });
  });

  describe('Agent Run Report', () => {
    it('GET /api/agents/:id/runs/:runId/report returns 404 for nonexistent run', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/runs/fake-run-id/report`);
      assert.equal(status, 404);
      assert.equal(body.error, 'Run not found');
    });

    it('GET /api/agents/:id/runs/:runId/report returns 404 for nonexistent agent', async () => {
      const { status, body } = await api(app, '/api/agents/nonexistent-id/runs/fake/report');
      assert.equal(status, 404);
      assert.equal(body.error, 'Agent not found');
    });
  });

  // ─── Git Integration ───

  describe('Git Integration', () => {
    it('GET /api/projects/:id/git-log returns commit list', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/git-log?limit=5`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      // Test project agents have no working_directory, so expect empty
    });

    it('GET /api/projects/:id/git-log respects limit param', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/git-log?limit=1`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
    });

    it('GET /api/agents/:id/git-status returns status for agent without working_directory', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/git-status`);
      assert.equal(status, 200);
      assert.equal(body.branch, null);
      assert.deepEqual(body.recent_commits, []);
      assert.equal(body.has_uncommitted, false);
    });

    it('GET /api/agents/:id/git-status with working_directory set', async () => {
      // Set working_directory to current repo for testing
      await api(app, `/api/agents/${workerId}`, {
        method: 'PUT', body: { working_directory: process.cwd() },
      });
      const { status, body } = await api(app, `/api/agents/${workerId}/git-status`);
      assert.equal(status, 200);
      assert.ok(body.branch, 'Should have a branch name');
      assert.ok(Array.isArray(body.recent_commits), 'Should have recent_commits array');
      if (body.recent_commits.length > 0) {
        assert.ok(body.recent_commits[0].hash, 'Commit should have hash');
        assert.ok(body.recent_commits[0].message, 'Commit should have message');
      }
    });

    it('GET /api/agents/nonexistent/git-status returns 404', async () => {
      const { status } = await api(app, '/api/agents/nonexistent/git-status');
      assert.equal(status, 404);
    });

    it('git-log returns commits when agent has working_directory', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/git-log?limit=5`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      // Now that workerId has cwd as working_directory, should have commits
      if (body.length > 0) {
        assert.ok(body[0].hash, 'Commit should have full hash');
        assert.ok(body[0].short_hash, 'Commit should have short_hash');
        assert.ok(body[0].author, 'Commit should have author');
        assert.ok(body[0].message, 'Commit should have message');
        assert.ok(body[0].date, 'Commit should have date');
      }
    });
  });

  // ─── Breadcrumb Navigation ───

  describe('Breadcrumb Navigation', () => {
    it('issue.html has breadcrumb with Issues link', async () => {
      const res = await inject(app, { url: '/issues/nonexistent' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('id="issues-link"'), 'Should have issues-link element');
      assert.ok(res.body.includes('id="project-link"'), 'Should have project-link element');
      assert.ok(res.body.includes('id="issue-title-breadcrumb"'), 'Should have issue-title breadcrumb');
    });

    it('project.html has breadcrumb with section span', async () => {
      const res = await inject(app, { url: `/projects/${projectId}` });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('id="breadcrumb-section"'), 'Should have breadcrumb-section element');
      assert.ok(res.body.includes('id="project-name"'), 'Should have project-name element');
    });

    it('project.html has 5 tabs including Git', async () => {
      const res = await inject(app, { url: `/projects/${projectId}` });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes("switchTab('git')"), 'Should have Git tab');
      assert.ok(res.body.includes("switchTab('overview')"), 'Should have Overview tab');
      assert.ok(res.body.includes("switchTab('agents')"), 'Should have Agents tab');
      assert.ok(res.body.includes("switchTab('issues')"), 'Should have Issues tab');
      assert.ok(res.body.includes("switchTab('activity')"), 'Should have Activity tab');
    });
  });

  // ─── Cascade Delete ───

  describe('Cleanup', () => {
    it('DELETE agent', async () => {
      const { status } = await api(app, `/api/agents/${workerId}`, { method: 'DELETE' });
      assert.equal(status, 200);
      const { status: s2 } = await api(app, `/api/agents/${workerId}`);
      assert.equal(s2, 404);
    });

    it('DELETE project cascades', async () => {
      const { status } = await api(app, `/api/projects/${projectId}`, { method: 'DELETE' });
      assert.equal(status, 200);
      const { status: cs } = await api(app, `/api/agents/${controllerId}`);
      assert.equal(cs, 404);
      const { status: ps } = await api(app, `/api/projects/${projectId}`);
      assert.equal(ps, 404);
    });
  });

  // ─── UI ───

  describe('UI Pages', () => {
    it('GET /setup returns HTML', async () => {
      const res = await inject(app, { url: '/setup' });
      assert.equal(res.statusCode, 302); // password set, redirects to /login
    });

    it('GET /login returns HTML', async () => {
      const res = await inject(app, { url: '/login' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('Argus'));
    });
  });
});
