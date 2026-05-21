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
