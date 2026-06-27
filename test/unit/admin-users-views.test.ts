import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from '../../src/views/html';
import {
  renderUsersPage,
  renderUserList,
  renderUserRow,
  renderAddUserDialog,
  renderResetPasswordDialog,
  renderResetPasswordSuccess,
} from '../../src/views/admin/users';
import type { PublicUser } from '../../src/services/auth/users';

const sampleUser: PublicUser = {
  id: 'u-1',
  username: 'alice',
  email: '',
  display_name: 'Alice',
  role: 'member',
  created_at: '2026-01-01T00:00:00Z',
  last_login_at: '2026-06-01T00:00:00Z',
};

const adminUser: PublicUser = {
  ...sampleUser,
  id: 'u-admin',
  username: 'admin',
  role: 'admin',
};

describe('renderUsersPage', () => {
  it('wires the list to load via htmx', () => {
    const html = renderToString(renderUsersPage('/admin/users'));
    assert.match(html, /id="users-list"/);
    assert.match(html, /hx-get="\/ui\/admin\/users\/list"/);
    assert.match(html, /hx-trigger="load"/);
  });

  it('wires the add-user button to load the dialog', () => {
    const html = renderToString(renderUsersPage('/admin/users'));
    assert.match(html, /hx-get="\/ui\/admin\/users\/add"/);
    assert.match(html, /hx-target="#modal-mount"/);
  });

  it('marks users nav active', () => {
    const html = renderToString(renderUsersPage('/admin/users'));
    assert.match(html, /href="\/admin\/users" class="active" aria-current="page"/);
  });
});

describe('renderUserRow', () => {
  it('renders action buttons for other users', () => {
    const html = renderToString(renderUserRow(sampleUser, { currentUserId: 'u-admin' }));
    assert.match(html, /hx-get="\/ui\/admin\/users\/u-1\/reset-password"/);
    assert.match(html, /hx-delete="\/ui\/admin\/users\/u-1"/);
    assert.match(html, /hx-confirm='Delete user "alice/);
  });

  it('shows "you" instead of action buttons for self', () => {
    const html = renderToString(renderUserRow(sampleUser, { currentUserId: 'u-1' }));
    // Must render as a real <span>, not escaped text. With h returning
    // HtmlFragment, sub-view composition no longer needs html() wrappers —
    // the outer h recognizes __html and passes it through unescaped.
    assert.match(html, /<span class="text-secondary">you<\/span>/);
    assert.doesNotMatch(html, /&lt;span/);
    assert.doesNotMatch(html, /hx-delete/);
    assert.doesNotMatch(html, /reset-password/);
  });

  it('disables the role select for self', () => {
    const html = renderToString(renderUserRow(sampleUser, { currentUserId: 'u-1' }));
    assert.match(html, /<select class="data-table-select" disabled>/);
  });

  it('wires role change to PUT endpoint for other users', () => {
    const html = renderToString(renderUserRow(sampleUser, { currentUserId: 'u-admin' }));
    assert.match(html, /hx-put="\/ui\/admin\/users\/u-1\/role"/);
    assert.match(html, /hx-trigger="change"/);
  });

  it('marks the current role as selected', () => {
    const html = renderToString(renderUserRow(adminUser, { currentUserId: 'u-other' }));
    assert.match(html, /value="admin" selected/);
    assert.doesNotMatch(html, /value="member" selected/);
  });

  it('escapes HTML in username', () => {
    const malicious: PublicUser = { ...sampleUser, username: '<script>x</script>' };
    const html = renderToString(renderUserRow(malicious, { currentUserId: 'u-admin' }));
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('renderUserList', () => {
  it('renders a table with header', () => {
    const html = renderToString(renderUserList([sampleUser], 'u-admin'));
    assert.match(html, /<table class="data-table admin-users-table"/);
    assert.match(html, /<th>Username<\/th>/);
    assert.match(html, /<th>Actions<\/th>/);
  });

  it('renders empty state when no users', () => {
    const html = renderToString(renderUserList([], 'u-admin'));
    assert.match(html, /No users yet/);
  });
});

describe('renderAddUserDialog', () => {
  it('renders a dialog with form posting to add endpoint', () => {
    const html = renderToString(renderAddUserDialog());
    assert.match(html, /<dialog open class="admin-modal">/);
    assert.match(html, /hx-post="\/ui\/admin\/users\/add"/);
    assert.match(html, /name="username"/);
    assert.match(html, /name="password"/);
    assert.match(html, /name="role"/);
  });
});

describe('renderResetPasswordDialog', () => {
  it('renders a dialog targeting the reset endpoint', () => {
    const html = renderToString(renderResetPasswordDialog('u-1', 'alice'));
    assert.match(html, /<dialog open class="admin-modal">/);
    assert.match(html, /hx-post="\/ui\/admin\/users\/u-1\/reset-password"/);
    assert.match(html, /User: alice/);
    assert.match(html, /name="password"/);
  });
});

describe('renderResetPasswordSuccess', () => {
  it('returns a script that closes the modal and toasts', () => {
    const html = renderToString(renderResetPasswordSuccess());
    assert.match(html, /modal-mount/);
    assert.match(html, /showToast/);
    assert.match(html, /Password reset successfully/);
  });
});
