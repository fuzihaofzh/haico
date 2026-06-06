let currentUser = null;
let users = [];

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user || data;
    }
  } catch { /* ignore */ }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/auth/users');
    if (res.status === 403) {
      document.getElementById('users-list').innerHTML = h`<p style="color:var(--error)">Admin access required.</p>`;
      return;
    }
    const data = await res.json();
    users = data.users || [];
    renderUsers();
  } catch {
    showError('Failed to load users');
  }
}

function renderUsers() {
  const el = document.getElementById('users-list');
  if (!users.length) {
    el.innerHTML = h`<p style="color:var(--text-secondary)">No users yet.</p>`;
    return;
  }
  const rows = users.map(u => {
    const actionButtons = (currentUser && u.id === currentUser.id)
      ? h`<span style="color:var(--text-secondary)">you</span>`
      : h`<button data-action="reset-password" data-user-id="${u.id}" data-username="${u.username}" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;font-family:inherit;margin-right:8px">Reset PW</button>` +
        h`<button data-action="delete-user" data-user-id="${u.id}" data-username="${u.username}" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:12px;font-family:inherit">Delete</button>`;
    return h`<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px">${u.username}</td>
      <td style="padding:8px 12px">${u.display_name || '-'}</td>
      <td style="padding:8px 12px">
        <select data-action="change-role" data-user-id="${u.id}" style="background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px;font-family:inherit"${currentUser && u.id === currentUser.id ? ' disabled' : ''}>
          <option value="member"${u.role==='member'?' selected':''}>member</option>
          <option value="admin"${u.role==='admin'?' selected':''}>admin</option>
        </select>
      </td>
      <td style="padding:8px 12px;color:var(--text-secondary)">${u.created_at ? timeAgo(u.created_at) : '-'}</td>
      <td style="padding:8px 12px;color:var(--text-secondary)">${u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</td>
      <td style="padding:8px 12px;white-space:nowrap">${actionButtons}</td>
    </tr>`;
  }).join('');
  el.innerHTML = h`<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="border-bottom:2px solid var(--border);text-align:left">
      <th style="padding:8px 12px">Username</th>
      <th style="padding:8px 12px">Display Name</th>
      <th style="padding:8px 12px">Role</th>
      <th style="padding:8px 12px">Created</th>
      <th style="padding:8px 12px">Last Login</th>
      <th style="padding:8px 12px">Actions</th>
    </tr></thead>
    <tbody>${html(rows)}</tbody>
  </table>`;
}

async function changeRole(id, role) {
  const res = await fetch('/api/auth/users/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const d = await res.json();
    showError(d.error);
    loadUsers();
  }
}

async function deleteUser(id, name) {
  if (!confirm('Delete user "' + name + '"? This cannot be undone.')) return;
  const res = await fetch('/api/auth/users/' + id, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json();
    showError(d.error);
    return;
  }
  loadUsers();
}

function resetPassword(id, username) {
  document.getElementById('reset-password-user-id').value = id;
  document.getElementById('reset-password-username').textContent = 'User: ' + username;
  document.getElementById('reset-password-new').value = '';
  document.getElementById('reset-password-error').style.display = 'none';
  document.getElementById('reset-password-modal').style.display = 'flex';
}

function setupTableDelegation() {
  const el = document.getElementById('users-list');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.userId;
    const username = btn.dataset.username;
    if (action === 'delete-user') deleteUser(id, username);
    else if (action === 'reset-password') resetPassword(id, username);
  });
  el.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-action="change-role"]');
    if (!sel) return;
    changeRole(sel.dataset.userId, sel.value);
  });
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function setupAddUserModal() {
  const modal = document.getElementById('add-user-modal');
  const btn = document.getElementById('add-user-btn');
  const cancelBtn = document.getElementById('add-user-cancel-btn');
  const form = document.getElementById('add-user-form');

  btn.addEventListener('click', () => {
    modal.style.display = 'flex';
  });

  cancelBtn.addEventListener('click', () => {
    modal.style.display = 'none';
    form.reset();
    document.getElementById('add-user-error').style.display = 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('add-user-error');
    errEl.style.display = 'none';
    const username = document.getElementById('new-username').value;
    const display_name = document.getElementById('new-display-name').value;
    const password = document.getElementById('new-password').value;
    const role = document.getElementById('new-role').value;

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, display_name: display_name || undefined }),
    });
    if (!res.ok) {
      const d = await res.json();
      errEl.textContent = d.error || 'Failed';
      errEl.style.display = 'block';
      return;
    }
    const data = await res.json();
    if (role === 'admin' && data.user) {
      await fetch('/api/auth/users/' + data.user.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
    }
    modal.style.display = 'none';
    form.reset();
    loadUsers();
  });
}

function setupResetPasswordModal() {
  const modal = document.getElementById('reset-password-modal');
  const cancelBtn = document.getElementById('reset-password-cancel-btn');
  const form = document.getElementById('reset-password-form');

  cancelBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('reset-password-user-id').value;
    const password = document.getElementById('reset-password-new').value;
    const errEl = document.getElementById('reset-password-error');
    errEl.style.display = 'none';

    const res = await fetch('/api/auth/users/' + userId + '/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const d = await res.json();
      errEl.textContent = d.error || 'Failed';
      errEl.style.display = 'block';
      return;
    }
    modal.style.display = 'none';
    if (window.showToast) window.showToast('Password reset successfully', 'success');
  });
}

function initUsersTab() {
  setupTableDelegation();
  setupAddUserModal();
  setupResetPasswordModal();
  loadCurrentUser().then(() => loadUsers());
}

// Self-initialize — this file is loaded directly as a page module
initUsersTab();
