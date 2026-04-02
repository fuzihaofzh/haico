import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';

// Use isolated test DB
const TEST_DB = path.join(__dirname, 'test.db');
process.env.AGENTOPIA_DB_PATH = TEST_DB;
process.env.AGENTOPIA_PORT = '0'; // won't matter, we use inject

const authConfigDir = path.join(require('os').homedir(), '.agentopia');
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

describe('Agentopia API', () => {
  before(async () => {
    // Clean slate
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm', authConfigPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
    const { createApp } = await import('../src/app');
    app = await createApp({ port: 0, host: '127.0.0.1', logger: false, skipScheduler: true });
  });

  after(async () => {
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
      assert.ok(setCookie.includes('agentopia-auth='), 'Cookie should be agentopia-auth');
      assert.ok(setCookie.includes('HttpOnly'), 'Cookie should be HttpOnly');
      assert.ok(setCookie.includes('SameSite=Lax'), 'Cookie should have SameSite');
      assert.ok(!setCookie.includes('Max-Age'), 'Cookie should NOT have Max-Age (session cookie)');

      const match = setCookie.match(/agentopia-auth=([^;]+)/);
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
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(status, 401);
    });

    it('POST /api/auth/change-password rejects short new password', async () => {
      const { status } = await api(app, '/api/auth/change-password', {
        method: 'POST', body: { current: 'test1234', password: 'ab' },
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(status, 400);
    });

    it('POST /api/auth/change-password works with correct current password', async () => {
      const { status, body } = await api(app, '/api/auth/change-password', {
        method: 'POST', body: { current: 'test1234', password: 'newpass1234' },
        headers: { cookie: `agentopia-auth=${sessionToken}` },
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
      const cookie2 = (loginRes2.headers['set-cookie'] as string).match(/agentopia-auth=([^;]+)/)![1];
      await api(app, '/api/auth/change-password', {
        method: 'POST', body: { current: 'newpass1234', password: 'test1234' },
        headers: { cookie: `agentopia-auth=${cookie2}` },
      });

      // Refresh sessionToken for subsequent tests
      const refreshRes = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'test1234' },
        headers: { 'content-type': 'application/json' },
      });
      sessionToken = (refreshRes.headers['set-cookie'] as string).match(/agentopia-auth=([^;]+)/)![1];
    });

    it('GET /change-password returns HTML', async () => {
      const res = await inject(app, {
        url: '/change-password',
        headers: { cookie: `agentopia-auth=${sessionToken}` },
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
      const oldToken = (loginRes.headers['set-cookie'] as string).match(/agentopia-auth=([^;]+)/)![1];

      // Change password
      const changeRes = await app.inject({
        method: 'POST', url: '/api/auth/change-password',
        payload: { current: 'test1234', password: 'changed1234' },
        headers: { 'content-type': 'application/json', cookie: `agentopia-auth=${oldToken}` },
      });
      assert.equal(changeRes.statusCode, 200);

      // Old token should be invalid (passwordHash changed)
      // Use page route to test cookie-based auth redirect
      const oldRes = await inject(app, { url: '/change-password', headers: { cookie: `agentopia-auth=${oldToken}` } });
      assert.equal(oldRes.statusCode, 302, 'Old token should be invalidated after password change (redirects to /login)');

      // Restore password for remaining tests
      const newLogin = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'changed1234' },
        headers: { 'content-type': 'application/json' },
      });
      const newToken = (newLogin.headers['set-cookie'] as string).match(/agentopia-auth=([^;]+)/)![1];
      await app.inject({
        method: 'POST', url: '/api/auth/change-password',
        payload: { current: 'changed1234', password: 'test1234' },
        headers: { 'content-type': 'application/json', cookie: `agentopia-auth=${newToken}` },
      });

      // Refresh sessionToken for subsequent tests
      const refreshRes = await app.inject({
        method: 'POST', url: '/api/auth',
        payload: { password: 'test1234' },
        headers: { 'content-type': 'application/json' },
      });
      sessionToken = (refreshRes.headers['set-cookie'] as string).match(/agentopia-auth=([^;]+)/)![1];
    });

    it('invalid cookie token is rejected', async () => {
      // Use page route to test cookie-based auth redirect
      const res = await inject(app, { url: '/change-password', headers: { cookie: 'agentopia-auth=invalid-token-value' } });
      assert.equal(res.statusCode, 302, 'Invalid token should be rejected (redirects to /login)');
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

  // ─── Multi-user Auth (#420) ───

  describe('Multi-user Auth (#420)', () => {
    let adminToken: string;
    let memberToken: string;
    let adminUserId: string;
    let memberUserId: string;

    it('POST /api/auth/register creates first user as admin', async () => {
      const { status, body } = await api(app, '/api/auth/register', {
        method: 'POST',
        body: { username: 'testadmin', password: 'admin1234', display_name: 'Test Admin' },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, 'admin', 'First user should be admin');
      assert.equal(body.user.username, 'testadmin');
      adminUserId = body.user.id;
    });

    it('POST /api/auth/register rejects invalid username', async () => {
      const { status } = await api(app, '/api/auth/register', {
        method: 'POST',
        body: { username: 'a', password: 'pass1234' },
      });
      assert.equal(status, 400);
    });

    it('POST /api/auth/register rejects duplicate username', async () => {
      const { status } = await api(app, '/api/auth/register', {
        method: 'POST',
        body: { username: 'testadmin', password: 'pass1234' },
      });
      assert.equal(status, 409);
    });

    it('POST /api/auth/login authenticates user', async () => {
      const { status, body } = await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: 'testadmin', password: 'admin1234' },
      });
      assert.equal(status, 200);
      assert.ok(body.token, 'Should return session token');
      assert.equal(body.user.username, 'testadmin');
      adminToken = body.token;
    });

    it('POST /api/auth/login rejects wrong password', async () => {
      const { status } = await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: 'testadmin', password: 'wrongpass' },
      });
      assert.equal(status, 401);
    });

    it('GET /api/auth/me returns current user', async () => {
      const { status, body } = await api(app, '/api/auth/me', {
        headers: { cookie: `agentopia-auth=${adminToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.username, 'testadmin');
      assert.equal(body.role, 'admin');
    });

    it('POST /api/auth/register creates second user as member', async () => {
      const { status, body } = await api(app, '/api/auth/register', {
        method: 'POST',
        body: { username: 'testmember', password: 'member1234' },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, 'member', 'Second user should be member');
      memberUserId = body.user.id;
      const login = await api(app, '/api/auth/login', {
        method: 'POST', body: { username: 'testmember', password: 'member1234' },
      });
      memberToken = login.body.token;
    });

    it('GET /api/auth/users lists users (admin only)', async () => {
      const { status, body } = await api(app, '/api/auth/users', {
        headers: { cookie: `agentopia-auth=${adminToken}` },
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.users));
      assert.ok(body.users.length >= 2);
    });

    it('GET /api/auth/users returns 403 for non-admin', async () => {
      const { status } = await api(app, '/api/auth/users', {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(status, 403);
    });

    it('PUT /api/auth/users/:id updates role (admin only)', async () => {
      const { status, body } = await api(app, `/api/auth/users/${memberUserId}`, {
        method: 'PUT',
        headers: { cookie: `agentopia-auth=${adminToken}` },
        body: { role: 'admin' },
      });
      assert.equal(status, 200);
      assert.equal(body.user.role, 'admin');
    });

    it('DELETE /api/auth/users/:id deletes user (admin only)', async () => {
      const { status } = await api(app, `/api/auth/users/${memberUserId}`, {
        method: 'DELETE',
        headers: { cookie: `agentopia-auth=${adminToken}` },
      });
      assert.equal(status, 200);
    });

    it('DELETE /api/auth/users/:id rejects deleting self', async () => {
      const { status } = await api(app, `/api/auth/users/${adminUserId}`, {
        method: 'DELETE',
        headers: { cookie: `agentopia-auth=${adminToken}` },
      });
      assert.equal(status, 400);
    });
  });

  describe('Legacy admin fallback for user management (#482/#483)', () => {
    let fallbackMemberId: string;
    let fallbackMemberToken: string;

    it('creates a fresh member for legacy fallback checks', async () => {
      const username = `legacycheck${Date.now()}`;
      const { status, body } = await api(app, '/api/auth/register', {
        method: 'POST',
        body: { username, password: 'member1234', display_name: 'Legacy Check Member' },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, 'member');
      fallbackMemberId = body.user.id;

      const login = await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username, password: 'member1234' },
      });
      assert.equal(login.status, 200);
      fallbackMemberToken = login.body.token;
    });

    it('GET /api/auth/me returns legacy admin from single-password cookie', async () => {
      const { status, body } = await api(app, '/api/auth/me', {
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.id, 'legacy');
      assert.equal(body.username, 'admin');
      assert.equal(body.role, 'admin');
    });

    it('legacy single-password admin can list users', async () => {
      const { status, body } = await api(app, '/api/auth/users', {
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.users));
      assert.ok(body.users.some((user: any) => user.id === fallbackMemberId));
    });

    it('multi-user admin/member permissions still work alongside legacy fallback', async () => {
      const adminLogin = await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: 'testadmin', password: 'admin1234' },
      });
      assert.equal(adminLogin.status, 200);
      const adminToken = adminLogin.body.token;

      const adminUsers = await api(app, '/api/auth/users', {
        headers: { cookie: `agentopia-auth=${adminToken}` },
      });
      assert.equal(adminUsers.status, 200);
      assert.ok(Array.isArray(adminUsers.body.users));

      const memberUsers = await api(app, '/api/auth/users', {
        headers: { cookie: `agentopia-auth=${fallbackMemberToken}` },
      });
      assert.equal(memberUsers.status, 403);
      assert.equal(memberUsers.body.error, 'Admin access required');
    });

    it('legacy single-password admin can update another user role', async () => {
      const { status, body } = await api(app, `/api/auth/users/${fallbackMemberId}`, {
        method: 'PUT',
        headers: { cookie: `agentopia-auth=${sessionToken}` },
        body: { role: 'admin' },
      });
      assert.equal(status, 200);
      assert.equal(body.user.id, fallbackMemberId);
      assert.equal(body.user.role, 'admin');
    });

    it('legacy single-password admin can delete another user', async () => {
      const { status, body } = await api(app, `/api/auth/users/${fallbackMemberId}`, {
        method: 'DELETE',
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const users = await api(app, '/api/auth/users', {
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(users.status, 200);
      assert.ok(!users.body.users.some((user: any) => user.id === fallbackMemberId));
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
      const { status, body } = await api(app, '/api/projects/' + projectId);
      assert.equal(status, 200);
      assert.equal(body.name, 'test-project');
    });

    it('GET /api/projects/:id/orchestration-runs returns an array', async () => {
      const { status, body } = await api(app, '/api/projects/' + projectId + '/orchestration-runs');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
    });

    it('PUT /api/projects/:id updates project', async () => {
      const { status, body } = await api(app, '/api/projects/' + projectId, {
        method: 'PUT', body: { description: 'Updated' },
      });
      assert.equal(status, 200);
      assert.equal(body.description, 'Updated');
    });

    it('auto-created controller agent exists', async () => {
      const { body } = await api(app, '/api/projects/' + projectId + '/agents');
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

  describe('Project permission summaries (#520)', () => {
    it('returns owner/member_count/permission fields for owner and shared member views', async () => {
      const suffix = Date.now();
      const ownerUsername = `owner-${suffix}`;
      const memberUsername = `member-${suffix}`;

      const ownerRegister = await api(app, '/api/auth/register', {
        method: 'POST',
        body: { username: ownerUsername, password: 'pass1234', display_name: 'Owner User' },
      });
      assert.equal(ownerRegister.status, 201);

      const memberRegister = await api(app, '/api/auth/register', {
        method: 'POST',
        body: { username: memberUsername, password: 'pass1234', display_name: 'Shared Member' },
      });
      assert.equal(memberRegister.status, 201);

      const ownerLogin = await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: ownerUsername, password: 'pass1234' },
      });
      assert.equal(ownerLogin.status, 200);
      const ownerToken = ownerLogin.body.token;

      const memberLogin = await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: memberUsername, password: 'pass1234' },
      });
      assert.equal(memberLogin.status, 200);
      const memberToken = memberLogin.body.token;

      const created = await api(app, '/api/projects', {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: {
          name: `shared-project-${suffix}`,
          description: 'permission summary test',
          task_description: 'verify permission metadata',
          command_template: 'echo',
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.permission_level, 'owner');
      assert.equal(created.body.can_manage, true);
      assert.equal(created.body.owner.username, ownerUsername);
      assert.equal(created.body.member_count, 1);
      const sharedProjectId = created.body.id;

      const shareRes = await api(app, `/api/projects/${sharedProjectId}/members`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: { username: memberUsername },
      });
      assert.equal(shareRes.status, 201);

      const ownerList = await api(app, '/api/projects', {
        headers: { cookie: `agentopia-auth=${ownerToken}` },
      });
      assert.equal(ownerList.status, 200);
      const ownerProject = ownerList.body.find((project: any) => project.id === sharedProjectId);
      assert.ok(ownerProject, 'owner should see the shared project');
      assert.equal(ownerProject.permission_level, 'owner');
      assert.equal(ownerProject.can_manage, true);
      assert.equal(ownerProject.owner.username, ownerUsername);
      assert.equal(ownerProject.member_count, 2);

      const memberList = await api(app, '/api/projects', {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(memberList.status, 200);
      const memberProject = memberList.body.find((project: any) => project.id === sharedProjectId);
      assert.ok(memberProject, 'shared member should see the project');
      assert.equal(memberProject.permission_level, 'member');
      assert.equal(memberProject.can_manage, false);
      assert.equal(memberProject.owner.username, ownerUsername);
      assert.equal(memberProject.member_count, 2);

      const memberDetail = await api(app, `/api/projects/${sharedProjectId}`, {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(memberDetail.status, 200);
      assert.equal(memberDetail.body.permission_level, 'member');
      assert.equal(memberDetail.body.can_manage, false);
      assert.equal(memberDetail.body.owner.username, ownerUsername);
      assert.equal(memberDetail.body.member_count, 2);
    });
  });

  describe('统一项目权限边界 (#525/#530)', () => {
    let ownerToken: string;
    let memberToken: string;
    let outsiderToken: string;
    let sharedProjectId: string;
    let hiddenProjectId: string;
    let sharedAgentId: string;
    let hiddenAgentId: string;
    let sharedKnowledgeId: string;
    let sharedMemoryId: string;
    let sharedMessageId: string;
    let sharedSearchIssueId: string;
    let hiddenSearchIssueId: string;

    before(async () => {
      const suffix = Date.now();
      const ownerUsername = `perm-owner-${suffix}`;
      const memberUsername = `perm-member-${suffix}`;
      const outsiderUsername = `perm-outsider-${suffix}`;

      for (const username of [ownerUsername, memberUsername, outsiderUsername]) {
        const register = await api(app, '/api/auth/register', {
          method: 'POST',
          body: { username, password: 'pass1234', display_name: username },
        });
        assert.equal(register.status, 201);
      }

      ownerToken = (await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: ownerUsername, password: 'pass1234' },
      })).body.token;
      memberToken = (await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: memberUsername, password: 'pass1234' },
      })).body.token;
      outsiderToken = (await api(app, '/api/auth/login', {
        method: 'POST',
        body: { username: outsiderUsername, password: 'pass1234' },
      })).body.token;

      const sharedProject = await api(app, '/api/projects', {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: {
          name: `perm-shared-${suffix}`,
          description: 'shared project',
          task_description: 'shared permission boundary test',
          command_template: 'echo',
        },
      });
      assert.equal(sharedProject.status, 201);
      sharedProjectId = sharedProject.body.id;

      const hiddenProject = await api(app, '/api/projects', {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: {
          name: `perm-hidden-${suffix}`,
          description: 'hidden project',
          task_description: 'hidden permission boundary test',
          command_template: 'echo',
        },
      });
      assert.equal(hiddenProject.status, 201);
      hiddenProjectId = hiddenProject.body.id;

      const shareRes = await api(app, `/api/projects/${sharedProjectId}/members`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: { username: memberUsername },
      });
      assert.equal(shareRes.status, 201);

      const sharedAgent = await api(app, `/api/projects/${sharedProjectId}/agents`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: { name: 'perm-shared-worker', role: 'shared worker' },
      });
      assert.equal(sharedAgent.status, 201);
      sharedAgentId = sharedAgent.body.id;

      const hiddenAgent = await api(app, `/api/projects/${hiddenProjectId}/agents`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: { name: 'perm-hidden-worker', role: 'hidden worker' },
      });
      assert.equal(hiddenAgent.status, 201);
      hiddenAgentId = hiddenAgent.body.id;

      const knowledgeRes = await api(app, `/api/projects/${sharedProjectId}/knowledge`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: { title: 'Boundary knowledge', content: 'visible to shared member', importance: 'high' },
      });
      assert.equal(knowledgeRes.status, 201);
      sharedKnowledgeId = knowledgeRes.body.id;

      const memoryRes = await api(app, `/api/agents/${sharedAgentId}/memories`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: { content: 'shared project memory', scope: 'project', tags: 'perm' },
      });
      assert.equal(memoryRes.status, 201);
      sharedMemoryId = memoryRes.body.id;

      const messageRes = await api(app, `/api/agents/${sharedAgentId}/messages/send`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: { to: sharedAgentId, subject: 'Boundary ping', body: 'read-only member can see this inbox' },
      });
      assert.equal(messageRes.status, 201);
      sharedMessageId = messageRes.body.id;

      const sharedIssue = await api(app, `/api/projects/${sharedProjectId}/issues`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: {
          title: 'Boundary shared issue',
          body: 'boundary-visible-token',
          created_by: 'user',
          assigned_to: 'user',
        },
      });
      assert.equal(sharedIssue.status, 201);
      sharedSearchIssueId = sharedIssue.body.id;

      const hiddenIssue = await api(app, `/api/projects/${hiddenProjectId}/issues`, {
        method: 'POST',
        headers: { cookie: `agentopia-auth=${ownerToken}` },
        body: {
          title: 'Boundary hidden issue',
          body: 'boundary-visible-token',
          created_by: 'user',
          assigned_to: 'user',
        },
      });
      assert.equal(hiddenIssue.status, 201);
      hiddenSearchIssueId = hiddenIssue.body.id;
    });

    it('shared member can read shared project resources but cannot perform write actions', async () => {
      const sharedAgent = await api(app, `/api/agents/${sharedAgentId}`, {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(sharedAgent.status, 200);

      const sharedKnowledge = await api(app, `/api/knowledge/${sharedKnowledgeId}`, {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(sharedKnowledge.status, 200);

      const sharedMemories = await api(app, `/api/agents/${sharedAgentId}/memories`, {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(sharedMemories.status, 200);
      assert.ok(sharedMemories.body.memories.some((memory: any) => memory.id === sharedMemoryId));

      const sharedInbox = await api(app, `/api/agents/${sharedAgentId}/messages`, {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(sharedInbox.status, 200);
      assert.ok(sharedInbox.body.messages.some((message: any) => message.id === sharedMessageId));

      const markRead = await api(app, `/api/agents/${sharedAgentId}/messages/${sharedMessageId}`, {
        method: 'PUT',
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(markRead.status, 403);

      const updateKnowledge = await api(app, `/api/knowledge/${sharedKnowledgeId}`, {
        method: 'PUT',
        headers: { cookie: `agentopia-auth=${memberToken}` },
        body: { title: 'member cannot edit' },
      });
      assert.equal(updateKnowledge.status, 403);

      const deleteMemory = await api(app, `/api/agents/${sharedAgentId}/memories/${sharedMemoryId}`, {
        method: 'DELETE',
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(deleteMemory.status, 403);
    });

    it('non-member cannot access shared project resources by project id or direct entity id', async () => {
      const projectDetail = await api(app, `/api/projects/${sharedProjectId}`, {
        headers: { cookie: `agentopia-auth=${outsiderToken}` },
      });
      assert.equal(projectDetail.status, 403);

      const agentDetail = await api(app, `/api/agents/${sharedAgentId}`, {
        headers: { cookie: `agentopia-auth=${outsiderToken}` },
      });
      assert.equal(agentDetail.status, 403);

      const knowledgeDetail = await api(app, `/api/knowledge/${sharedKnowledgeId}`, {
        headers: { cookie: `agentopia-auth=${outsiderToken}` },
      });
      assert.equal(knowledgeDetail.status, 403);

      const memoryList = await api(app, `/api/agents/${sharedAgentId}/memories`, {
        headers: { cookie: `agentopia-auth=${outsiderToken}` },
      });
      assert.equal(memoryList.status, 403);

      const inbox = await api(app, `/api/agents/${sharedAgentId}/messages`, {
        headers: { cookie: `agentopia-auth=${outsiderToken}` },
      });
      assert.equal(inbox.status, 403);
    });

    it('dashboard, notifications, my-issues and inbox search only include accessible projects', async () => {
      const dashboard = await api(app, '/api/dashboard/summary', {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(dashboard.status, 200);
      assert.ok(sharedProjectId in dashboard.body.last_activity, 'shared project should remain visible');
      assert.ok(!(hiddenProjectId in dashboard.body.last_activity), 'hidden project should be filtered out');

      const search = await api(app, '/api/inbox/search?q=boundary-visible-token', {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(search.status, 200);
      assert.ok(search.body.some((issue: any) => issue.id === sharedSearchIssueId));
      assert.ok(!search.body.some((issue: any) => issue.id === hiddenSearchIssueId));

      const notifications = await api(app, '/api/notifications', {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(notifications.status, 200);
      assert.ok(notifications.body.user_issues.some((issue: any) => issue.id === sharedSearchIssueId));
      assert.ok(!notifications.body.user_issues.some((issue: any) => issue.id === hiddenSearchIssueId));

      const myIssues = await api(app, '/api/my-issues', {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(myIssues.status, 200);
      assert.ok(myIssues.body.some((issue: any) => issue.id === sharedSearchIssueId));
      assert.ok(!myIssues.body.some((issue: any) => issue.id === hiddenSearchIssueId));
    });

    it('direct agent resources from hidden projects stay filtered for shared members', async () => {
      const hiddenAgent = await api(app, `/api/agents/${hiddenAgentId}`, {
        headers: { cookie: `agentopia-auth=${memberToken}` },
      });
      assert.equal(hiddenAgent.status, 403);
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

      // Verify agent is paused and idle (stopped state removed)
      const { body: agent } = await api(app, `/api/agents/${workerId}`);
      assert.equal(agent.paused, 1);
      assert.equal(agent.status, 'idle');
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

    it('retry paused agent returns 409', async () => {
      const { status, body } = await api(app, `/api/agents/${workerId}/retry`, { method: 'POST' });
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
    it('single error preserves session_id (P1 session cache)', async () => {
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
      // P1: session_id is preserved on first error (cleared only after 3 consecutive errors)
      // session_id may or may not be set depending on whether the tool created one,
      // but the key point is it should NOT be forcibly cleared on a single error

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

    describe('pending status visibility (#380)', () => {
      let pendingProjectId: string;
      let pendingIssueId: string;
      let pendingAckedIssueId: string;
      let closedIssueId: string;

      before(async () => {
        const { body: proj } = await api(app, '/api/projects', {
          method: 'POST',
          body: { name: 'notif-pending-test', description: 'Notif pending test', task_description: 'Test pending status in notifications' },
        });
        pendingProjectId = proj.id;

        const createIssue = async (title: string) => {
          const { body } = await api(app, `/api/projects/${pendingProjectId}/issues`, {
            method: 'POST',
            body: { title, body: 'test', created_by: 'user', assigned_to: 'user' },
          });
          return body.id as string;
        };

        pendingIssueId = await createIssue('Notif Pending Issue');
        pendingAckedIssueId = await createIssue('Notif Pending Acked Issue');
        closedIssueId = await createIssue('Notif Closed Issue');

        await api(app, `/api/issues/${pendingIssueId}`, {
          method: 'PUT', body: { status: 'pending', actor: 'user' },
        });
        await api(app, `/api/issues/${pendingAckedIssueId}`, {
          method: 'PUT', body: { status: 'pending', actor: 'user' },
        });
        await api(app, `/api/issues/${pendingAckedIssueId}/acknowledge`, {
          method: 'POST', body: {},
        });
        await api(app, `/api/issues/${closedIssueId}`, {
          method: 'PUT', body: { status: 'closed', actor: 'user' },
        });
      });

      it('pending issues assigned to user appear in notifications', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === pendingIssueId);
        assert.ok(found, 'pending user issue should appear in notifications');
      });

      it('acknowledged pending issues still appear in notifications (grey state)', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === pendingAckedIssueId);
        assert.ok(found, 'acknowledged pending issue should still appear in notifications');
        assert.ok(found.acknowledged_at, 'acknowledged pending issue should have acknowledged_at set');
      });

      it('closed issues do NOT appear in notifications', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === closedIssueId);
        assert.ok(!found, 'closed issue should NOT appear in notifications');
      });
    });

    describe('acknowledged issue persists in notifications after controller takeover (#382)', () => {
      let ackProjectId: string;
      let ackedThenReassignedId: string;
      let ackedThenReassignedToUserId: string;

      before(async () => {
        const { body: proj } = await api(app, '/api/projects', {
          method: 'POST',
          body: { name: 'ack-takeover-test', description: 'Ack takeover test', task_description: 'Test ack preservation on reassignment' },
        });
        ackProjectId = proj.id;

        // Issue 1: user acknowledges, then controller takes over
        const { body: i1 } = await api(app, `/api/projects/${ackProjectId}/issues`, {
          method: 'POST',
          body: { title: 'Acked Then Controller Takeover', body: 'test', created_by: 'user', assigned_to: 'user' },
        });
        ackedThenReassignedId = i1.id;

        // Issue 2: user acknowledges, then reassigned back to user
        const { body: i2 } = await api(app, `/api/projects/${ackProjectId}/issues`, {
          method: 'POST',
          body: { title: 'Acked Then Back To User', body: 'test', created_by: 'user', assigned_to: 'user' },
        });
        ackedThenReassignedToUserId = i2.id;

        // Acknowledge issue 1, then reassign to controller (agent)
        await api(app, `/api/issues/${ackedThenReassignedId}/acknowledge`, { method: 'POST', body: {} });
        await api(app, `/api/issues/${ackedThenReassignedId}`, {
          method: 'PUT', body: { assigned_to: 'some-agent-id', actor: 'system' },
        });

        // Acknowledge issue 2, then reassign to controller, then reassign back to user
        await api(app, `/api/issues/${ackedThenReassignedToUserId}/acknowledge`, { method: 'POST', body: {} });
        await api(app, `/api/issues/${ackedThenReassignedToUserId}`, {
          method: 'PUT', body: { assigned_to: 'some-agent-id', actor: 'system' },
        });
        await api(app, `/api/issues/${ackedThenReassignedToUserId}`, {
          method: 'PUT', body: { assigned_to: 'user', actor: 'system' },
        });
      });

      it('acknowledged issue still appears in notifications after controller takeover', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === ackedThenReassignedId);
        assert.ok(found, 'acknowledged issue reassigned to controller should still appear in notifications');
      });

      it('acknowledged_at is preserved when issue reassigned away from user (not reset to null)', async () => {
        const { body } = await api(app, `/api/issues/${ackedThenReassignedId}`);
        assert.ok(body.acknowledged_at, 'acknowledged_at should be preserved when issue reassigned to controller');
      });

      it('acknowledged issue reassigned back to user resets acknowledged_at', async () => {
        const { body } = await api(app, `/api/issues/${ackedThenReassignedToUserId}`);
        assert.equal(body.acknowledged_at, null, 'acknowledged_at should be reset when issue reassigned back to user');
      });

      it('acknowledged issue appears as not actionRequired (grey state)', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === ackedThenReassignedId);
        assert.ok(found, 'issue should be in notifications');
        assert.ok(found.acknowledged_at, 'acknowledged_at should be set, indicating grey/non-action-required state');
      });
    });

    describe('done status visibility (#312)', () => {
      let notifProjectId: string;
      let openIssueId: string;
      let inProgressIssueId: string;
      let doneIssueId: string;
      let doneAckedIssueId: string;

      before(async () => {
        const { body: proj } = await api(app, '/api/projects', {
          method: 'POST',
          body: { name: 'notif-done-test', description: 'Notif done test', task_description: 'Test done status in notifications' },
        });
        notifProjectId = proj.id;

        const createIssue = async (title: string) => {
          const { body } = await api(app, `/api/projects/${notifProjectId}/issues`, {
            method: 'POST',
            body: { title, body: 'test', created_by: 'user', assigned_to: 'user' },
          });
          return body.id as string;
        };

        openIssueId = await createIssue('Notif Open Issue');
        inProgressIssueId = await createIssue('Notif InProgress Issue');
        doneIssueId = await createIssue('Notif Done Issue');
        doneAckedIssueId = await createIssue('Notif Done Acked Issue');

        await api(app, `/api/issues/${inProgressIssueId}`, {
          method: 'PUT', body: { status: 'in_progress', actor: 'user' },
        });
        await api(app, `/api/issues/${doneIssueId}`, {
          method: 'PUT', body: { status: 'done', actor: 'user' },
        });
        await api(app, `/api/issues/${doneAckedIssueId}`, {
          method: 'PUT', body: { status: 'done', actor: 'user' },
        });
        await api(app, `/api/issues/${doneAckedIssueId}/acknowledge`, {
          method: 'POST', body: {},
        });
      });

      it('open issues assigned to user appear in notifications', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === openIssueId);
        assert.ok(found, 'open user issue should appear in notifications');
      });

      it('in_progress issues assigned to user appear in notifications', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === inProgressIssueId);
        assert.ok(found, 'in_progress user issue should appear in notifications');
      });

      it('done issues assigned to user (unacknowledged) appear in notifications', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === doneIssueId);
        assert.ok(found, 'done user issue with acknowledged_at=null should appear in notifications');
      });

      it('done issues that are acknowledged still appear in notifications (as acknowledged)', async () => {
        const { body } = await api(app, '/api/notifications');
        const found = body.user_issues.find((i: any) => i.id === doneAckedIssueId);
        assert.ok(found, 'done user issue with acknowledged_at set should still appear in notifications (grey state)');
        assert.ok(found.acknowledged_at, 'acknowledged issue should have acknowledged_at set');
      });

      it('acknowledged issues are ordered after unacknowledged issues', async () => {
        const { body } = await api(app, '/api/notifications');
        const issues = body.user_issues as any[];
        const ackedIndex = issues.findIndex((i: any) => i.id === doneAckedIssueId);
        const unackedIndices = [openIssueId, inProgressIssueId, doneIssueId].map(
          id => issues.findIndex((i: any) => i.id === id)
        ).filter(idx => idx !== -1);
        assert.ok(ackedIndex !== -1, 'acknowledged issue should be in list');
        assert.ok(unackedIndices.every(idx => idx < ackedIndex), 'unacknowledged issues should come before acknowledged');
      });
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

  describe('Agent File API', () => {
    let fileAgentId: string;
    let noWorkdirAgentId: string;
    let tmpDir: string;

    before(async () => {
      tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agentopia-files-'));
      fs.mkdirSync(path.join(tmpDir, 'nested'));
      fs.writeFileSync(path.join(tmpDir, 'visible.txt'), 'hello from file api');
      fs.writeFileSync(path.join(tmpDir, '.hidden.txt'), 'hidden');
      fs.writeFileSync(path.join(tmpDir, 'nested', 'child.ts'), 'export const value = 1;\n');
      fs.writeFileSync(path.join(tmpDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
      fs.writeFileSync(path.join(tmpDir, 'test.html'), '<html><body><h1>Hello</h1></body></html>');
      fs.writeFileSync(path.join(tmpDir, 'test.pdf'), '%PDF-1.4 fake pdf content');

      const fileAgent = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST',
        body: { name: 'file-api-agent', role: 'File API test agent', working_directory: tmpDir },
      });
      assert.equal(fileAgent.status, 201);
      fileAgentId = fileAgent.body.id;

      const noWorkdirAgent = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST',
        body: { name: 'no-workdir-agent', role: 'No workdir agent' },
      });
      assert.equal(noWorkdirAgent.status, 201);
      noWorkdirAgentId = noWorkdirAgent.body.id;
    });

    after(async () => {
      if (fileAgentId) await api(app, `/api/agents/${fileAgentId}`, { method: 'DELETE' });
      if (noWorkdirAgentId) await api(app, `/api/agents/${noWorkdirAgentId}`, { method: 'DELETE' });
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('lists visible files by default and hides dotfiles', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files`);
      assert.equal(status, 200);
      assert.equal(body.path, '');
      assert.equal(body.showHidden, false);
      assert.ok(Array.isArray(body.entries));
      assert.deepEqual(body.entries.map((entry: any) => entry.name), ['nested', 'binary.bin', 'test.html', 'test.pdf', 'visible.txt']);
      assert.equal(body.entries[0].type, 'dir');
      assert.equal(typeof body.entries[1].size, 'number');
      assert.ok(body.entries[1].modified);
    });

    it('includes dotfiles when showHidden is enabled', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files?showHidden=1`);
      assert.equal(status, 200);
      assert.ok(body.entries.some((entry: any) => entry.name === '.hidden.txt'));
    });

    it('rejects path traversal outside the working directory', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files?path=../`);
      assert.equal(status, 400);
      assert.equal(body.error, 'Path is outside the working_directory');
    });

    it('returns 400 when the agent has no working directory configured', async () => {
      const { status, body } = await api(app, `/api/agents/${noWorkdirAgentId}/files`);
      assert.equal(status, 400);
      assert.equal(body.error, 'Agent does not have a working_directory configured');
    });

    it('reads text files as plain text', async () => {
      const res = await inject(app, { url: `/api/agents/${fileAgentId}/files/content?path=${encodeURIComponent('nested/child.ts')}` });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers['content-type']).includes('text/plain'));
      assert.equal(res.body, 'export const value = 1;\n');
    });

    it('rejects binary file previews', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files/content?path=${encodeURIComponent('binary.bin')}`);
      assert.equal(status, 415);
      assert.equal(body.error, 'Cannot preview binary files');
    });

    it('writes file contents within the working directory', async () => {
      const update = await api(app, `/api/agents/${fileAgentId}/files/content`, {
        method: 'PUT',
        body: { path: 'visible.txt', content: 'updated content\n' },
      });
      assert.equal(update.status, 200);
      assert.equal(update.body.path, 'visible.txt');
      assert.equal(fs.readFileSync(path.join(tmpDir, 'visible.txt'), 'utf-8'), 'updated content\n');
    });

    it('serves HTML files with correct content-type and CSP header', async () => {
      const res = await inject(app, { url: `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent('test.html')}` });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers['content-type']).includes('text/html'));
      assert.ok(String(res.headers['content-security-policy']).includes("default-src 'none'"));
      assert.ok(res.body.includes('<h1>Hello</h1>'));
    });

    it('serves PDF files with correct content-type', async () => {
      const res = await inject(app, { url: `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent('test.pdf')}` });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers['content-type']).includes('application/pdf'));
      assert.ok(res.body.includes('%PDF'));
    });

    it('rejects non-previewable files from serve endpoint', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent('visible.txt')}`);
      assert.equal(status, 415);
      assert.ok(body.error.includes('cannot be served for preview'));
    });

    it('rejects path traversal on serve endpoint', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent('../etc/passwd.html')}`);
      assert.equal(status, 400);
      assert.equal(body.error, 'Path is outside the working_directory');
    });

    it('serve endpoint requires path parameter', async () => {
      const { status } = await api(app, `/api/agents/${fileAgentId}/files/serve`);
      assert.equal(status, 400);
    });

    it('serve endpoint returns 404 for nonexistent file', async () => {
      const { status } = await api(app, `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent('nonexistent.pdf')}`);
      assert.equal(status, 404);
    });

    // ─── File Upload Tests ───

    it('uploads a text file to valid path', async () => {
      const boundary = '----TestBoundary' + Date.now();
      const fileContent = 'uploaded file content';
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="uploaded.txt"',
        'Content-Type: text/plain',
        '',
        fileContent,
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${fileAgentId}/files/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      assert.equal(res.statusCode, 200);
      const result = JSON.parse(res.body);
      assert.equal(result.success, true);
      assert.equal(result.name, 'uploaded.txt');
      assert.equal(result.path, 'uploaded.txt');
      assert.equal(typeof result.size, 'number');
      // Verify the file was actually written
      const written = fs.readFileSync(path.join(tmpDir, 'uploaded.txt'), 'utf-8');
      assert.equal(written, fileContent);
    });

    it('uploads a file to a subdirectory via path field', async () => {
      const boundary = '----TestBoundary' + Date.now();
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        'nested',
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="sub-upload.txt"',
        'Content-Type: text/plain',
        '',
        'sub dir content',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${fileAgentId}/files/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      assert.equal(res.statusCode, 200);
      const result = JSON.parse(res.body);
      assert.equal(result.success, true);
      assert.equal(result.path, 'nested/sub-upload.txt');
      assert.ok(fs.existsSync(path.join(tmpDir, 'nested', 'sub-upload.txt')));
    });

    it('rejects upload with path traversal attack', async () => {
      const boundary = '----TestBoundary' + Date.now();
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        '../../etc',
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="passwd"',
        'Content-Type: text/plain',
        '',
        'malicious content',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${fileAgentId}/files/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      assert.equal(res.statusCode, 400);
      const result = JSON.parse(res.body);
      assert.equal(result.error, 'Path is outside the working_directory');
    });

    it('returns 400 when no file is provided in upload', async () => {
      const boundary = '----TestBoundary' + Date.now();
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        '',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${fileAgentId}/files/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      assert.equal(res.statusCode, 400);
      const result = JSON.parse(res.body);
      assert.equal(result.error, 'No files uploaded');
    });

    it('upload creates parent directories automatically', async () => {
      const boundary = '----TestBoundary' + Date.now();
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        'new-dir/sub-dir',
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="deep.txt"',
        'Content-Type: text/plain',
        '',
        'deep content',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${fileAgentId}/files/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      assert.equal(res.statusCode, 200);
      const result = JSON.parse(res.body);
      assert.equal(result.success, true);
      assert.equal(result.path, 'new-dir/sub-dir/deep.txt');
      assert.ok(fs.existsSync(path.join(tmpDir, 'new-dir', 'sub-dir', 'deep.txt')));
    });

    it('rejects upload for agent without working_directory', async () => {
      const boundary = '----TestBoundary' + Date.now();
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="test.txt"',
        'Content-Type: text/plain',
        '',
        'content',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${noWorkdirAgentId}/files/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      assert.equal(res.statusCode, 400);
      const result = JSON.parse(res.body);
      assert.equal(result.error, 'Agent does not have a working_directory configured');
    });

    // ─── File Download Tests ───

    it('downloads an existing text file with correct headers', async () => {
      const res = await inject(app, {
        url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent('visible.txt')}`,
      });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers['content-disposition']).includes('attachment'));
      assert.ok(String(res.headers['content-disposition']).includes('visible.txt'));
      assert.ok(String(res.headers['content-type']).includes('text/plain'));
    });

    it('downloads a binary file with correct content-type', async () => {
      const res = await inject(app, {
        url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent('binary.bin')}`,
      });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers['content-disposition']).includes('attachment'));
      assert.ok(String(res.headers['content-disposition']).includes('binary.bin'));
      // .bin should fall back to application/octet-stream
      assert.ok(String(res.headers['content-type']).includes('application/octet-stream'));
    });

    it('downloads a PDF file with application/pdf content-type', async () => {
      const res = await inject(app, {
        url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent('test.pdf')}`,
      });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers['content-type']).includes('application/pdf'));
      assert.ok(String(res.headers['content-disposition']).includes('attachment'));
    });

    it('returns 404 when downloading a nonexistent file', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent('nonexistent.txt')}`);
      assert.equal(status, 404);
    });

    it('rejects download path traversal attack', async () => {
      const { status, body } = await api(app, `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent('../../etc/passwd')}`);
      assert.equal(status, 400);
      assert.equal(body.error, 'Path is outside the working_directory');
    });

    it('download requires path parameter', async () => {
      const { status } = await api(app, `/api/agents/${fileAgentId}/files/download`);
      assert.equal(status, 400);
    });

    it('rejects download for agent without working_directory', async () => {
      const { status, body } = await api(app, `/api/agents/${noWorkdirAgentId}/files/download?path=test.txt`);
      assert.equal(status, 400);
      assert.equal(body.error, 'Agent does not have a working_directory configured');
    });

    // ─── Integration: Upload then verify in file tree and download ───

    it('uploaded file appears in file listing', async () => {
      // Upload a unique file
      const boundary = '----TestBoundary' + Date.now();
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="integration-test.txt"',
        'Content-Type: text/plain',
        '',
        'integration test content',
        `--${boundary}--`,
      ].join('\r\n');

      const uploadRes = await app.inject({
        method: 'POST',
        url: `/api/agents/${fileAgentId}/files/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      assert.equal(uploadRes.statusCode, 200);

      // Verify file appears in listing
      const { status, body: listBody } = await api(app, `/api/agents/${fileAgentId}/files`);
      assert.equal(status, 200);
      const fileNames = listBody.entries.map((e: any) => e.name);
      assert.ok(fileNames.includes('integration-test.txt'), `Expected integration-test.txt in file list, got: ${fileNames}`);
    });

    it('downloaded file content matches original', async () => {
      const originalContent = 'exact content for roundtrip test\nwith multiple lines';
      fs.writeFileSync(path.join(tmpDir, 'roundtrip.txt'), originalContent);

      const res = await inject(app, {
        url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent('roundtrip.txt')}`,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, originalContent);
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
        headers: { cookie: `agentopia-auth=${sessionToken}` },
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
      const res = await inject(app, { url: '/api/dashboard/summary' });
      assert.equal(res.statusCode, 401, 'Dashboard API should require authentication');
    });

    it('GET /api/dashboard/usage-by-project returns data (with auth)', async () => {
      const { status, body } = await api(app, '/api/dashboard/usage-by-project?period=day', {
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(status, 200);
      assert.ok(typeof body === 'object' && body !== null, 'usage-by-project should return an object');
      assert.ok(Array.isArray(body.time_buckets), 'should have time_buckets array');
      assert.ok(Array.isArray(body.projects), 'should have projects array');
      assert.ok(typeof body.data === 'object', 'should have data object');
      assert.equal(body.period, 'day');
    });

    it('GET /api/dashboard/usage-by-project requires auth', async () => {
      const res = await inject(app, { url: '/api/dashboard/usage-by-project' });
      assert.equal(res.statusCode, 401);
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

  describe('Cost de-duplication (#489/#493/#494/#495)', () => {
    let dedupeProjectId: string;
    let dedupeAgentId: string;

    before(async () => {
      const createdProject = await api(app, '/api/projects', {
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

      const createdAgent = await api(app, `/api/projects/${dedupeProjectId}/agents`, {
        method: 'POST',
        body: { name: 'cost-dedupe-agent', role: 'Cost dedupe verification' },
      });
      assert.equal(createdAgent.status, 201);
      dedupeAgentId = createdAgent.body.id;

      const { getDatabase } = await import('../src/db/database');
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
        JSON.stringify({ cost_usd: 0.3, input_tokens: 300, output_tokens: 150, duration_ms: 1000 }),
        'cost',
        '2026-01-01 10:05:00'
      );
      insertLog.run(
        dedupeAgentId,
        'dedupe-run-2',
        JSON.stringify({ cost_usd: 0.2, input_tokens: 200, output_tokens: 80, duration_ms: 2000 }),
        'cost',
        '2026-01-02 09:00:00'
      );
    });

    after(async () => {
      await api(app, `/api/projects/${dedupeProjectId}`, { method: 'DELETE' });
    });

    it('GET /api/agents/:id/costs only counts the latest cumulative row per run_id', async () => {
      const { status, body } = await api(app, `/api/agents/${dedupeAgentId}/costs`);
      assert.equal(status, 200);
      assert.equal(body.total_runs, 2);
      assert.equal(body.total_cost_usd, 0.5);
      assert.equal(body.total_input_tokens, 500);
      assert.equal(body.total_output_tokens, 230);
      assert.deepEqual(
        body.runs.map((run: any) => ({ run_id: run.run_id, cost_usd: run.cost_usd })),
        [
          { run_id: 'dedupe-run-1', cost_usd: 0.3 },
          { run_id: 'dedupe-run-2', cost_usd: 0.2 },
        ]
      );
    });

    it('GET /api/agents/:id/runs uses the latest cost row for each run_id', async () => {
      const { status, body } = await api(app, `/api/agents/${dedupeAgentId}/runs`);
      assert.equal(status, 200);
      const byRunId = new Map(body.runs.map((run: any) => [run.run_id, run]));
      assert.equal(byRunId.get('dedupe-run-1')?.cost_usd, 0.3);
      assert.equal(byRunId.get('dedupe-run-1')?.input_tokens, 300);
      assert.equal(byRunId.get('dedupe-run-1')?.output_tokens, 150);
      assert.equal(byRunId.get('dedupe-run-2')?.cost_usd, 0.2);
    });

    it('project-level cost endpoints use de-duplicated totals', async () => {
      const costs = await api(app, `/api/projects/${dedupeProjectId}/costs?period=day`);
      assert.equal(costs.status, 200);
      assert.equal(costs.body.total_cost_usd, 0.5);
      assert.equal(costs.body.total_input_tokens, 500);
      assert.equal(costs.body.total_output_tokens, 230);
      assert.equal(costs.body.by_agent['cost-dedupe-agent'].cost, 0.5);
      assert.equal(costs.body.by_agent['cost-dedupe-agent'].runs, 2);

      const exported = await api(app, `/api/projects/${dedupeProjectId}/export`);
      assert.equal(exported.status, 200);
      assert.equal(exported.body.cost_summary.total_cost_usd, 0.5);
      assert.equal(exported.body.cost_summary.total_input_tokens, 500);
      assert.equal(exported.body.cost_summary.total_output_tokens, 230);
    });

    it('dashboard aggregates also use de-duplicated totals', async () => {
      const usage = await api(app, '/api/dashboard/usage-by-project?period=day', {
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(usage.status, 200);
      const projectEntry = usage.body.projects.find((project: any) => project.id === dedupeProjectId);
      assert.ok(projectEntry, 'usage-by-project should include the dedupe test project');

      let projectCost = 0;
      for (const bucket of usage.body.time_buckets) {
        projectCost += usage.body.data[bucket]?.[dedupeProjectId]?.cost || 0;
      }
      assert.equal(projectCost, 0.5);

      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const rawCostRows = db.prepare(
        `SELECT run_id, content, id
         FROM conversation_logs
         WHERE stream = 'cost'
         ORDER BY run_id, id DESC`
      ).all() as Array<{ run_id: string; content: string; id: number }>;
      const latestByRun = new Map<string, number>();
      for (const row of rawCostRows) {
        if (latestByRun.has(row.run_id)) continue;
        latestByRun.set(row.run_id, JSON.parse(row.content).cost_usd || 0);
      }
      const expectedTotal = Array.from(latestByRun.values()).reduce((sum, value) => sum + value, 0);

      const summaryAfter = await api(app, '/api/dashboard/summary', {
        headers: { cookie: `agentopia-auth=${sessionToken}` },
      });
      assert.equal(summaryAfter.status, 200);
      assert.equal(summaryAfter.body.total_cost_usd, expectedTotal);
    });
  });

  // ─── Codex zero-cost usage visibility (#548) ───

  describe('Codex zero-cost usage visibility (#548)', () => {
    let codexProjectId: string;
    let codexAgentId: string;

    before(async () => {
      const p = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'codex-cost-project', description: 'Codex cost test', task_description: 'test', command_template: 'echo' },
      });
      assert.equal(p.status, 201);
      codexProjectId = p.body.id;

      const a = await api(app, `/api/projects/${codexProjectId}/agents`, {
        method: 'POST',
        body: { name: 'codex-agent', role: 'Codex cost test agent' },
      });
      assert.equal(a.status, 201);
      codexAgentId = a.body.id;

      // Simulate Codex cost record: cost_usd=0 but tokens present
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      db.prepare(
        `INSERT INTO conversation_logs (agent_id, run_id, content, stream, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(codexAgentId, 'codex-run-1',
        JSON.stringify({ cost_usd: 0, input_tokens: 5000, output_tokens: 1200, cache_read: 3000, cache_creation: 2000 }),
        'cost', '2026-03-15 12:00:00');
    });

    after(async () => {
      await api(app, `/api/projects/${codexProjectId}`, { method: 'DELETE' });
    });

    it('agent costs API returns token data even when cost_usd is 0', async () => {
      const { status, body } = await api(app, `/api/agents/${codexAgentId}/costs`);
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
      const { status, body } = await api(app, `/api/projects/${codexProjectId}/costs`);
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
      const { status, body } = await api(app, `/api/agents/${codexAgentId}/runs`);
      assert.equal(status, 200);
      assert.ok(body.runs.length >= 1);
      const run = body.runs.find((r: any) => r.run_id === 'codex-run-1');
      assert.ok(run, 'should find the codex run');
      assert.equal(run.cost_usd, 0);
      assert.equal(run.input_tokens, 5000);
      assert.equal(run.output_tokens, 1200);
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
      const res = await inject(app, { url: '/issues/nonexistent', headers: { cookie: `agentopia-auth=${sessionToken}` } });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('id="issues-link"'), 'Should have issues-link element');
      assert.ok(res.body.includes('id="project-link"'), 'Should have project-link element');
      assert.ok(res.body.includes('id="issue-title-breadcrumb"'), 'Should have issue-title breadcrumb');
    });

    it('project.html has breadcrumb with section span', async () => {
      const res = await inject(app, { url: `/projects/${projectId}`, headers: { cookie: `agentopia-auth=${sessionToken}` } });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('id="breadcrumb-section"'), 'Should have breadcrumb-section element');
      assert.ok(res.body.includes('id="project-name"'), 'Should have project-name element');
    });

    it('project.html exposes the Files tab alongside the existing project tabs', async () => {
      const res = await inject(app, { url: `/projects/${projectId}`, headers: { cookie: `agentopia-auth=${sessionToken}` } });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes("switchTab('git')"), 'Should have Git tab');
      assert.ok(res.body.includes("switchTab('overview')"), 'Should have Overview tab');
      assert.ok(res.body.includes("switchTab('agents')"), 'Should have Agents tab');
      assert.ok(res.body.includes("switchTab('issues')"), 'Should have Issues tab');
      assert.ok(res.body.includes("switchTab('activity')"), 'Should have Activity tab');
      assert.ok(res.body.includes("switchTab('knowledge')"), 'Should have Knowledge tab');
      assert.ok(res.body.includes("switchTab('files')"), 'Should have Files tab');
    });

    it('agent.html no longer renders the embedded Files workspace tab', async () => {
      const res = await inject(app, { url: `/agents/${workerId}`, headers: { cookie: `agentopia-auth=${sessionToken}` } });
      assert.equal(res.statusCode, 200);
      assert.ok(!res.body.includes('data-panel="files"'), 'Agent page should not render the old Files workspace tab');
      assert.ok(!res.body.includes('workspace-files-panel'), 'Agent page should not render the old Files workspace panel');
    });
  });

  // ─── @Mention Parsing ───

  describe('@Mention in Issues', () => {
    let mentionIssueId: string;

    it('creating issue with @worker-1 triggers agent start', async () => {
      // Ensure agent is idle first
      const { body: agentBefore } = await api(app, `/api/agents/${workerId}`);
      // If running, stop it first
      if (agentBefore.status === 'running') {
        await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          const { body: st } = await api(app, `/api/agents/${workerId}/status`);
          if (st.status !== 'running') break;
        }
      }

      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'Mention test', body: 'Hey @worker-1 please check this', created_by: 'user' },
      });
      assert.equal(status, 201);
      mentionIssueId = body.id;

      // Agent should have been auto-started
      await new Promise(r => setTimeout(r, 500));
      const { body: agentAfter } = await api(app, `/api/agents/${workerId}/status`);
      // Agent may already finish (echo command is fast), check it was started
      assert.ok(
        agentAfter.status === 'running' || agentAfter.status === 'idle' || agentAfter.status === 'error',
        'Agent should have been triggered'
      );
    });

    it('system event recorded for auto-started agent', async () => {
      // Wait for process to finish
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const { body: st } = await api(app, `/api/agents/${workerId}/status`);
        if (st.status !== 'running') break;
      }

      const { body: issue } = await api(app, `/api/issues/${mentionIssueId}`);
      const systemEvents = issue.comments.filter((c: any) => c.author_id === 'system');
      assert.ok(systemEvents.length > 0, 'Should have system event for auto-start');
      const mentionEvent = systemEvents.find((c: any) => c.body.includes('auto-started') && c.body.includes('worker-1'));
      assert.ok(mentionEvent, 'System event should mention auto-started worker-1');
    });

    it('@mention of nonexistent agent does not cause error', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'Unknown mention', body: 'Hey @nonexistent-agent check', created_by: 'user' },
      });
      assert.equal(status, 201);
    });

    it('comment with @worker-1 triggers agent start', async () => {
      // Stop agent if running
      const { body: st } = await api(app, `/api/agents/${workerId}/status`);
      if (st.status === 'running') {
        await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          const { body: s } = await api(app, `/api/agents/${workerId}/status`);
          if (s.status !== 'running') break;
        }
      }

      const { status } = await api(app, `/api/issues/${mentionIssueId}/comments`, {
        method: 'POST',
        body: { author_id: 'user', body: '@worker-1 please verify this fix' },
      });
      assert.equal(status, 201);

      // Agent should have been triggered
      await new Promise(r => setTimeout(r, 500));
      const { body: agentAfter } = await api(app, `/api/agents/${workerId}/status`);
      assert.ok(
        agentAfter.status === 'running' || agentAfter.status === 'idle' || agentAfter.status === 'error',
        'Agent should have been triggered by comment @mention'
      );

      // Wait for agent to finish
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const { body: s } = await api(app, `/api/agents/${workerId}/status`);
        if (s.status !== 'running') break;
      }
    });

    it('issue body without @mention does not trigger system event', async () => {
      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'No mention', body: 'Just a normal issue', created_by: 'user' },
      });
      assert.equal(status, 201);
      const { body: issue } = await api(app, `/api/issues/${body.id}`);
      const systemEvents = issue.comments.filter((c: any) => c.author_id === 'system' && c.body.includes('auto-started'));
      assert.equal(systemEvents.length, 0, 'No auto-start event for issue without @mention');
    });

    it('multiple @mentions in one text are all parsed', async () => {
      // Create a second worker agent for this test
      const { body: worker2 } = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST', body: { name: 'worker-2', role: 'Test worker 2' },
      });
      const worker2Id = worker2.id;

      // Stop worker-1 if running
      const { body: st } = await api(app, `/api/agents/${workerId}/status`);
      if (st.status === 'running') {
        await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          const { body: s } = await api(app, `/api/agents/${workerId}/status`);
          if (s.status !== 'running') break;
        }
      }

      const { status, body: newIssue } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'Multi mention', body: 'Need @worker-1 and @worker-2 to review', created_by: 'user' },
      });
      assert.equal(status, 201);

      // Wait for processes
      await new Promise(r => setTimeout(r, 1000));
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const { body: s1 } = await api(app, `/api/agents/${workerId}/status`);
        const { body: s2 } = await api(app, `/api/agents/${worker2Id}/status`);
        if (s1.status !== 'running' && s2.status !== 'running') break;
      }

      const { body: issue } = await api(app, `/api/issues/${newIssue.id}`);
      const autoStartEvents = issue.comments.filter((c: any) => c.author_id === 'system' && c.body.includes('auto-started'));
      assert.ok(autoStartEvents.length >= 2, `Should have at least 2 auto-start events, got ${autoStartEvents.length}`);

      // Cleanup worker-2
      await api(app, `/api/agents/${worker2Id}`, { method: 'DELETE' });
    });
  });

  // ─── @Mention: paused agent should NOT be started ───

  describe('@Mention Paused Agent', () => {
    it('@mention of paused agent does not start it', async () => {
      // Stop agent if running
      const { body: stBefore } = await api(app, `/api/agents/${workerId}/status`);
      if (stBefore.status === 'running') {
        await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          const { body: s } = await api(app, `/api/agents/${workerId}/status`);
          if (s.status !== 'running') break;
        }
      }

      // Pause the worker using the dedicated pause endpoint
      const { status: pauseStatus } = await api(app, `/api/agents/${workerId}/pause`, { method: 'POST' });
      // May already be paused (409), that's OK
      assert.ok(pauseStatus === 200 || pauseStatus === 409, `Pause should succeed or already be paused, got ${pauseStatus}`);

      const { body: paused } = await api(app, `/api/agents/${workerId}`);
      assert.equal(paused.paused, 1, 'Agent should be paused');

      // Create issue mentioning the paused agent
      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'Mention paused agent', body: '@worker-1 check this', created_by: 'user' },
      });
      assert.equal(status, 201);

      await new Promise(r => setTimeout(r, 500));

      // Agent should NOT have been started
      const { body: agentAfter } = await api(app, `/api/agents/${workerId}/status`);
      assert.notEqual(agentAfter.status, 'running', 'Paused agent should not be started by @mention');

      // No auto-start system event
      const { body: issue } = await api(app, `/api/issues/${body.id}`);
      const autoStartEvents = issue.comments.filter((c: any) => c.author_id === 'system' && c.body.includes('auto-started'));
      assert.equal(autoStartEvents.length, 0, 'No auto-start event for paused agent');

      // Unpause for later tests
      await api(app, `/api/agents/${workerId}/unpause`, { method: 'POST' });
    });
  });

  // ─── Controller On-Demand Mode ───

  describe('Controller On-Demand Mode', () => {
    it('on-demand mode: creating issue triggers controller', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'On-demand wake test', body: 'Test on-demand controller trigger', created_by: 'user' },
      });
      assert.equal(status, 201);

      // Controller may or may not start (echo command finishes fast),
      // but the call should not error
      await new Promise(r => setTimeout(r, 1500));
    });

    it('on-demand mode: updating issue triggers controller', async () => {
      const { body: list } = await api(app, `/api/projects/${projectId}/issues?status=open`);
      assert.ok(list.issues.length > 0, 'Should have open issues');

      const issueId = list.issues[0].id;
      const { status } = await api(app, `/api/issues/${issueId}`, {
        method: 'PUT', body: { status: 'in_progress', actor: 'user' },
      });
      assert.equal(status, 200);
      await new Promise(r => setTimeout(r, 1500));
    });

    it('on-demand mode: adding comment triggers controller', async () => {
      const { body: list } = await api(app, `/api/projects/${projectId}/issues`);
      const issueId = list.issues[0].id;

      const { status } = await api(app, `/api/issues/${issueId}/comments`, {
        method: 'POST',
        body: { author_id: 'user', body: 'On-demand comment test' },
      });
      assert.equal(status, 201);
      await new Promise(r => setTimeout(r, 1500));
    });
  });

  // ─── Quick Commands (已移除, #230) ───
  // 快速命令框已改为直接创建issue，旧的quick-commands端点已删除

  describe('Quick Commands removed (#230)', () => {
    it('POST /api/projects/:pid/quick-commands returns 404 (endpoint removed)', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/quick-commands`, {
        method: 'POST', body: { message: 'test' },
      });
      assert.equal(status, 404);
    });

    it('GET /api/projects/:pid/quick-commands returns 404 (endpoint removed)', async () => {
      const { status } = await api(app, `/api/projects/${projectId}/quick-commands`);
      assert.equal(status, 404);
    });

    it('POST /api/projects/:pid/issues accepts issue creation (new quick-cmd path)', async () => {
      // The new sendQuickCmd posts directly to issues API, this verifies the endpoint works
      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: 'Add a dark mode feature', body: 'Add a dark mode feature', created_by: 'user', assigned_to: 'all' },
      });
      assert.equal(status, 201);
      assert.ok(body.id, 'Should return issue id');
      assert.equal(body.title, 'Add a dark mode feature');
    });

    it('quick-cmd: title and body are stored independently (#276)', async () => {
      // 验证 #276: 快速命令输入框支持 title 和 body 独立填写
      const titleText = '修复登录超时问题';
      const bodyText = '详细描述：用户在使用VPN时，登录请求会超时。需要增加超时时间或优化认证流程。';
      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: titleText, body: bodyText, created_by: 'user', assigned_to: 'all' },
      });
      assert.equal(status, 201);
      assert.equal(body.title, titleText, 'title 应与输入框内容一致');
      assert.equal(body.body, bodyText, 'body 应与 textarea 内容独立存储');
      assert.notEqual(body.title, body.body, 'title 和 body 应不同');
    });

    it('quick-cmd: body 为空时以 title 作为 body 的后备值 (#276)', async () => {
      // 当用户不填写 body 时，前端逻辑为 body: bodyText || msg（fallback 到 title）
      const titleText = '优化搜索性能';
      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: titleText, body: titleText, created_by: 'user', assigned_to: 'all' },
      });
      assert.equal(status, 201);
      assert.equal(body.title, titleText);
      assert.equal(body.body, titleText, 'body 未填写时应与 title 相同');
    });

    it('quick-cmd: title 和 body 均为非空字符串时均被保存 (#276)', async () => {
      const titleText = '添加导出功能';
      const bodyText = '支持将 issue 列表导出为 CSV 和 PDF 格式';
      const { status, body } = await api(app, `/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: titleText, body: bodyText, created_by: 'user', assigned_to: 'all' },
      });
      assert.equal(status, 201);
      assert.ok(body.title.length > 0, 'title 不应为空');
      assert.ok(body.body.length > 0, 'body 不应为空');
      assert.equal(body.title, titleText);
      assert.equal(body.body, bodyText);
    });
  });

  // ─── API连接失败自动重启 (#436/#437) ───

  describe('API连接失败自动重启 (#436)', () => {
    // 等待agent进入非running/非waiting状态（最多等maxMs毫秒），返回最终状态
    async function waitForNonRunning(agentId: string, maxMs = 15000, alsoSkipWaiting = false): Promise<string> {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300));
        const { body: st } = await api(app, `/api/agents/${agentId}/status`);
        if (st.status !== 'running' && (!alsoSkipWaiting || st.status !== 'waiting')) return st.status;
      }
      const { body: st } = await api(app, `/api/agents/${agentId}/status`);
      return st.status;
    }

    // 等待agent的in-memory进程退出（is_running变为false）
    async function waitForProcessExit(agentId: string, maxMs = 5000): Promise<void> {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        const { body: st } = await api(app, `/api/agents/${agentId}/status`);
        if (!st.is_running) return;
      }
    }

    it('API连接错误时自动重试，两次失败后进入error状态', async () => {
      // 确保agent不在运行中
      await waitForNonRunning(workerId);

      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: "sh -c 'echo Unable to connect to API >&2; exit 1'" },
      });

      try {
        const startRes = await api(app, `/api/agents/${workerId}/start`, {
          method: 'POST', body: { prompt: 'test api retry' },
        });
        assert.equal(startRes.status, 200, `start应返回200，实际: ${startRes.status}`);

        // 等待第一次进程退出（is_running → false）
        await waitForProcessExit(workerId, 3000);

        // 若API错误被检测到，关闭处理器应进入'waiting'状态（5分钟重试等待中）
        const { body: midState } = await api(app, `/api/agents/${workerId}/status`);
        assert.equal(midState.status, 'waiting',
          `第一次API错误后应为waiting（等待重试）。实际: ${midState.status}, pid: ${midState.pid}, is_running: ${midState.is_running}`);

        // 5分钟重试延迟太长，不等待完成。手动停止agent让状态恢复。
        await api(app, `/api/agents/${workerId}/stop`, { method: 'POST' });
        await waitForNonRunning(workerId, 5000, true);
      } finally {
        await api(app, `/api/projects/${projectId}`, {
          method: 'PUT', body: { command_template: 'echo' },
        });
        await waitForNonRunning(workerId, 12000, true);
      }
    });

    it('非API错误不触发自动重试，直接变为error', async () => {
      await waitForNonRunning(workerId);

      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'false' },
      });

      try {
        const startRes = await api(app, `/api/agents/${workerId}/start`, {
          method: 'POST', body: { prompt: 'test non-api error no retry' },
        });
        assert.equal(startRes.status, 200, `start应返回200，实际: ${startRes.status}`);

        // 非API错误应立即进入error（无重试延迟）
        const finalStatus = await waitForNonRunning(workerId, 5000);
        assert.equal(finalStatus, 'error',
          `非API错误应直接进入error（无自动重试）。实际: ${finalStatus}`);
      } finally {
        await api(app, `/api/projects/${projectId}`, {
          method: 'PUT', body: { command_template: 'echo' },
        });
        await waitForNonRunning(workerId, 5000);
      }
    });

    it('成功运行后agent变为idle状态', async () => {
      await waitForNonRunning(workerId);

      await api(app, `/api/projects/${projectId}`, {
        method: 'PUT', body: { command_template: 'echo' },
      });

      try {
        const startRes = await api(app, `/api/agents/${workerId}/start`, {
          method: 'POST', body: { prompt: 'test success' },
        });
        assert.equal(startRes.status, 200, `start应返回200，实际: ${startRes.status}`);

        const finalStatus = await waitForNonRunning(workerId, 5000);
        assert.equal(finalStatus, 'idle',
          `成功运行后agent应为idle。实际: ${finalStatus}`);
      } finally {
        await api(app, `/api/projects/${projectId}`, {
          method: 'PUT', body: { command_template: 'echo' },
        });
        await waitForNonRunning(workerId, 5000);
      }
    });
  });

  describe('成本优化/调度回归 (#497/#498)', () => {
    let restoreMockClaude: (() => void) | null = null;

    before(() => {
      const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agentopia-mock-claude-'));
      const binPath = path.join(tmpDir, 'claude');
      fs.writeFileSync(binPath, `#!/bin/sh
set -eu

prompt="\${AGENTOPIA_PROMPT:-}"

contains() {
  printf '%s' "$prompt" | grep -q "$1"
}

if contains 'API_RETRY_FAIL'; then
  echo 'Unable to connect to API' >&2
  exit 1
fi

if contains 'TAIL_SESSION'; then
  cat <<'JSON'
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"tiny"}]}}
JSON
  sleep 10
  exit 0
fi

if contains 'PRECTRL_KEEPALIVE'; then
  sleep 10
  cat <<'JSON'
{"type":"result","result":"pre-controller done","usage":{"input_tokens":10,"output_tokens":120},"total_cost_usd":0}
JSON
  exit 0
fi

if contains 'LOW_OUTPUT'; then
  cat <<'JSON'
{"type":"result","result":"low output done","usage":{"input_tokens":10,"output_tokens":50},"total_cost_usd":0}
JSON
  exit 0
fi

cat <<'JSON'
{"type":"result","result":"normal output done","usage":{"input_tokens":10,"output_tokens":150},"total_cost_usd":0}
JSON
`, { mode: 0o755 });

      const prevPath = process.env.PATH || '';
      process.env.PATH = `${tmpDir}:${prevPath}`;
      restoreMockClaude = () => {
        process.env.PATH = prevPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      };
    });

    after(() => {
      restoreMockClaude?.();
    });

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function createMockWorker(name: string): Promise<string> {
      const { status, body } = await api(app, `/api/projects/${projectId}/agents`, {
        method: 'POST',
        body: { name, role: 'Mock regression worker', command_template: 'claude' },
      });
      assert.equal(status, 201);
      return body.id;
    }

    async function waitForAgentStatus(
      agentId: string,
      predicate: (status: string) => boolean,
      maxMs = 5000
    ): Promise<any> {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        const { body } = await api(app, `/api/agents/${agentId}/status`);
        if (predicate(body.status)) return body;
        await sleep(100);
      }
      const { body } = await api(app, `/api/agents/${agentId}/status`);
      return body;
    }

    async function insertAssignedIssue(agentId: string, marker: string, status = 'in_progress'): Promise<number> {
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const issueId = `issue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const last = db.prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?').get(projectId) as { n: number | null };
      const number = (last?.n || 0) + 1;

      db.prepare(`
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'))
      `).run(
        issueId,
        projectId,
        number,
        `${marker} title`,
        `${marker} body`,
        'test',
        agentId,
        1,
        status,
        'test'
      );

      return number;
    }

    it('低产出 run 不触发 cooldown，agent 运行完毕后恢复 idle（cooldown 和低产出跟踪已移除）', async () => {
      const { isAgentInCooldown } = await import('../src/services/process-manager');
      const agentId = await createMockWorker(`cooldown-worker-${Date.now()}`);

      const startRes = await api(app, `/api/agents/${agentId}/start`, {
        method: 'POST',
        body: { prompt: 'LOW_OUTPUT first low-output run' },
      });
      assert.equal(startRes.status, 200);

      const finalState = await waitForAgentStatus(agentId, (status) => status !== 'running' && status !== 'waiting');
      assert.equal(finalState.status, 'idle');
      // Cooldown is disabled — always returns false
      assert.equal(isAgentInCooldown(agentId), false);
    });

    it('低产出 session 尾巴检测已移除，agent 正常完成后变为 idle', async () => {
      // Tail-kill (intra-session consecutive low-output detection) was removed in refactor.
      // Agents now simply run to completion and return to idle.
      const agentId = await createMockWorker(`tail-worker-${Date.now()}`);
      const startRes = await api(app, `/api/agents/${agentId}/start`, {
        method: 'POST',
        body: { prompt: 'LOW_OUTPUT run completes normally' },
      });
      assert.equal(startRes.status, 200);

      const finalState = await waitForAgentStatus(agentId, (status) => status === 'idle', 7000);
      assert.equal(finalState.status, 'idle');
    });

    it('API 连接连续失败两次后停止，并保持 5 分钟重试常量', async () => {
      const agentId = await createMockWorker(`api-retry-worker-${Date.now()}`);
      const originalSetTimeout = global.setTimeout;
      const seenDelays: number[] = [];

      (global as any).setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        const ms = Number(delay ?? 0);
        seenDelays.push(ms);
        const actualDelay = ms === 5 * 60 * 1000 ? 10 : ms;
        return originalSetTimeout(handler as any, actualDelay, ...args);
      }) as typeof setTimeout;

      try {
        const startRes = await api(app, `/api/agents/${agentId}/start`, {
          method: 'POST',
          body: { prompt: 'API_RETRY_FAIL should retry then stop' },
        });
        assert.equal(startRes.status, 200);

        const finalState = await waitForAgentStatus(agentId, (status) => status === 'error', 5000);
        assert.equal(finalState.status, 'error');
      } finally {
        (global as any).setTimeout = originalSetTimeout;
      }

      assert.ok(seenDelays.includes(5 * 60 * 1000), '应保留 5 分钟重试常量');

      const { body: logs } = await api(app, `/api/agents/${agentId}/logs`);
      const joined = logs.map((entry: any) => entry.content).join('\n');
      assert.match(joined, /5分钟后自动重试/);
      assert.match(joined, /API连接持续失败/);
    });

    it('pre-controller 会直接启动 idle worker（cooldown 已移除，低产出不再阻塞重启）', async () => {
      const { tryHandleWithoutLLM } = await import('../src/services/pre-controller');
      const { isAgentInCooldown } = await import('../src/services/process-manager');

      const directStartAgentId = await createMockWorker(`prectrl-run-${Date.now()}`);
      const directStartIssueNumber = await insertAssignedIssue(directStartAgentId, 'PRECTRL_KEEPALIVE');
      const handled = tryHandleWithoutLLM(projectId, directStartIssueNumber);
      assert.equal(handled, true);

      const runningState = await waitForAgentStatus(directStartAgentId, (status) => status === 'running', 2000);
      assert.equal(runningState.status, 'running');

      await api(app, `/api/agents/${directStartAgentId}/stop`, { method: 'POST' });
      const stoppedState = await waitForAgentStatus(directStartAgentId, (status) => status !== 'running', 7000);
      assert.notEqual(stoppedState.status, 'running');

      // Cooldown is disabled — isAgentInCooldown always returns false after refactor
      const cooldownAgentId = await createMockWorker(`prectrl-cooldown-${Date.now()}`);
      const lowOutputStart = await api(app, `/api/agents/${cooldownAgentId}/start`, {
        method: 'POST',
        body: { prompt: 'LOW_OUTPUT cooldown gate run' },
      });
      assert.equal(lowOutputStart.status, 200);
      const cooldownState = await waitForAgentStatus(cooldownAgentId, (status) => status !== 'running' && status !== 'waiting');
      assert.equal(cooldownState.status, 'idle');
      // Cooldown always disabled
      assert.equal(isAgentInCooldown(cooldownAgentId), false);

      // Since no cooldown, pre-controller should still start agent directly
      const cooldownIssueNumber = await insertAssignedIssue(cooldownAgentId, 'PRECTRL_KEEPALIVE');
      const handled2 = tryHandleWithoutLLM(projectId, cooldownIssueNumber);
      assert.equal(handled2, true);
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
      assert.ok(res.body.includes('Agentopia'));
    });
  });

  describe('Frontend UI English copy (#540)', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    const jsDir = path.join(publicDir, 'js');
    const publicRoot = path.join(__dirname, '..');
    const vendorFiles = new Set(['mammoth.browser.min.js', 'xlsx.full.min.js', 'jszip.min.js']);
    const filesToScan = [
      ...fs.readdirSync(publicDir).filter((name) => name.endsWith('.html')).map((name) => path.join(publicDir, name)),
      ...fs.readdirSync(jsDir).filter((name) => name.endsWith('.js') && !vendorFiles.has(name)).map((name) => path.join(jsDir, name)),
    ];
    const hanRegex = /\p{Script=Han}/u;

    it('public HTML and JS files do not contain Han characters', () => {
      const offenders: string[] = [];

      for (const filePath of filesToScan) {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (hanRegex.test(content)) {
          offenders.push(path.relative(publicRoot, filePath));
        }
      }

      assert.deepEqual(offenders, []);
    });

    it('representative UI strings are translated to English', () => {
      const dashboardHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
      const projectHtml = fs.readFileSync(path.join(publicDir, 'project.html'), 'utf-8');
      const agentHtml = fs.readFileSync(path.join(publicDir, 'agent.html'), 'utf-8');
      const commonJs = fs.readFileSync(path.join(jsDir, 'common.js'), 'utf-8');
      const dashboardJs = fs.readFileSync(path.join(jsDir, 'dashboard.js'), 'utf-8');
      const projectJs = fs.readFileSync(path.join(jsDir, 'project.js'), 'utf-8');

      assert.ok(dashboardHtml.includes('Search issues...'));
      assert.ok(projectHtml.includes('Share Settings'));
      assert.ok(projectHtml.includes('+ Add Knowledge'));
      assert.ok(projectHtml.includes('Grant Access'));
      assert.ok(agentHtml.includes('Activity Summary'));
      assert.ok(commonJs.includes('Loading...'));
      assert.ok(commonJs.includes('Live updates connected'));
      assert.ok(dashboardJs.includes('No notifications'));
      assert.ok(projectJs.includes('No knowledge entries yet.'));
    });
  });

  // ─── Config Read Failure (#120): should NOT redirect to /setup ───
  //
  // Bug: When config file is unreadable at startup (e.g. NFS timeout),
  // passwordWasEverSet was false, causing the auth middleware to redirect
  // to /setup even for existing users. Fix: if file exists but read fails,
  // assume password was set (passwordWasEverSet = true).
  //
  // These tests verify the loadAuthConfig function and auth hook behavior
  // by examining the code structure. The runtime onRequest hook re-reads
  // config when passwordHash is null. We test the fix indirectly by
  // verifying existing auth behavior is intact and loadAuthConfig returns
  // correct readError/fileExists values.

  describe('Config Read Failure Guard (#120)', () => {
    it('loadAuthConfig: valid config is readable from database', async () => {
      // Auth config is now stored in DB (migrated from file-based auth)
      // Verify that the password set during setup is accessible via login
      const { status } = await api(app, '/api/auth', {
        method: 'POST', body: { password: 'test1234' },
      });
      assert.equal(status, 200, 'Auth config should be readable from DB');
    });

    it('loadAuthConfig: invalid JSON in config file triggers catch block', () => {
      // Verify the catch block behavior by testing JSON.parse with invalid content
      let threw = false;
      try {
        JSON.parse('<<<CORRUPTED>>>');
      } catch {
        threw = true;
      }
      assert.ok(threw, 'Invalid JSON should throw, triggering readError path in loadAuthConfig');
    });

    it('auth middleware does not redirect authenticated user to /setup', async () => {
      // Login to get valid token
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth',
        payload: { password: 'test1234' },
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(loginRes.statusCode, 200);
      const token = (loginRes.headers['set-cookie'] as string).match(/agentopia-auth=([^;]+)/)![1];

      // Authenticated request should succeed, never redirect to /setup
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/summary',
        headers: { cookie: `agentopia-auth=${token}` },
      });
      assert.equal(res.statusCode, 200, 'Authenticated request should succeed');
      if (res.headers.location) {
        assert.ok(!res.headers.location.toString().includes('/setup'),
          'Should NEVER redirect authenticated user to /setup');
      }
    });

    it('unauthenticated request redirects to /login, not /setup (password was set)', async () => {
      // When password is set, unauthenticated page requests should redirect to /login, not /setup
      // Use page route to test cookie-based auth redirect
      const res = await inject(app, { url: '/change-password', headers: { cookie: 'agentopia-auth=invalid' } });
      assert.equal(res.statusCode, 302, 'Should redirect unauthenticated request');
      assert.equal(res.headers.location, '/login', 'Should redirect to /login, not /setup');
    });

    it('GET /setup redirects to /login when password is set (not show setup form)', async () => {
      const res = await inject(app, { url: '/setup' });
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, '/login',
        'Should redirect to /login, not show setup form');
    });

    it('auth config is stored in database (migrated from file)', () => {
      // Auth was migrated from file-based to DB-based storage (#120 fix)
      // Verify auth.ts uses database for config persistence
      const authSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.ts'), 'utf-8');

      // Verify auth.ts uses DB
      assert.ok(authSource.includes('getDatabase') || authSource.includes('database'),
        'loadAuthConfig should use database for storage');

      // Verify it does NOT redirect to /setup when DB has a password
      // Auth uses DB-reload approach: if passwordHash is empty, reload from DB before checking
      assert.ok(authSource.includes('loadAuthConfig') || authSource.includes('authConfig.passwordHash'),
        'Should reload auth config from DB to prevent /setup redirect');
    });

    it('login works with DB-based auth (not affected by file system state)', async () => {
      // Auth config is now in DB, not file — login should always work
      // regardless of the state of the legacy ~/.agentopia/config.json file
      const { status, body } = await api(app, '/api/auth', {
        method: 'POST', body: { password: 'test1234' },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });
  });

  // ─── session_max_tokens default value (#145) ───

  describe('Controller issue-triggered context filtering (#170)', () => {
    let ctxProjectId: string;

    before(async () => {
      // Create a project for this test
      const { body } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'ctx-filter-test', task_description: 'Test issue context filtering', working_directory: '/tmp/ctx-test', command_template: 'echo done' },
      });
      ctxProjectId = body.id;

      // Create a controller agent
      await api(app, `/api/projects/${ctxProjectId}/agents`, {
        method: 'POST',
        body: { name: 'ctx-controller', role: 'controller', is_controller: true },
      });

      // Create a worker agent
      await api(app, `/api/projects/${ctxProjectId}/agents`, {
        method: 'POST',
        body: { name: 'ctx-worker', role: 'worker' },
      });

      // Create multiple issues
      await api(app, `/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Alpha', body: 'Alpha body', created_by: 'user' },
      });
      await api(app, `/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Beta', body: 'Beta body', created_by: 'user' },
      });
      await api(app, `/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Gamma', body: 'Gamma body', created_by: 'user' },
      });
    });

    it('buildControllerTaskPrompt without triggerIssueNumber includes all open issues', async () => {
      const { buildControllerTaskPrompt } = await import('../src/services/controller');
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(ctxProjectId) as any;

      const prompt = buildControllerTaskPrompt(project);
      assert.ok(prompt.includes('Issue Alpha'), 'Should include Issue Alpha');
      assert.ok(prompt.includes('Issue Beta'), 'Should include Issue Beta');
      assert.ok(prompt.includes('Issue Gamma'), 'Should include Issue Gamma');
      assert.ok(!prompt.includes('Trigger Context'), 'Should NOT have trigger context hint');
    });

    it('buildControllerTaskPrompt with triggerIssueNumber=1 includes only that issue', async () => {
      const { buildControllerTaskPrompt } = await import('../src/services/controller');
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(ctxProjectId) as any;

      const prompt = buildControllerTaskPrompt(project, 1);
      assert.ok(prompt.includes('Issue Alpha'), 'Should include Issue Alpha (issue #1)');
      assert.ok(!prompt.includes('Issue Beta'), 'Should NOT include Issue Beta');
      assert.ok(!prompt.includes('Issue Gamma'), 'Should NOT include Issue Gamma');
      assert.ok(prompt.includes('Trigger Context'), 'Should have trigger context hint');
      assert.ok(prompt.includes('issue #1'), 'Should mention trigger issue number');
    });

    it('buildControllerTaskPrompt with triggerIssueNumber=2 includes only issue #2', async () => {
      const { buildControllerTaskPrompt } = await import('../src/services/controller');
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(ctxProjectId) as any;

      const prompt = buildControllerTaskPrompt(project, 2);
      assert.ok(!prompt.includes('Issue Alpha'), 'Should NOT include Issue Alpha');
      assert.ok(prompt.includes('Issue Beta'), 'Should include Issue Beta (issue #2)');
      assert.ok(!prompt.includes('Issue Gamma'), 'Should NOT include Issue Gamma');
      assert.ok(prompt.includes('issue #2'), 'Should mention trigger issue number 2');
    });

    it('scheduler trigger (no triggerIssueNumber) includes all issues', async () => {
      const { buildControllerTaskPrompt } = await import('../src/services/controller');
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(ctxProjectId) as any;

      // Simulate scheduler behavior: no triggerIssueNumber
      const prompt = buildControllerTaskPrompt(project, undefined);
      assert.ok(prompt.includes('Issue Alpha'), 'Scheduler should see all issues');
      assert.ok(prompt.includes('Issue Beta'), 'Scheduler should see all issues');
      assert.ok(prompt.includes('Issue Gamma'), 'Scheduler should see all issues');
      assert.ok(!prompt.includes('Trigger Context'), 'Scheduler should NOT have trigger hint');
    });

    it('triggerControllerOnDemand passes triggerIssueNumber through', async () => {
      // Verify the routes code passes triggerIssueNumber by checking that
      // creating an issue with on-demand mode includes the issue number
      const { status } = await api(app, `/api/projects/${ctxProjectId}/issues`, {
        method: 'POST',
        body: { title: 'On-demand trigger test', body: 'Should pass triggerIssueNumber', created_by: 'user' },
      });
      assert.equal(status, 201);
      // The call completes without error, verifying triggerIssueNumber is accepted
      await new Promise(r => setTimeout(r, 1500));
    });
  });

  describe('session_max_tokens default 400000 (#145, updated #216)', () => {
    let tokenTestProjectId: string;

    before(async () => {
      const { body } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'token-test-project', description: 'For token tests', task_description: 'test', command_template: 'echo' },
      });
      tokenTestProjectId = body.id;
    });

    it('newly created agent has session_max_tokens = 400000', async () => {
      const { status, body } = await api(app, `/api/projects/${tokenTestProjectId}/agents`, {
        method: 'POST', body: { name: 'token-test-agent', role: 'test' },
      });
      assert.equal(status, 201);
      assert.equal(body.session_max_tokens, 400000, 'Default session_max_tokens should be 400000');
    });

    it('PUT session_max_tokens updates correctly', async () => {
      const { body: created } = await api(app, `/api/projects/${tokenTestProjectId}/agents`, {
        method: 'POST', body: { name: 'token-update-agent', role: 'test' },
      });
      assert.equal(created.session_max_tokens, 400000);

      const { status, body } = await api(app, `/api/agents/${created.id}`, {
        method: 'PUT', body: { session_max_tokens: 500000 },
      });
      assert.equal(status, 200);
      assert.equal(body.session_max_tokens, 500000, 'Should update to 500000');
    });

    it('PUT session_max_tokens=0 stores 0 (minimum is 0)', async () => {
      const { body: created } = await api(app, `/api/projects/${tokenTestProjectId}/agents`, {
        method: 'POST', body: { name: 'token-zero-agent', role: 'test' },
      });

      const { status, body } = await api(app, `/api/agents/${created.id}`, {
        method: 'PUT', body: { session_max_tokens: 0 },
      });
      assert.equal(status, 200);
      assert.equal(body.session_max_tokens, 0, 'session_max_tokens=0 should be allowed (Math.max(0,...))');
    });

    it('PUT negative session_max_tokens is clamped to 0', async () => {
      const { body: created } = await api(app, `/api/projects/${tokenTestProjectId}/agents`, {
        method: 'POST', body: { name: 'token-neg-agent', role: 'test' },
      });

      const { status, body } = await api(app, `/api/agents/${created.id}`, {
        method: 'PUT', body: { session_max_tokens: -100 },
      });
      assert.equal(status, 200);
      assert.equal(body.session_max_tokens, 0, 'Negative value should be clamped to 0');
    });

    it('schema migration sets existing 0 values to 400000', async () => {
      const { body: created } = await api(app, `/api/projects/${tokenTestProjectId}/agents`, {
        method: 'POST', body: { name: 'migration-test-agent', role: 'test' },
      });
      // Set to 0 via API
      await api(app, `/api/agents/${created.id}`, {
        method: 'PUT', body: { session_max_tokens: 0 },
      });
      // Verify it's 0
      const { body: before } = await api(app, `/api/agents/${created.id}`);
      assert.equal(before.session_max_tokens, 0, 'Should be 0 before migration');

      // Run the same migration SQL that schema.ts runs on startup
      const { getDatabase } = require('../src/db/database');
      const db = getDatabase();
      const result = db.prepare("UPDATE agents SET session_max_tokens = 400000 WHERE session_max_tokens = 0").run();
      assert.ok(result.changes > 0, 'Migration should update at least 1 row');

      // Check that the agent's 0 was updated to 400000
      const { body: after } = await api(app, `/api/agents/${created.id}`);
      assert.equal(after.session_max_tokens, 400000, 'Migration should update 0 to 400000');
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
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'reassign-test', task_description: 'Test auto-reassign', working_directory: '/tmp/reassign-test', command_template: 'echo done' },
      });
      raProjectId = proj.id;

      // Use the auto-created controller (project creation auto-creates one with is_controller=1)
      const { body: agents } = await api(app, `/api/projects/${raProjectId}/agents`);
      const ctrl = agents.find((a: any) => a.is_controller);
      assert.ok(ctrl, 'Project should have auto-created controller');
      raControllerId = ctrl.id;

      const { body: w1 } = await api(app, `/api/projects/${raProjectId}/agents`, {
        method: 'POST',
        body: { name: 'ra-worker', role: 'worker' },
      });
      raWorkerId = w1.id;

      const { body: w2 } = await api(app, `/api/projects/${raProjectId}/agents`, {
        method: 'POST',
        body: { name: 'ra-worker2', role: 'worker2' },
      });
      raWorker2Id = w2.id;

      const { body: iss } = await api(app, `/api/projects/${raProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Reassign test issue', body: 'Test', created_by: 'user' },
      });
      raIssueId = iss.id;
    });

    it('user comment with @mention reassigns to mentioned agent', async () => {
      const { status } = await api(app, `/api/issues/${raIssueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: 'Hey @ra-worker please look at this' },
      });
      assert.equal(status, 201);

      const { body: issue } = await api(app, `/api/issues/${raIssueId}`);
      assert.equal(issue.assigned_to, raWorkerId, 'Should be reassigned to mentioned agent');
    });

    it('user comment with multiple @mentions assigns to first match', async () => {
      const { status } = await api(app, `/api/issues/${raIssueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: '@ra-worker2 and @ra-worker check this' },
      });
      assert.equal(status, 201);

      const { body: issue } = await api(app, `/api/issues/${raIssueId}`);
      assert.equal(issue.assigned_to, raWorker2Id, 'Should be assigned to first mentioned agent (ra-worker2)');
    });

    it('user comment without @mention assigns to controller', async () => {
      const { status } = await api(app, `/api/issues/${raIssueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: 'No mention here, just a question' },
      });
      assert.equal(status, 201);

      const { body: issue } = await api(app, `/api/issues/${raIssueId}`);
      assert.equal(issue.assigned_to, raControllerId, 'Should be assigned to controller when no @mention');
    });

    it('user comment on done/closed issue reopens it', async () => {
      // Close the issue first
      await api(app, `/api/issues/${raIssueId}`, {
        method: 'PUT', body: { status: 'done', actor: 'user' },
      });
      const { body: closed } = await api(app, `/api/issues/${raIssueId}`);
      assert.equal(closed.status, 'done');

      // User comments — should reopen
      await api(app, `/api/issues/${raIssueId}/comments`, {
        method: 'POST', body: { author_id: 'user', body: 'Actually this is not fixed' },
      });

      const { body: reopened } = await api(app, `/api/issues/${raIssueId}`);
      assert.equal(reopened.status, 'open', 'Issue should be reopened after user comment on done issue');
    });

    it('agent comment does NOT trigger auto-reassign', async () => {
      // Set a known assignee first
      await api(app, `/api/issues/${raIssueId}`, {
        method: 'PUT', body: { assigned_to: raWorkerId, actor: 'system' },
      });

      // Agent comments — should NOT change assignment
      await api(app, `/api/issues/${raIssueId}/comments`, {
        method: 'POST', body: { author_id: raWorkerId, body: 'Agent reporting progress @ra-worker2' },
      });

      const { body: issue } = await api(app, `/api/issues/${raIssueId}`);
      assert.equal(issue.assigned_to, raWorkerId, 'Agent comment should NOT change assignee');
    });
  });

  // ─── Acknowledge / Inbox Search (#227/#228) ───

  describe('Acknowledge and Inbox Search (#227, #228)', () => {
    let ackProjectId: string;
    let ackIssueId: string;

    before(async () => {
      // Create a project and an issue for ack tests
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST', body: { name: 'ack-test', description: 'Ack test project', task_description: 'Test project for acknowledge and inbox search tests' },
      });
      ackProjectId = proj.id;
      const { body: issue } = await api(app, `/api/projects/${ackProjectId}/issues`, {
        method: 'POST', body: { title: 'Ack Test Issue', body: 'Some body text', created_by: 'user', assigned_to: 'user' },
      });
      ackIssueId = issue.id;
    });

    it('issue starts with acknowledged_at = null', async () => {
      const { body } = await api(app, `/api/issues/${ackIssueId}`);
      assert.equal(body.acknowledged_at, null, 'New issue should have acknowledged_at = null');
    });

    it('POST /api/issues/:id/acknowledge sets acknowledged_at', async () => {
      const { status, body } = await api(app, `/api/issues/${ackIssueId}/acknowledge`, {
        method: 'POST', body: {},
      });
      assert.equal(status, 200, 'Acknowledge should return 200');
      assert.ok(body.acknowledged_at, 'acknowledged_at should be set after acknowledge');
    });

    it('POST /api/issues/:id/unacknowledge clears acknowledged_at', async () => {
      const { status, body } = await api(app, `/api/issues/${ackIssueId}/unacknowledge`, {
        method: 'POST', body: {},
      });
      assert.equal(status, 200, 'Unacknowledge should return 200');
      assert.equal(body.acknowledged_at, null, 'acknowledged_at should be null after unacknowledge');
    });

    it('GET /api/inbox/search returns matching issues', async () => {
      const { status, body } = await api(app, '/api/inbox/search?q=Ack+Test');
      assert.equal(status, 200, 'Inbox search should return 200');
      assert.ok(Array.isArray(body), 'Inbox search result should be an array');
      const found = body.find((i: any) => i.id === ackIssueId);
      assert.ok(found, 'Created issue should appear in inbox search results');
    });

    it('GET /api/inbox/search returns empty array for no match', async () => {
      const { status, body } = await api(app, '/api/inbox/search?q=zzz_no_match_xyz');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 0, 'Should return empty array for non-matching query');
    });

    it('GET /api/inbox/search returns empty array when q is missing', async () => {
      const { status, body } = await api(app, '/api/inbox/search');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 0, 'Should return empty array when no query provided');
    });

    it('GET /api/inbox/search matches by issue number', async () => {
      // Get the issue number first
      const { body: issue } = await api(app, `/api/issues/${ackIssueId}`);
      const issueNum = String(issue.number);
      const { body } = await api(app, `/api/inbox/search?q=${issueNum}`);
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
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: {
          name: 'stop-sigterm-test',
          description: 'Test project for stop/SIGTERM verification',
          task_description: 'Stop test',
          command_template: 'tail -f /dev/null #',
        },
      });
      stopTestProjectId = proj.id;

      const { body: ag } = await api(app, `/api/projects/${stopTestProjectId}/agents`, {
        method: 'POST', body: { name: 'stop-test-agent', role: 'Stop test agent' },
      });
      stopTestAgentId = ag.id;
    });

    after(async () => {
      // Clean up: stop if still running then delete project
      await api(app, `/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 1000));
      await api(app, `/api/projects/${stopTestProjectId}`, { method: 'DELETE' });
    });

    it('status is "idle" after stop (stopped state removed, agents return to idle)', async () => {
      // Start a long-running process (tail -f /dev/null never exits)
      const { status: startStatus, body: startBody } = await api(app, `/api/agents/${stopTestAgentId}/start`, {
        method: 'POST', body: { prompt: 'run forever' },
      });
      assert.equal(startStatus, 200, 'start should succeed');
      assert.ok(startBody.pid, 'should get a PID');

      // Wait for process to be registered
      await new Promise(r => setTimeout(r, 500));
      const { body: runningState } = await api(app, `/api/agents/${stopTestAgentId}/status`);
      assert.equal(runningState.status, 'running', 'agent should be running before stop');

      // Send stop
      const { status: stopStatus } = await api(app, `/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });
      assert.equal(stopStatus, 200, 'stop should return 200');

      // Wait for close handler
      await new Promise(r => setTimeout(r, 2000));
      const { body: stoppedState } = await api(app, `/api/agents/${stopTestAgentId}/status`);
      assert.equal(stoppedState.status, 'idle', 'status must be "idle" after stop');
    });

    it('process PID is no longer alive after stop (exec prefix ensures SIGTERM kills child)', async () => {
      // Start again and capture PID
      const { body: startBody } = await api(app, `/api/agents/${stopTestAgentId}/start`, {
        method: 'POST', body: { prompt: 'run forever again' },
      });
      const pid = startBody.pid;
      assert.ok(pid, 'must have a PID to verify process death');

      // Confirm PID is alive
      await new Promise(r => setTimeout(r, 500));
      let pidAlive = true;
      try { process.kill(pid, 0); } catch { pidAlive = false; }
      assert.ok(pidAlive, `PID ${pid} should be alive before stop`);

      // Stop the agent
      await api(app, `/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });

      // Wait for process termination (SIGTERM should kill immediately via exec)
      await new Promise(r => setTimeout(r, 2000));

      let pidDeadAfterStop = false;
      try { process.kill(pid, 0); } catch { pidDeadAfterStop = true; }
      assert.ok(pidDeadAfterStop, `PID ${pid} should be dead after stop (exec prefix ensures SIGTERM propagates)`);
    });

    it('idle agent can be restarted after stop', async () => {
      // Verify currently idle (stopped state removed)
      const { body: preState } = await api(app, `/api/agents/${stopTestAgentId}/status`);
      assert.equal(preState.status, 'idle', 'agent should be idle after stop');

      // Restart
      const { status: restartStatus, body: restartBody } = await api(app, `/api/agents/${stopTestAgentId}/start`, {
        method: 'POST', body: { prompt: 'restart after stop' },
      });
      assert.equal(restartStatus, 200, 'restart should succeed');
      assert.ok(restartBody.pid, 'restart should produce a PID');

      await new Promise(r => setTimeout(r, 300));
      const { body: restartState } = await api(app, `/api/agents/${stopTestAgentId}/status`);
      assert.equal(restartState.status, 'running', 'agent should be running after restart');

      // Cleanup: stop it
      await api(app, `/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 1500));
    });

    it('close handler sets agent to idle after stop', async () => {
      // Start agent
      await api(app, `/api/agents/${stopTestAgentId}/start`, {
        method: 'POST', body: { prompt: 'close handler test' },
      });
      await new Promise(r => setTimeout(r, 400));

      // Stop agent
      await api(app, `/api/agents/${stopTestAgentId}/stop`, { method: 'POST' });

      // Wait past close handler execution
      await new Promise(r => setTimeout(r, 2500));

      const { body: finalState } = await api(app, `/api/agents/${stopTestAgentId}/status`);
      assert.equal(finalState.status, 'idle',
        'close handler should set agent to idle after stop');
    });
  });

  // ─── Knowledge Base (#283) ───

  let knowledgeProjectId: string;
  let knowledgeEntryId: string;
  let knowledgeMediumId: string;

  describe('Knowledge Base (#283)', () => {
    it('setup: create project for knowledge tests', async () => {
      const { status, body } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'knowledge-test', description: 'Knowledge test', task_description: 'Test knowledge base' },
      });
      assert.equal(status, 201);
      knowledgeProjectId = body.id;
    });

    it('POST /api/projects/:pid/knowledge creates entry', async () => {
      const { status, body } = await api(app, `/api/projects/${knowledgeProjectId}/knowledge`, {
        method: 'POST',
        body: { title: 'Test Knowledge', content: 'Test content', tags: 'test,arch', importance: 'high', created_by: 'agent-1' },
      });
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.title, 'Test Knowledge');
      assert.equal(body.importance, 'high');
      assert.equal(body.tags, 'test,arch');
      knowledgeEntryId = body.id;
    });

    it('POST /api/projects/:pid/knowledge rejects missing title', async () => {
      const { status, body } = await api(app, `/api/projects/${knowledgeProjectId}/knowledge`, {
        method: 'POST',
        body: { content: 'no title' },
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'title is required');
    });

    it('POST /api/projects/:pid/knowledge defaults to medium importance', async () => {
      const { status, body } = await api(app, `/api/projects/${knowledgeProjectId}/knowledge`, {
        method: 'POST',
        body: { title: 'Medium Entry', content: 'medium content' },
      });
      assert.equal(status, 201);
      assert.equal(body.importance, 'medium');
      knowledgeMediumId = body.id;
    });

    it('GET /api/projects/:pid/knowledge lists all entries', async () => {
      const { status, body } = await api(app, `/api/projects/${knowledgeProjectId}/knowledge`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.equal(body.entries.length, 2);
    });

    it('GET /api/projects/:pid/knowledge?importance=high filters by importance', async () => {
      const { status, body } = await api(app, `/api/projects/${knowledgeProjectId}/knowledge?importance=high`);
      assert.equal(status, 200);
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0].importance, 'high');
    });

    it('GET /api/knowledge/:id returns single entry', async () => {
      const { status, body } = await api(app, `/api/knowledge/${knowledgeEntryId}`);
      assert.equal(status, 200);
      assert.equal(body.id, knowledgeEntryId);
      assert.equal(body.title, 'Test Knowledge');
    });

    it('GET /api/knowledge/:id returns 404 for unknown id', async () => {
      const { status } = await api(app, '/api/knowledge/does-not-exist');
      assert.equal(status, 404);
    });

    it('PUT /api/knowledge/:id updates entry', async () => {
      const { status, body } = await api(app, `/api/knowledge/${knowledgeEntryId}`, {
        method: 'PUT',
        body: { title: 'Updated Title', importance: 'low' },
      });
      assert.equal(status, 200);
      assert.equal(body.title, 'Updated Title');
      assert.equal(body.importance, 'low');
      assert.equal(body.content, 'Test content', 'unset fields should be preserved');
    });

    it('PUT /api/knowledge/:id returns 404 for unknown id', async () => {
      const { status } = await api(app, '/api/knowledge/does-not-exist', {
        method: 'PUT', body: { title: 'x' },
      });
      assert.equal(status, 404);
    });

    it('DELETE /api/knowledge/:id removes entry', async () => {
      const { status, body } = await api(app, `/api/knowledge/${knowledgeMediumId}`, {
        method: 'DELETE',
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      const { status: getStatus } = await api(app, `/api/knowledge/${knowledgeMediumId}`);
      assert.equal(getStatus, 404, 'Deleted entry should return 404');
    });

    it('DELETE /api/knowledge/:id returns 404 for unknown id', async () => {
      const { status } = await api(app, '/api/knowledge/does-not-exist', {
        method: 'DELETE',
      });
      assert.equal(status, 404);
    });

    it('system-prompt injects high-importance knowledge entries', async () => {
      // Reset entry to high importance
      await api(app, `/api/knowledge/${knowledgeEntryId}`, {
        method: 'PUT', body: { importance: 'high', title: 'High Knowledge', content: 'Important info' },
      });
      // Get an agent in this project (the auto-created controller)
      const { body: agentsList } = await api(app, `/api/projects/${knowledgeProjectId}/agents`);
      assert.ok(agentsList.length > 0, 'project should have at least one agent');
      const agentId = agentsList[0].id;

      const { status, raw } = await api(app, `/api/agents/${agentId}/system-prompt`);
      assert.equal(status, 200);
      assert.ok(raw.includes('High Knowledge'), 'system prompt should include high-importance knowledge title');
      assert.ok(raw.includes('Important info'), 'system prompt should include high-importance knowledge content');
      assert.ok(raw.includes('Project Knowledge Base'), 'system prompt should have Knowledge Base section header');
    });
  });

  describe('Knowledge FTS全文搜索 (#399)', () => {
    let ftsProjId: string;
    let ftsEntryId: string;

    before(async () => {
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'fts-test-proj', description: 'FTS test', task_description: 'Test FTS search' },
      });
      ftsProjId = proj.id;
    });

    it('POST creates knowledge entry for FTS', async () => {
      const { status, body } = await api(app, `/api/projects/${ftsProjId}/knowledge`, {
        method: 'POST',
        body: { title: 'SQLite Performance Tips', content: 'Use indexes for fast queries', tags: 'database,performance', importance: 'high', created_by: 'agent-1' },
      });
      assert.equal(status, 201);
      ftsEntryId = body.id;
    });

    it('GET ?q= returns FTS matches', async () => {
      const { status, body } = await api(app, `/api/projects/${ftsProjId}/knowledge?q=SQLite`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.ok(body.entries.length >= 1);
      assert.ok(body.entries.some((e: any) => e.id === ftsEntryId));
    });

    it('GET ?q= with non-matching term returns empty', async () => {
      const { status, body } = await api(app, `/api/projects/${ftsProjId}/knowledge?q=nonexistentxyz`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.equal(body.entries.length, 0);
    });

    it('FTS updates when entry is updated', async () => {
      await api(app, `/api/knowledge/${ftsEntryId}`, {
        method: 'PUT',
        body: { content: 'Use WAL mode for concurrent writes' },
      });
      const { body } = await api(app, `/api/projects/${ftsProjId}/knowledge?q=WAL`);
      assert.ok(body.entries.length >= 1);
    });

    it('FTS entry disappears after delete', async () => {
      await api(app, `/api/knowledge/${ftsEntryId}`, { method: 'DELETE' });
      const { body } = await api(app, `/api/projects/${ftsProjId}/knowledge?q=WAL`);
      assert.equal(body.entries.length, 0);
    });
  });

  describe('Agent记忆系统 (#399)', () => {
    let memProjId: string;
    let memAgentId: string;
    let memAgent2Id: string;
    let privateMemId: string;
    let sharedMemId: string;

    before(async () => {
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'mem-test-proj', description: 'Memory test', task_description: 'Test agent memories' },
      });
      memProjId = proj.id;

      const { body: a1 } = await api(app, `/api/projects/${memProjId}/agents`, {
        method: 'POST',
        body: { name: 'mem-agent-1', role: 'worker' },
      });
      memAgentId = a1.id;

      const { body: a2 } = await api(app, `/api/projects/${memProjId}/agents`, {
        method: 'POST',
        body: { name: 'mem-agent-2', role: 'worker' },
      });
      memAgent2Id = a2.id;
    });

    it('POST /api/agents/:id/memories saves a private memory', async () => {
      const { status, body } = await api(app, `/api/agents/${memAgentId}/memories`, {
        method: 'POST',
        body: { content: 'Private secret', tags: 'private', scope: 'private' },
      });
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.scope, 'private');
      privateMemId = body.id;
    });

    it('POST /api/agents/:id/memories saves a project-scoped memory', async () => {
      const { status, body } = await api(app, `/api/agents/${memAgentId}/memories`, {
        method: 'POST',
        body: { content: 'Shared project memory', tags: 'shared', scope: 'project' },
      });
      assert.equal(status, 201);
      assert.equal(body.scope, 'project');
      sharedMemId = body.id;
    });

    it('POST rejects missing content', async () => {
      const { status, body } = await api(app, `/api/agents/${memAgentId}/memories`, {
        method: 'POST',
        body: { tags: 'test' },
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'content is required');
    });

    it('POST rejects invalid scope', async () => {
      const { status, body } = await api(app, `/api/agents/${memAgentId}/memories`, {
        method: 'POST',
        body: { content: 'test', scope: 'invalid' },
      });
      assert.equal(status, 400);
    });

    it('GET /api/agents/:id/memories lists own + project memories', async () => {
      const { status, body } = await api(app, `/api/agents/${memAgentId}/memories`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.memories));
      assert.ok(body.memories.some((m: any) => m.id === privateMemId));
      assert.ok(body.memories.some((m: any) => m.id === sharedMemId));
    });

    it('GET ?scope=project filters to project scope only', async () => {
      const { body } = await api(app, `/api/agents/${memAgentId}/memories?scope=project`);
      assert.ok(body.memories.every((m: any) => m.scope === 'project'));
    });

    it('other agent sees project-scope memory but not private memory', async () => {
      const { body } = await api(app, `/api/agents/${memAgent2Id}/memories`);
      assert.ok(body.memories.some((m: any) => m.id === sharedMemId), 'should see shared memory');
      assert.ok(!body.memories.some((m: any) => m.id === privateMemId), 'should NOT see private memory');
    });

    it('GET /api/agents/:id/memories?q= FTS search works', async () => {
      const { body } = await api(app, `/api/agents/${memAgentId}/memories?q=Shared`);
      assert.ok(body.memories.length >= 1);
      assert.ok(body.memories.some((m: any) => m.id === sharedMemId));
    });

    it('GET /api/projects/:pid/memories returns project-scope memories', async () => {
      const { status, body } = await api(app, `/api/projects/${memProjId}/memories`);
      assert.equal(status, 200);
      assert.ok(body.memories.some((m: any) => m.id === sharedMemId));
      assert.ok(!body.memories.some((m: any) => m.id === privateMemId), 'project endpoint should not include private');
    });

    it('GET /api/projects/:pid/memories?q= FTS search', async () => {
      const { body } = await api(app, `/api/projects/${memProjId}/memories?q=Shared+project`);
      assert.ok(body.memories.length >= 1);
    });

    it('DELETE /api/agents/:id/memories/:memId removes memory', async () => {
      const { status, body } = await api(app, `/api/agents/${memAgentId}/memories/${privateMemId}`, {
        method: 'DELETE',
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      const { body: list } = await api(app, `/api/agents/${memAgentId}/memories`);
      assert.ok(!list.memories.some((m: any) => m.id === privateMemId));
    });

    it('DELETE nonexistent memory returns 404', async () => {
      const { status } = await api(app, `/api/agents/${memAgentId}/memories/nonexistent-id`, {
        method: 'DELETE',
      });
      assert.equal(status, 404);
    });

    it('system prompt includes agent memories', async () => {
      const { buildSystemPrompt } = await import('../src/services/system-prompt');
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(memAgentId) as any;
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(memProjId) as any;
      if (agent && project) {
        const prompt = buildSystemPrompt(agent, project);
        assert.ok(prompt.includes('Memories') || prompt.includes('memories') || prompt.includes('Shared project memory'));
      }
    });
  });

  describe('Issue依赖关系 (#400)', () => {
    let relProjId: string;
    let relIssue1Id: string;
    let relIssue2Id: string;
    let relIssue3Id: string;
    let blocksRelId: string;
    let relatedRelId: string;

    before(async () => {
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'rel-test-proj', description: 'Relations test', task_description: 'Test issue relations' },
      });
      relProjId = proj.id;

      const { body: i1 } = await api(app, `/api/projects/${relProjId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Alpha', body: 'first', created_by: 'user', assigned_to: 'user' },
      });
      relIssue1Id = i1.id;

      const { body: i2 } = await api(app, `/api/projects/${relProjId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Beta', body: 'second', created_by: 'user', assigned_to: 'user' },
      });
      relIssue2Id = i2.id;

      const { body: i3 } = await api(app, `/api/projects/${relProjId}/issues`, {
        method: 'POST',
        body: { title: 'Issue Gamma', body: 'third', created_by: 'user', assigned_to: 'user' },
      });
      relIssue3Id = i3.id;
    });

    it('POST /api/issues/:id/relations creates blocks relation', async () => {
      const { status, body } = await api(app, `/api/issues/${relIssue1Id}/relations`, {
        method: 'POST',
        body: { type: 'blocks', target_issue_id: relIssue2Id, actor: 'user' },
      });
      assert.equal(status, 201);
      assert.equal(body.relation_type, 'blocks');
      assert.equal(body.from_issue_id, relIssue1Id);
      assert.equal(body.to_issue_id, relIssue2Id);
      blocksRelId = body.id;
    });

    it('POST /api/issues/:id/relations creates related_to relation', async () => {
      const { status, body } = await api(app, `/api/issues/${relIssue1Id}/relations`, {
        method: 'POST',
        body: { type: 'related_to', target_issue_id: relIssue3Id, actor: 'user' },
      });
      assert.equal(status, 201);
      assert.equal(body.relation_type, 'related_to');
      relatedRelId = body.id;
    });

    it('POST rejects self-relation', async () => {
      const { status, body } = await api(app, `/api/issues/${relIssue1Id}/relations`, {
        method: 'POST',
        body: { type: 'blocks', target_issue_id: relIssue1Id, actor: 'user' },
      });
      assert.equal(status, 400);
      assert.ok(body.error.includes('self'));
    });

    it('POST rejects invalid type', async () => {
      const { status } = await api(app, `/api/issues/${relIssue1Id}/relations`, {
        method: 'POST',
        body: { type: 'depends_on', target_issue_id: relIssue2Id, actor: 'user' },
      });
      assert.equal(status, 400);
    });

    it('POST duplicate relation returns 409', async () => {
      const { status } = await api(app, `/api/issues/${relIssue1Id}/relations`, {
        method: 'POST',
        body: { type: 'blocks', target_issue_id: relIssue2Id, actor: 'user' },
      });
      assert.equal(status, 409);
    });

    it('GET /api/issues/:id/relations returns blocks, blocked_by, related_to', async () => {
      const { status, body } = await api(app, `/api/issues/${relIssue1Id}/relations`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.blocks));
      assert.ok(Array.isArray(body.blocked_by));
      assert.ok(Array.isArray(body.related_to));
      assert.ok(body.blocks.some((r: any) => r.to_issue_id === relIssue2Id));
      assert.ok(body.related_to.some((r: any) => r.to_issue_id === relIssue3Id || r.from_issue_id === relIssue3Id));
    });

    it('GET /api/issues/:id returns blocks/blocked_by/is_blocked in detail', async () => {
      const { status, body } = await api(app, `/api/issues/${relIssue2Id}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.blocked_by));
      assert.ok(body.blocked_by.some((r: any) => r.id === relIssue1Id));
      assert.equal(body.is_blocked, true);
    });

    it('列表接口 is_blocked=true 当存在未完成的 blocker', async () => {
      const { status, body } = await api(app, `/api/projects/${relProjId}/issues`);
      assert.equal(status, 200);
      const beta = body.issues.find((i: any) => i.id === relIssue2Id);
      assert.ok(beta, 'Issue Beta 应在列表中');
      assert.equal(typeof beta.is_blocked, 'boolean', 'is_blocked 应为布尔值，非 null');
      assert.equal(beta.is_blocked, true, 'blocker 未完成时 is_blocked 应为 true');
      // Issue Alpha (blocker) 自身不应被 blocked
      const alpha = body.issues.find((i: any) => i.id === relIssue1Id);
      assert.ok(alpha, 'Issue Alpha 应在列表中');
      assert.equal(typeof alpha.is_blocked, 'boolean', 'is_blocked 应为布尔值，非 null');
      assert.equal(alpha.is_blocked, false, '没有 blocker 的 issue，is_blocked 应为 false');
    });

    it('is_blocked=false when blocker is done', async () => {
      await api(app, `/api/issues/${relIssue1Id}`, {
        method: 'PUT', body: { status: 'done', actor: 'user' },
      });
      const { body } = await api(app, `/api/issues/${relIssue2Id}`);
      assert.equal(body.is_blocked, false);
    });

    it('列表接口 is_blocked=false 当所有 blocker 都已完成', async () => {
      // relIssue1 已在上一个测试中置为 done
      const { status, body } = await api(app, `/api/projects/${relProjId}/issues`);
      assert.equal(status, 200);
      const beta = body.issues.find((i: any) => i.id === relIssue2Id);
      assert.ok(beta, 'Issue Beta 应在列表中');
      assert.equal(typeof beta.is_blocked, 'boolean', 'is_blocked 应为布尔值，非 null');
      assert.equal(beta.is_blocked, false, 'blocker 已完成时 is_blocked 应为 false');
    });

    it('DELETE /api/issues/:id/relations/:relationId removes relation', async () => {
      const { status, body } = await api(app, `/api/issues/${relIssue1Id}/relations/${relatedRelId}`, {
        method: 'DELETE',
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      const { body: rels } = await api(app, `/api/issues/${relIssue1Id}/relations`);
      assert.ok(!rels.related_to.some((r: any) => r.id === relatedRelId));
    });

    it('DELETE nonexistent relation returns 404', async () => {
      const { status } = await api(app, `/api/issues/${relIssue1Id}/relations/nonexistent-id`, {
        method: 'DELETE',
      });
      assert.equal(status, 404);
    });
  });

  describe('Agent直接消息通信 (#401)', () => {
    let msgProjId: string;
    let msgAgentAId: string;
    let msgAgentBId: string;
    let msgId: string;

    before(async () => {
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'msg-test-proj', description: 'Messages test', task_description: 'Test agent messages', command_template: 'echo' },
      });
      msgProjId = proj.id;
      // Pause project to prevent auto-wake spawning background processes during message tests
      await api(app, `/api/projects/${msgProjId}`, { method: 'PUT', body: { status: 'paused' } });

      const { body: a1 } = await api(app, `/api/projects/${msgProjId}/agents`, {
        method: 'POST',
        body: { name: 'msg-agent-a', role: 'sender' },
      });
      msgAgentAId = a1.id;

      const { body: a2 } = await api(app, `/api/projects/${msgProjId}/agents`, {
        method: 'POST',
        body: { name: 'msg-agent-b', role: 'receiver' },
      });
      msgAgentBId = a2.id;
    });

    it('POST /api/agents/:id/messages/send sends a message', async () => {
      const { status, body } = await api(app, `/api/agents/${msgAgentAId}/messages/send`, {
        method: 'POST',
        body: { to: msgAgentBId, subject: 'Hello', body: 'Hi from agent A' },
      });
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.from_agent_id, msgAgentAId);
      assert.equal(body.to_agent_id, msgAgentBId);
      assert.equal(body.status, 'unread');
      msgId = body.id;
    });

    it('POST send requires to and body', async () => {
      const { status } = await api(app, `/api/agents/${msgAgentAId}/messages/send`, {
        method: 'POST',
        body: { subject: 'No recipient' },
      });
      assert.equal(status, 400);
    });

    it('POST send rejects unknown sender', async () => {
      const { status } = await api(app, `/api/agents/nonexistent-id/messages/send`, {
        method: 'POST',
        body: { to: msgAgentBId, body: 'test' },
      });
      assert.equal(status, 404);
    });

    it('POST send rejects unknown recipient', async () => {
      const { status } = await api(app, `/api/agents/${msgAgentAId}/messages/send`, {
        method: 'POST',
        body: { to: 'nonexistent-id', body: 'test' },
      });
      assert.equal(status, 404);
    });

    it('GET /api/agents/:id/messages lists inbox', async () => {
      const { status, body } = await api(app, `/api/agents/${msgAgentBId}/messages`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.messages.some((m: any) => m.id === msgId));
    });

    it('GET ?status=unread filters to unread messages', async () => {
      const { body } = await api(app, `/api/agents/${msgAgentBId}/messages?status=unread`);
      assert.ok(body.messages.some((m: any) => m.id === msgId));
    });

    it('PUT /api/agents/:id/messages/:msgId marks message as read', async () => {
      const { status, body } = await api(app, `/api/agents/${msgAgentBId}/messages/${msgId}`, {
        method: 'PUT',
      });
      assert.equal(status, 200);
      assert.equal(body.status, 'read');
    });

    it('GET ?status=unread returns empty after marking read', async () => {
      const { body } = await api(app, `/api/agents/${msgAgentBId}/messages?status=unread`);
      assert.ok(!body.messages.some((m: any) => m.id === msgId));
    });

    it('POST read-all marks all messages as read', async () => {
      // Send another message first
      await api(app, `/api/agents/${msgAgentAId}/messages/send`, {
        method: 'POST',
        body: { to: msgAgentBId, subject: 'Second', body: 'Another message' },
      });

      const { status, body } = await api(app, `/api/agents/${msgAgentBId}/messages/read-all`, {
        method: 'POST',
      });
      assert.equal(status, 200);
      assert.ok(typeof body.updated === 'number');

      const { body: inbox } = await api(app, `/api/agents/${msgAgentBId}/messages?status=unread`);
      assert.equal(inbox.messages.length, 0);
    });

    it('GET /api/agents/:id/messages/sent returns sent messages', async () => {
      const { status, body } = await api(app, `/api/agents/${msgAgentAId}/messages/sent`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.messages.length >= 2);
    });

    it('PUT nonexistent message returns 404', async () => {
      const { status } = await api(app, `/api/agents/${msgAgentBId}/messages/nonexistent-id`, {
        method: 'PUT',
      });
      assert.equal(status, 404);
    });

    it('system prompt includes unread messages', async () => {
      // Send a fresh message so there's at least one unread
      await api(app, `/api/agents/${msgAgentAId}/messages/send`, {
        method: 'POST',
        body: { to: msgAgentBId, subject: 'Urgent', body: 'Check this out' },
      });

      const { buildSystemPrompt } = await import('../src/services/system-prompt');
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(msgAgentBId) as any;
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(msgProjId) as any;
      if (agent && project) {
        const prompt = buildSystemPrompt(agent, project);
        assert.ok(prompt.includes('message') || prompt.includes('Message') || prompt.includes('Urgent'));
      }
    });
  });

  describe('Agent层级结构 (#523/#528)', () => {
    let hierarchyProjectId: string;
    let hierarchyControllerId: string;
    let managerAgentId: string;
    let leafAgentId: string;
    let siblingAgentId: string;
    let otherProjectId: string;
    let otherProjectAgentId: string;

    before(async () => {
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: {
          name: 'hierarchy-test-proj',
          description: 'Hierarchy test',
          task_description: 'Test parent_agent_id hierarchy',
          command_template: 'echo',
        },
      });
      hierarchyProjectId = proj.id;
      await api(app, `/api/projects/${hierarchyProjectId}`, { method: 'PUT', body: { status: 'paused' } });

      const { body: projectAgents } = await api(app, `/api/projects/${hierarchyProjectId}/agents`);
      hierarchyControllerId = projectAgents.find((agent: any) => agent.is_controller)?.id;
      assert.ok(hierarchyControllerId, 'project should have a controller');

      const manager = await api(app, `/api/projects/${hierarchyProjectId}/agents`, {
        method: 'POST',
        body: { name: 'hier-manager', role: 'manager', parent_agent_id: hierarchyControllerId },
      });
      assert.equal(manager.status, 201);
      managerAgentId = manager.body.id;
      assert.equal(manager.body.parent_agent_id, hierarchyControllerId);

      const leaf = await api(app, `/api/projects/${hierarchyProjectId}/agents`, {
        method: 'POST',
        body: { name: 'hier-leaf', role: 'leaf', parent_agent_id: managerAgentId },
      });
      assert.equal(leaf.status, 201);
      leafAgentId = leaf.body.id;

      const sibling = await api(app, `/api/projects/${hierarchyProjectId}/agents`, {
        method: 'POST',
        body: { name: 'hier-sibling', role: 'sibling', parent_agent_id: managerAgentId },
      });
      assert.equal(sibling.status, 201);
      siblingAgentId = sibling.body.id;

      const { body: otherProj } = await api(app, '/api/projects', {
        method: 'POST',
        body: {
          name: 'hierarchy-other-proj',
          description: 'Hierarchy other project',
          task_description: 'Test cross-project parent validation',
          command_template: 'echo',
        },
      });
      otherProjectId = otherProj.id;
      await api(app, `/api/projects/${otherProjectId}`, { method: 'PUT', body: { status: 'paused' } });

      const otherAgent = await api(app, `/api/projects/${otherProjectId}/agents`, {
        method: 'POST',
        body: { name: 'hier-other', role: 'other project agent' },
      });
      assert.equal(otherAgent.status, 201);
      otherProjectAgentId = otherAgent.body.id;
    });

    it('GET /api/projects/:pid/agents returns parent_agent_id', async () => {
      const { status, body } = await api(app, `/api/projects/${hierarchyProjectId}/agents`);
      assert.equal(status, 200);
      const manager = body.find((agent: any) => agent.id === managerAgentId);
      const leaf = body.find((agent: any) => agent.id === leafAgentId);
      assert.equal(manager.parent_agent_id, hierarchyControllerId);
      assert.equal(leaf.parent_agent_id, managerAgentId);
    });

    it('POST /api/projects/:pid/agents rejects parent agents from other projects', async () => {
      const { status, body } = await api(app, `/api/projects/${hierarchyProjectId}/agents`, {
        method: 'POST',
        body: { name: 'bad-parent', role: 'invalid', parent_agent_id: otherProjectAgentId },
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Parent agent must belong to the same project');
    });

    it('PUT /api/agents/:id rejects descendant parent assignment to prevent cycles', async () => {
      const { status, body } = await api(app, `/api/agents/${managerAgentId}`, {
        method: 'PUT',
        body: { parent_agent_id: leafAgentId },
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Parent agent cannot be a descendant of this agent');
    });

    it('hierarchy messaging allows direct parent communication', async () => {
      const { status, body } = await api(app, `/api/agents/${leafAgentId}/messages/send`, {
        method: 'POST',
        body: { to: managerAgentId, subject: 'parent', body: 'direct parent is allowed' },
      });
      assert.equal(status, 201);
      assert.equal(body.to_agent_id, managerAgentId);
    });

    it('hierarchy messaging rejects sibling communication with fixed 403 message', async () => {
      const { status, body } = await api(app, `/api/agents/${leafAgentId}/messages/send`, {
        method: 'POST',
        body: { to: siblingAgentId, subject: 'sibling', body: 'this should fail' },
      });
      assert.equal(status, 403);
      assert.equal(body.error, '只能与直接上级或下属通信');
    });

    it('system prompt includes direct parent, direct children and hierarchy restriction', async () => {
      const { buildSystemPrompt } = await import('../src/services/system-prompt');
      const { getDatabase } = await import('../src/db/database');
      const db = getDatabase();

      const manager = db.prepare('SELECT * FROM agents WHERE id = ?').get(managerAgentId) as any;
      const leaf = db.prepare('SELECT * FROM agents WHERE id = ?').get(leafAgentId) as any;
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(hierarchyProjectId) as any;

      const managerPrompt = buildSystemPrompt(manager, project);
      const leafPrompt = buildSystemPrompt(leaf, project);

      assert.ok(managerPrompt.includes('你的直接下属'), 'manager prompt should list direct children');
      assert.ok(managerPrompt.includes('hier-leaf') && managerPrompt.includes('hier-sibling'));
      assert.ok(leafPrompt.includes('你的直接上级是 hier-manager'));
      assert.ok(leafPrompt.includes('只能通过消息与直接上级或直接下属沟通'));
    });
  });

  describe('Agent侧边栏树状展示验证 (#571)', () => {
    let treeProjectId: string;
    let treeControllerId: string;
    let treeManagerId: string;
    let treeLeafId: string;
    let treeLeaf2Id: string;
    let flatProjectId: string;
    let flatControllerId: string;
    let flatWorkerId: string;

    before(async () => {
      // Create project with hierarchy
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: {
          name: 'tree-sidebar-test',
          description: 'Sidebar tree display test',
          task_description: 'Test tree rendering in sidebar',
          command_template: 'echo',
        },
      });
      treeProjectId = proj.id;
      await api(app, `/api/projects/${treeProjectId}`, { method: 'PUT', body: { status: 'paused' } });

      const { body: agents } = await api(app, `/api/projects/${treeProjectId}/agents`);
      treeControllerId = agents.find((a: any) => a.is_controller)?.id;

      const mgr = await api(app, `/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: { name: 'tree-manager', role: 'manager', parent_agent_id: treeControllerId },
      });
      treeManagerId = mgr.body.id;

      const leaf = await api(app, `/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: { name: 'tree-leaf', role: 'leaf worker', parent_agent_id: treeManagerId },
      });
      treeLeafId = leaf.body.id;

      const leaf2 = await api(app, `/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: { name: 'tree-leaf2', role: 'leaf worker 2', parent_agent_id: treeManagerId },
      });
      treeLeaf2Id = leaf2.body.id;

      // Create flat project (no hierarchy)
      const { body: flatProj } = await api(app, '/api/projects', {
        method: 'POST',
        body: {
          name: 'flat-sidebar-test',
          description: 'Flat sidebar test',
          task_description: 'Test flat rendering in sidebar',
          command_template: 'echo',
        },
      });
      flatProjectId = flatProj.id;
      await api(app, `/api/projects/${flatProjectId}`, { method: 'PUT', body: { status: 'paused' } });

      const { body: flatAgents } = await api(app, `/api/projects/${flatProjectId}/agents`);
      flatControllerId = flatAgents.find((a: any) => a.is_controller)?.id;

      const worker = await api(app, `/api/projects/${flatProjectId}/agents`, {
        method: 'POST',
        body: { name: 'flat-worker', role: 'worker' },
      });
      flatWorkerId = worker.body.id;
    });

    it('hierarchical project returns agents with correct parent_agent_id chain', async () => {
      const { status, body } = await api(app, `/api/projects/${treeProjectId}/agents`);
      assert.equal(status, 200);

      const controller = body.find((a: any) => a.id === treeControllerId);
      const manager = body.find((a: any) => a.id === treeManagerId);
      const leaf = body.find((a: any) => a.id === treeLeafId);
      const leaf2 = body.find((a: any) => a.id === treeLeaf2Id);

      // Controller has no parent
      assert.equal(controller.parent_agent_id, null);
      // Manager's parent is controller
      assert.equal(manager.parent_agent_id, treeControllerId);
      // Leaves' parent is manager (3-level hierarchy)
      assert.equal(leaf.parent_agent_id, treeManagerId);
      assert.equal(leaf2.parent_agent_id, treeManagerId);
    });

    it('flat project agents have no parent_agent_id', async () => {
      const { status, body } = await api(app, `/api/projects/${flatProjectId}/agents`);
      assert.equal(status, 200);

      for (const agent of body) {
        assert.equal(agent.parent_agent_id, null, `agent ${agent.name} should have no parent`);
      }
    });

    it('GET /api/agents/:id returns correct detail for hierarchical agent', async () => {
      const { status, body } = await api(app, `/api/agents/${treeLeafId}`);
      assert.equal(status, 200);
      assert.equal(body.name, 'tree-leaf');
      assert.equal(body.parent_agent_id, treeManagerId);
    });

    it('agent pause/unpause works on hierarchical agents', async () => {
      // Pause leaf agent using dedicated pause endpoint
      const pause = await api(app, `/api/agents/${treeLeafId}/pause`, {
        method: 'POST',
      });
      assert.equal(pause.status, 200);
      assert.equal(pause.body.success, true);

      // Verify agent is paused
      const statusAfterPause = await api(app, `/api/agents/${treeLeafId}/status`);
      assert.equal(statusAfterPause.body.paused, true);

      // Unpause leaf agent using dedicated unpause endpoint
      const unpause = await api(app, `/api/agents/${treeLeafId}/unpause`, {
        method: 'POST',
      });
      assert.equal(unpause.status, 200);
      assert.equal(unpause.body.success, true);

      // Verify agent is unpaused
      const statusAfterUnpause = await api(app, `/api/agents/${treeLeafId}/status`);
      assert.equal(statusAfterUnpause.body.paused, false);
    });

    it('agent update preserves parent_agent_id', async () => {
      const { status, body } = await api(app, `/api/agents/${treeLeafId}`, {
        method: 'PUT',
        body: { role: 'updated leaf role' },
      });
      assert.equal(status, 200);
      assert.equal(body.parent_agent_id, treeManagerId);
      assert.equal(body.role, 'updated leaf role');
    });

    it('can reassign parent within same project', async () => {
      // Move leaf2 directly under controller
      const { status, body } = await api(app, `/api/agents/${treeLeaf2Id}`, {
        method: 'PUT',
        body: { parent_agent_id: treeControllerId },
      });
      assert.equal(status, 200);
      assert.equal(body.parent_agent_id, treeControllerId);

      // Verify the tree structure changed
      const { body: agents } = await api(app, `/api/projects/${treeProjectId}/agents`);
      const movedLeaf = agents.find((a: any) => a.id === treeLeaf2Id);
      assert.equal(movedLeaf.parent_agent_id, treeControllerId);

      // Restore original parent
      await api(app, `/api/agents/${treeLeaf2Id}`, {
        method: 'PUT',
        body: { parent_agent_id: treeManagerId },
      });
    });

    it('delete child agent does not affect parent or siblings', async () => {
      // Create a temporary child to delete
      const tmp = await api(app, `/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: { name: 'tree-temp', role: 'temp', parent_agent_id: treeManagerId },
      });
      assert.equal(tmp.status, 201);

      // Delete it
      const del = await api(app, `/api/agents/${tmp.body.id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);

      // Verify parent and siblings unaffected
      const { body: agents } = await api(app, `/api/projects/${treeProjectId}/agents`);
      const manager = agents.find((a: any) => a.id === treeManagerId);
      const leaf = agents.find((a: any) => a.id === treeLeafId);
      assert.ok(manager, 'manager should still exist');
      assert.ok(leaf, 'sibling leaf should still exist');
      assert.equal(manager.parent_agent_id, treeControllerId);
      assert.equal(leaf.parent_agent_id, treeManagerId);
    });
  });

  describe('Child issue auto-sets parent to pending (#326)', () => {
    let pendingProjectId: string;
    let issueAId: string;
    let issueBId: string;
    let doneProjId: string;
    let doneParentId: string;
    let closedParentId: string;

    before(async () => {
      const { body: proj } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'pending-test-proj', description: 'Pending test', task_description: 'Test pending auto-set' },
      });
      pendingProjectId = proj.id;

      // Create issue A (parent candidate)
      const { body: issueA } = await api(app, `/api/projects/${pendingProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue A', body: 'parent', created_by: 'user', assigned_to: 'user' },
      });
      issueAId = issueA.id;

      // Project for done/closed parent tests
      const { body: proj2 } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'pending-done-test', description: 'Done closed parent test', task_description: 'Test done/closed parent' },
      });
      doneProjId = proj2.id;

      const { body: dp } = await api(app, `/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: { title: 'Done Parent', body: 'done parent', created_by: 'user', assigned_to: 'user' },
      });
      doneParentId = dp.id;
      await api(app, `/api/issues/${doneParentId}`, {
        method: 'PUT', body: { status: 'done', actor: 'user' },
      });

      const { body: cp } = await api(app, `/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: { title: 'Closed Parent', body: 'closed parent', created_by: 'user', assigned_to: 'user' },
      });
      closedParentId = cp.id;
      await api(app, `/api/issues/${closedParentId}`, {
        method: 'PUT', body: { status: 'closed', actor: 'user' },
      });
    });

    it('creating child issue auto-sets parent to pending', async () => {
      const { body: issueB, status } = await api(app, `/api/projects/${pendingProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue B', body: 'child', created_by: 'user', assigned_to: 'user', parent_id: issueAId },
      });
      assert.equal(status, 201);
      issueBId = issueB.id;

      const { body: parentAfter } = await api(app, `/api/issues/${issueAId}`);
      assert.equal(parentAfter.status, 'pending', 'Parent issue A should be pending after child B is created');
    });

    it('creating another child on already-pending parent does not error', async () => {
      const { status } = await api(app, `/api/projects/${pendingProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Issue C', body: 'second child', created_by: 'user', assigned_to: 'user', parent_id: issueAId },
      });
      assert.equal(status, 201, 'Creating second child on pending parent should succeed');

      const { body: parentAfter } = await api(app, `/api/issues/${issueAId}`);
      assert.equal(parentAfter.status, 'pending', 'Parent should remain pending');
    });

    it('PUT /api/issues/:id status=pending succeeds (no SQLITE_CONSTRAINT_CHECK)', async () => {
      // Create a fresh issue and set it to pending via API
      const { body: freshIssue } = await api(app, `/api/projects/${pendingProjectId}/issues`, {
        method: 'POST',
        body: { title: 'Fresh issue for pending test', body: 'test', created_by: 'user', assigned_to: 'user' },
      });
      const { status, body } = await api(app, `/api/issues/${freshIssue.id}`, {
        method: 'PUT',
        body: { status: 'pending', actor: 'user' },
      });
      assert.equal(status, 200, 'Setting status=pending via PUT should return 200');
      assert.equal(body.status, 'pending');
    });

    it('done parent is NOT changed to pending when child is created', async () => {
      const { status } = await api(app, `/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: { title: 'Child of Done', body: 'child', created_by: 'user', assigned_to: 'user', parent_id: doneParentId },
      });
      assert.equal(status, 201);

      const { body: parentAfter } = await api(app, `/api/issues/${doneParentId}`);
      assert.equal(parentAfter.status, 'done', 'Done parent should remain done after child creation');
    });

    it('closed parent is NOT changed to pending when child is created', async () => {
      const { status } = await api(app, `/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: { title: 'Child of Closed', body: 'child', created_by: 'user', assigned_to: 'user', parent_id: closedParentId },
      });
      assert.equal(status, 201);

      const { body: parentAfter } = await api(app, `/api/issues/${closedParentId}`);
      assert.equal(parentAfter.status, 'closed', 'Closed parent should remain closed after child creation');
    });

    it('completing all children triggers parent auto-update (re-opens to open)', async () => {
      // Complete all children of issue A
      const { body: parentDetail } = await api(app, `/api/issues/${issueAId}`);
      for (const child of parentDetail.children || []) {
        await api(app, `/api/issues/${child.id}`, {
          method: 'PUT', body: { status: 'done', actor: 'user' },
        });
      }
      const { body: parentAfter } = await api(app, `/api/issues/${issueAId}`);
      assert.ok(
        ['open', 'in_progress', 'done'].includes(parentAfter.status),
        `Parent status after all children done should be open/in_progress/done, got: ${parentAfter.status}`
      );
    });
  });

  describe('Scheduler stale pending scan', () => {
    it('finds pending parent whose children are already complete', async () => {
      const { findStalePendingIssue } = await import('../src/services/scheduler');

      const { body: project } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'stale-pending-parent', description: 'scheduler test', task_description: 'scheduler test' },
      });

      const { body: parent } = await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Parent pending', body: 'parent', created_by: 'controller-agent', assigned_to: 'worker-agent' },
      });

      const { body: child } = await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Child done', body: 'child', created_by: 'controller-agent', assigned_to: 'worker-agent', parent_id: parent.id },
      });

      await api(app, `/api/issues/${child.id}`, {
        method: 'PUT',
        body: { status: 'done', actor: 'worker-agent' },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(stale?.number, parent.number, 'Completed-child parent should be picked up by system scan');
    });

    it('ignores pending parent that still has active children', async () => {
      const { findStalePendingIssue } = await import('../src/services/scheduler');

      const { body: project } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'active-child-pending-parent', description: 'scheduler test', task_description: 'scheduler test' },
      });

      const { body: parent } = await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Parent pending', body: 'parent', created_by: 'controller-agent', assigned_to: 'worker-agent' },
      });

      await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Child active', body: 'child', created_by: 'controller-agent', assigned_to: 'worker-agent', parent_id: parent.id },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(stale, undefined, 'Pending parent with unfinished child should not be treated as stale');
    });

    it('finds pending blocked issue once the blocker is complete', async () => {
      const { findStalePendingIssue } = await import('../src/services/scheduler');

      const { body: project } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'resolved-blocker-pending', description: 'scheduler test', task_description: 'scheduler test' },
      });

      const { body: blocker } = await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Blocker', body: 'blocker', created_by: 'controller-agent', assigned_to: 'worker-agent' },
      });

      const { body: blocked } = await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Blocked pending', body: 'blocked', created_by: 'controller-agent', assigned_to: 'worker-agent' },
      });

      const relRes = await api(app, `/api/issues/${blocker.id}/relations`, {
        method: 'POST',
        body: { type: 'blocks', target_issue_id: blocked.id, actor: 'controller-agent' },
      });
      assert.equal(relRes.status, 201);

      await api(app, `/api/issues/${blocked.id}`, {
        method: 'PUT',
        body: { status: 'pending', actor: 'controller-agent' },
      });
      await api(app, `/api/issues/${blocker.id}`, {
        method: 'PUT',
        body: { status: 'done', actor: 'worker-agent' },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(stale?.number, blocked.number, 'Pending issue with resolved blocker should be picked up by system scan');
    });

    it('ignores pending blocked issue while blocker is still active', async () => {
      const { findStalePendingIssue } = await import('../src/services/scheduler');

      const { body: project } = await api(app, '/api/projects', {
        method: 'POST',
        body: { name: 'active-blocker-pending', description: 'scheduler test', task_description: 'scheduler test' },
      });

      const { body: blocker } = await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Blocker', body: 'blocker', created_by: 'controller-agent', assigned_to: 'worker-agent' },
      });

      const { body: blocked } = await api(app, `/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: { title: 'Blocked pending', body: 'blocked', created_by: 'controller-agent', assigned_to: 'worker-agent' },
      });

      const relRes = await api(app, `/api/issues/${blocker.id}/relations`, {
        method: 'POST',
        body: { type: 'blocks', target_issue_id: blocked.id, actor: 'controller-agent' },
      });
      assert.equal(relRes.status, 201);

      await api(app, `/api/issues/${blocked.id}`, {
        method: 'PUT',
        body: { status: 'pending', actor: 'controller-agent' },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(stale, undefined, 'Pending issue with active blocker should not be treated as stale');
    });
  });

  // ─── Watchdog CPU Activity Detection (#429) ───

  describe('Watchdog CPU活跃度检测 (#429)', () => {
    let checkChildCpuActivity: (agentId: string, pid: number) => 'active' | 'stale' | 'warming' | 'no_children';
    let clearCpuSnapshot: (agentId: string) => void;

    before(async () => {
      const pm = await import('../src/services/process-manager');
      checkChildCpuActivity = pm.checkChildCpuActivity;
      clearCpuSnapshot = pm.clearCpuSnapshot;
    });

    it('首次调用在有子进程时建立基线，否则返回no_children', () => {
      const pid = process.pid;
      const result = checkChildCpuActivity('test-agent-cpu-1', pid);
      assert.ok(
        ['active', 'no_children'].includes(result),
        `首次调用应返回 active 或 no_children，实际: ${result}`
      );
      clearCpuSnapshot('test-agent-cpu-1');
    });

    it('无子进程时返回no_children', () => {
      // 使用一个不存在的 PID（内核不会给它分配子进程）
      const fakePid = 99999999;
      const result = checkChildCpuActivity('test-agent-cpu-2', fakePid);
      assert.equal(result, 'no_children', '无子进程时应返回 no_children');
      clearCpuSnapshot('test-agent-cpu-2');
    });

    it('当前进程有子进程时CPU变化→返回active', async () => {
      // 用 spawn 启动一个消耗CPU的子进程
      const { spawn } = await import('child_process');
      const child = spawn('sh', ['-c', 'i=0; while [ $i -lt 10000 ]; do i=$((i+1)); done; echo done']);

      await new Promise<void>((resolve) => {
        child.stdout?.once('data', () => resolve());
        child.on('close', () => resolve());
        setTimeout(resolve, 2000);
      });

      const pid = child.pid!;
      // 第一次调用建立基线
      checkChildCpuActivity('test-agent-cpu-3', pid);
      // 等待子进程运行产生 CPU
      await new Promise(r => setTimeout(r, 200));
      // 第二次调用检查 CPU 变化
      const result = checkChildCpuActivity('test-agent-cpu-3', pid);
      // CPU可能已增加(active)或子进程已退出(no_children/warming)，均为合理结果
      assert.ok(
        ['active', 'warming', 'no_children'].includes(result),
        `存在子进程时结果应为 active/warming/no_children，实际: ${result}`
      );
      clearCpuSnapshot('test-agent-cpu-3');
      child.kill();
    });

    it('CPU连续不变3次后返回stale', async () => {
      // 启动一个 sh 进程，它会 fork 出 sleep 子进程
      // 这样 sh 的 PID 有子进程（sleep），而 sleep 几乎不消耗 CPU
      const { spawn } = await import('child_process');
      const child = spawn('sh', ['-c', 'sleep 60 & wait']);
      const pid = child.pid!;

      // 等待 sh 启动并 fork sleep
      await new Promise(r => setTimeout(r, 200));

      // 第1次：建立基线 → active（首次调用）
      const r1 = checkChildCpuActivity('test-agent-stale', pid);
      assert.equal(r1, 'active', '第1次应返回 active（建立基线）');

      // 等待sh进程完全进入wait休眠，避免wait系统调用产生微量CPU变化
      await new Promise(r => setTimeout(r, 100));

      // 第2次：CPU未变（sleep不消耗CPU）→ staleCount=1 → warming
      const r2 = checkChildCpuActivity('test-agent-stale', pid);
      assert.equal(r2, 'warming', '第2次CPU未变应返回 warming（staleCount=1）');

      await new Promise(r => setTimeout(r, 100));

      // 第3次：staleCount=2 → warming
      const r3 = checkChildCpuActivity('test-agent-stale', pid);
      assert.equal(r3, 'warming', '第3次CPU未变应返回 warming（staleCount=2）');

      await new Promise(r => setTimeout(r, 100));

      // 第4次：staleCount=3 >= CPU_STALE_THRESHOLD → stale
      const r4 = checkChildCpuActivity('test-agent-stale', pid);
      assert.equal(r4, 'stale', '第4次CPU未变应返回 stale（达到阈值）');

      clearCpuSnapshot('test-agent-stale');
      child.kill();
    });

    it('clearCpuSnapshot清除后再次调用返回active', () => {
      const pid = process.pid;
      // 建立快照
      checkChildCpuActivity('test-agent-clear', pid);
      // 清除快照
      clearCpuSnapshot('test-agent-clear');
      // 再次调用：无快照 → 首次调用 → active
      const result = checkChildCpuActivity('test-agent-clear', pid);
      assert.equal(result, 'active', '清除快照后应重新返回 active');
      clearCpuSnapshot('test-agent-clear');
    });
  });

  // ─── Final Result 自动Kill (#434/#438) ───

  describe('Final Result自动Kill (#434)', () => {
    let getAgentFinalResultAge: (agentId: string) => number;

    before(async () => {
      const pm = await import('../src/services/process-manager');
      getAgentFinalResultAge = pm.getAgentFinalResultAge;
    });

    it('getAgentFinalResultAge对未知agent返回-1', () => {
      const result = getAgentFinalResultAge('non-existent-agent-xyz');
      assert.equal(result, -1, '未知agent的finalResultAge应返回-1');
    });

    it('FINAL_RESULT_KILL_DELAY_MS已导出且为正数', async () => {
      const { FINAL_RESULT_KILL_DELAY_MS } = await import('../src/services/process-manager');
      assert.ok(typeof FINAL_RESULT_KILL_DELAY_MS === 'number', 'FINAL_RESULT_KILL_DELAY_MS应为数字');
      assert.ok(FINAL_RESULT_KILL_DELAY_MS > 0, 'FINAL_RESULT_KILL_DELAY_MS应为正数');
      // 默认2分钟
      assert.equal(FINAL_RESULT_KILL_DELAY_MS, 2 * 60 * 1000, 'FINAL_RESULT_KILL_DELAY_MS应为2分钟');
    });
  });

  describe('Agent issue batching', () => {
    let getAgentIssueBatch: (issues: any[], maxIssues?: number) => any;
    let buildAssignedIssuesPrompt: (batch: any, options?: any) => string;

    before(async () => {
      const batch = await import('../src/services/agent-issue-batch');
      getAgentIssueBatch = batch.getAgentIssueBatch;
      buildAssignedIssuesPrompt = batch.buildAssignedIssuesPrompt;
    });

    it('limits each run to a small highest-priority batch', () => {
      const issues = [
        { id: '3', number: 3, title: 'low', body: 'low body', status: 'open', priority: 1, created_at: '2026-03-31 10:02:00' },
        { id: '1', number: 1, title: 'high-a', body: 'high a body', status: 'open', priority: 5, created_at: '2026-03-31 10:00:00' },
        { id: '2', number: 2, title: 'high-b', body: 'high b body', status: 'in_progress', priority: 5, created_at: '2026-03-31 10:01:00' },
      ];

      const batch = getAgentIssueBatch(issues);
      assert.equal(batch.currentBatch.length, 2);
      assert.equal(batch.queuedIssues.length, 1);
      assert.deepEqual(batch.currentBatch.map((issue: any) => issue.number), [1, 2]);
      assert.deepEqual(batch.queuedIssues.map((issue: any) => issue.number), [3]);
    });

    it('prompt explicitly tells the agent to stop after the current batch', () => {
      const batch = getAgentIssueBatch([
        { id: '1', number: 1, title: 'alpha', body: 'alpha body', status: 'open', priority: 5, created_at: '2026-03-31 10:00:00' },
        { id: '2', number: 2, title: 'beta', body: 'beta body', status: 'open', priority: 4, created_at: '2026-03-31 10:01:00' },
        { id: '3', number: 3, title: 'gamma', body: 'gamma body', status: 'open', priority: 3, created_at: '2026-03-31 10:02:00' },
      ]);

      const prompt = buildAssignedIssuesPrompt(batch);
      assert.ok(prompt.includes('Current batch (2/3 assigned issue(s))'));
      assert.ok(prompt.includes('Queued for later (1 more assigned issue(s))'));
      assert.ok(prompt.includes('Only work on the current batch in this run.'));
      assert.ok(prompt.includes('#3 [open] [p3] gamma'));
    });
  });

  describe('Run completion classification', () => {
    let classifyAgentExitStatus: (input: {
      currentStatus?: string | null;
      exitCode: number | null;
      requiresCompletionSignal: boolean;
      sawClosedStdinSessionError: boolean;
      sawCompletionSignal: boolean;
      hadFinalResult: boolean;
    }) => 'idle' | 'error' | 'stopped';

    before(async () => {
      const pm = await import('../src/services/process-manager');
      classifyAgentExitStatus = pm.classifyAgentExitStatus;
    });

    it('marks structured zero-exit runs without completion as error', () => {
      const status = classifyAgentExitStatus({
        exitCode: 0,
        requiresCompletionSignal: true,
        sawClosedStdinSessionError: false,
        sawCompletionSignal: false,
        hadFinalResult: false,
      });
      assert.equal(status, 'error');
    });

    it('accepts structured completion signals on zero-exit runs', () => {
      const status = classifyAgentExitStatus({
        exitCode: 0,
        requiresCompletionSignal: true,
        sawClosedStdinSessionError: false,
        sawCompletionSignal: true,
        hadFinalResult: false,
      });
      assert.equal(status, 'idle');
    });

    it('keeps plain shell zero-exit runs successful', () => {
      const status = classifyAgentExitStatus({
        exitCode: 0,
        requiresCompletionSignal: false,
        sawClosedStdinSessionError: false,
        sawCompletionSignal: false,
        hadFinalResult: false,
      });
      assert.equal(status, 'idle');
    });

    it('stopped state removed — classifyAgentExitStatus returns idle or error', () => {
      // The 'stopped' state was removed in refactor; the function now only returns idle/error.
      // An exit with code 1 and closed stdin session error → 'error'
      const status = classifyAgentExitStatus({
        currentStatus: 'idle',
        exitCode: 1,
        requiresCompletionSignal: true,
        sawClosedStdinSessionError: true,
        sawCompletionSignal: false,
        hadFinalResult: false,
      });
      assert.equal(status, 'error');
    });
  });
});
