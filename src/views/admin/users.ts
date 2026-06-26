import { h, html } from '../html';
import { renderAdminNav, renderAdminPageHeader } from './nav';
import type { PublicUser } from '../../services/auth/users';

/** "X ago" / "Never" — port of the client timeAgo used by users-tab.js. */
function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  const then = new Date(dateStr.replace(' ', 'T') + (dateStr.endsWith('Z') ? '' : 'Z')).getTime();
  if (isNaN(then)) return '-';
  const diff = Date.now() - then;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

/**
 * Full <main> inner content for the users admin page. The user list is loaded
 * via htmx on page load; add-user and reset-password use <dialog> modals
 * loaded by htmx.
 */
export function renderUsersPage(path: string): string {
  return h`<div id="admin-view-panel" class="dashboard-view dashboard-view-admin">
  ${html(renderAdminPageHeader())}
  ${html(renderAdminNav(path))}
  <div class="admin-page-bar">
    <h3>Users</h3>
    <button class="btn btn-primary btn-sm" hx-get="/ui/admin/users/add" hx-target="#modal-mount" hx-swap="innerHTML">+ Add User</button>
  </div>
  <div id="users-list" hx-get="/ui/admin/users/list" hx-trigger="load" hx-swap="innerHTML">
    <div class="empty-state">Loading users...</div>
  </div>
  <div id="modal-mount"></div>
</div>`;
}

export interface UserRowOptions {
  currentUserId: string;
}

/** A single user table row. Self-row shows "you" instead of action buttons. */
export function renderUserRow(user: PublicUser, opts: UserRowOptions): string {
  const isSelf = user.id === opts.currentUserId;
  const actions = isSelf
    ? html(h`<span class="text-secondary">you</span>`)
    : html(
        h`<button class="btn btn-sm" hx-get="/ui/admin/users/${user.id}/reset-password" hx-target="#modal-mount" hx-swap="innerHTML">Reset PW</button>` +
          h`<button class="btn btn-sm btn-danger" hx-delete="/ui/admin/users/${user.id}" hx-confirm='Delete user "${user.username}"? This cannot be undone.' hx-target="#users-list" hx-swap="innerHTML">Delete</button>`,
      );

  const roleSelect = isSelf
    ? h`<select class="data-table-select" disabled><option value="member"${user.role === 'member' ? ' selected' : ''}>member</option><option value="admin"${user.role === 'admin' ? ' selected' : ''}>admin</option></select>`
    : h`<select class="data-table-select" name="role" hx-put="/ui/admin/users/${user.id}/role" hx-trigger="change" hx-swap="none"><option value="member"${user.role === 'member' ? ' selected' : ''}>member</option><option value="admin"${user.role === 'admin' ? ' selected' : ''}>admin</option></select>`;

  return h`<tr>
  <td>${user.username}</td>
  <td>${user.display_name || '-'}</td>
  <td>${html(roleSelect)}</td>
  <td class="text-secondary">${user.created_at ? timeAgo(user.created_at) : '-'}</td>
  <td class="text-secondary">${user.last_login_at ? timeAgo(user.last_login_at) : 'Never'}</td>
  <td class="data-table-actions">${actions}</td>
</tr>`;
}

/** The user list fragment swapped into #users-list. */
export function renderUserList(users: PublicUser[], currentUserId: string): string {
  const rows = users.length
    ? users.map((u) => renderUserRow(u, { currentUserId })).join('')
    : '<tr><td colspan="6" class="command-profiles-empty">No users yet.</td></tr>';

  return h`<div class="data-table-wrap"><table class="data-table admin-users-table">
  <thead><tr>
    <th>Username</th>
    <th>Display Name</th>
    <th>Role</th>
    <th>Created</th>
    <th>Last Login</th>
    <th>Actions</th>
  </tr></thead>
  <tbody>${html(rows)}</tbody>
</table></div>`;
}

/** Add-user <dialog> fragment loaded into #modal-mount. */
export function renderAddUserDialog(): string {
  return h`<dialog open class="admin-modal">
  <div class="admin-modal-card">
    <h3 class="admin-modal-title">Add User</h3>
    <form class="admin-modal-form" hx-post="/ui/admin/users/add" hx-target="#users-list" hx-swap="innerHTML">
      <label class="admin-modal-label">Username<input type="text" name="username" class="admin-modal-input" required></label>
      <label class="admin-modal-label">Display Name<input type="text" name="display_name" class="admin-modal-input"></label>
      <label class="admin-modal-label">Password<input type="password" name="password" class="admin-modal-input" required></label>
      <label class="admin-modal-label">Role
        <select name="role" class="admin-modal-input">
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <div class="admin-modal-actions">
        <button type="button" class="btn btn-sm" onclick="document.getElementById('modal-mount').innerHTML=''">Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm">Add User</button>
      </div>
    </form>
  </div>
</dialog>`;
}

/** Reset-password <dialog> fragment loaded into #modal-mount. */
export function renderResetPasswordDialog(userId: string, username: string): string {
  return h`<dialog open class="admin-modal">
  <div class="admin-modal-card">
    <h3 class="admin-modal-title">Reset Password</h3>
    <form class="admin-modal-form" hx-post="/ui/admin/users/${userId}/reset-password" hx-target="#modal-mount" hx-swap="innerHTML">
      <div class="admin-modal-info">User: ${username}</div>
      <label class="admin-modal-label">New Password<input type="password" name="password" class="admin-modal-input" required></label>
      <div class="admin-modal-actions">
        <button type="button" class="btn btn-sm" onclick="document.getElementById('modal-mount').innerHTML=''">Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm">Reset</button>
      </div>
    </form>
  </div>
</dialog>`;
}

/** Success fragment returned after reset-password — closes the modal + toast. */
export function renderResetPasswordSuccess(): string {
  return h`<script>
  document.getElementById('modal-mount').innerHTML='';
  document.body.dispatchEvent(new CustomEvent('showToast', { detail: 'Password reset successfully' }));
</script>`;
}
