import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiTestHarness, type ApiTestHarness } from './helpers';

describe('Default admin bootstrap', () => {
  let ctx: ApiTestHarness;
  let previousEnabled: string | undefined;
  let previousPassword: string | undefined;

  before(async () => {
    previousEnabled = process.env.HAICO_DEFAULT_ADMIN;
    previousPassword = process.env.HAICO_DEFAULT_ADMIN_PASSWORD;
    process.env.HAICO_DEFAULT_ADMIN = 'true';
    process.env.HAICO_DEFAULT_ADMIN_PASSWORD = 'fixed-dev-password';
    ctx = await createApiTestHarness('default-admin');
  });

  after(async () => {
    await ctx.close();
    if (previousEnabled === undefined) delete process.env.HAICO_DEFAULT_ADMIN;
    else process.env.HAICO_DEFAULT_ADMIN = previousEnabled;
    if (previousPassword === undefined) delete process.env.HAICO_DEFAULT_ADMIN_PASSWORD;
    else process.env.HAICO_DEFAULT_ADMIN_PASSWORD = previousPassword;
  });

  it('creates the fixed default admin user and allows normal login', async () => {
    const login = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: {
        username: 'haico_default_admin',
        password: 'fixed-dev-password',
      },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.username, 'haico_default_admin');
    assert.equal(login.body.user.role, 'admin');
  });

  it('redirects login to auto-login while preserving manual password login', async () => {
    const login = await ctx.inject({ url: '/login' });
    assert.equal(login.statusCode, 302);
    assert.equal(login.headers.location, '/auto-login');

    const manualLogin = await ctx.inject({ url: '/login?manual=1' });
    assert.equal(manualLogin.statusCode, 200);
    assert.ok(manualLogin.body.includes('Login'));
  });

  it('serves the auto-login page', async () => {
    const autoLogin = await ctx.inject({ url: '/auto-login' });
    assert.equal(autoLogin.statusCode, 200);
    assert.ok(autoLogin.body.includes('Login as Default Admin'));
    assert.ok(autoLogin.body.includes('/login?manual=1'));
  });

  it('creates a default admin session without a password from localhost', async () => {
    const login = await ctx.api('/api/auth/default-admin-login', {
      method: 'POST',
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(login.body.user.username, 'haico_default_admin');
    assert.equal(login.body.user.role, 'admin');
    assert.ok(String(login.headers['set-cookie']).includes('haico-auth='));
  });

  it('rejects passwordless default admin login from non-localhost addresses', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/default-admin-login',
      remoteAddress: '192.0.2.10',
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /localhost/);
  });

  it('rejects deleting or demoting the default admin', async () => {
    const login = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: {
        username: 'haico_default_admin',
        password: 'fixed-dev-password',
      },
    });
    const users = await ctx.api('/api/auth/users', {
      headers: { cookie: `haico-auth=${login.body.token}` },
    });
    const defaultAdmin = users.body.users.find((user: any) => user.username === 'haico_default_admin');
    assert.ok(defaultAdmin);

    const demote = await ctx.api(`/api/auth/users/${defaultAdmin.id}`, {
      method: 'PUT',
      headers: { cookie: `haico-auth=${login.body.token}` },
      body: { role: 'member' },
    });
    assert.equal(demote.status, 400);

    const remove = await ctx.api(`/api/auth/users/${defaultAdmin.id}`, {
      method: 'DELETE',
      headers: { cookie: `haico-auth=${login.body.token}` },
    });
    assert.equal(remove.status, 400);
  });
});

describe('Default admin passwordless login disabled', () => {
  let ctx: ApiTestHarness;
  let previousEnabled: string | undefined;
  let previousPassword: string | undefined;

  before(async () => {
    previousEnabled = process.env.HAICO_DEFAULT_ADMIN;
    previousPassword = process.env.HAICO_DEFAULT_ADMIN_PASSWORD;
    delete process.env.HAICO_DEFAULT_ADMIN;
    delete process.env.HAICO_DEFAULT_ADMIN_PASSWORD;
    ctx = await createApiTestHarness('default-admin-disabled');
  });

  after(async () => {
    await ctx.close();
    if (previousEnabled === undefined) delete process.env.HAICO_DEFAULT_ADMIN;
    else process.env.HAICO_DEFAULT_ADMIN = previousEnabled;
    if (previousPassword === undefined) delete process.env.HAICO_DEFAULT_ADMIN_PASSWORD;
    else process.env.HAICO_DEFAULT_ADMIN_PASSWORD = previousPassword;
  });

  it('keeps the existing login and auto-login disabled flows', async () => {
    const noUsersLogin = await ctx.inject({ url: '/login' });
    assert.equal(noUsersLogin.statusCode, 302);
    assert.equal(noUsersLogin.headers.location, '/register');

    const autoLogin = await ctx.inject({ url: '/auto-login' });
    assert.equal(autoLogin.statusCode, 302);
    assert.equal(autoLogin.headers.location, '/login');

    const disabled = await ctx.api('/api/auth/default-admin-login', {
      method: 'POST',
    });
    assert.equal(disabled.status, 403);

    const register = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'manual_admin',
        password: 'admin1234',
      },
    });
    assert.equal(register.status, 201);

    const login = await ctx.inject({ url: '/login' });
    assert.equal(login.statusCode, 200);
    assert.ok(login.body.includes('Login'));
  });
});
