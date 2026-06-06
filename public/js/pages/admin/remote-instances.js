/**
 * Remote HAICO Instances — admin settings panel
 *
 * Renders the remote instances table and inline CRUD form.
 * Consumes the existing JSON API at /api/remote-instances.
 * Replaces the former htmx-based server-rendered partials.
 */

import { invalidateDashboardProjects } from '../../shared/dashboard-project-store.js';

// ── Helpers ────────────────────────────────────────────────────────

function remoteStatusLabel(status) {
  if (status === 'ok') return 'Connected';
  if (status === 'error') return 'Needs Review';
  return 'Unchecked';
}

function deriveRemoteInstanceName(baseUrl, fallback = '') {
  const raw = String(baseUrl || '').trim();
  if (!raw) return String(fallback || '').trim();
  try {
    const normalized = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
    const url = new URL(normalized);
    return url.host || String(fallback || '').trim() || raw;
  } catch {
    return String(fallback || '').trim() || raw;
  }
}

// ── Rendering ──────────────────────────────────────────────────────

function renderInstanceRow(instance) {
  return h`
    <tr>
      <td>
        <div class="remote-table-instance">
          <span class="remote-server-dot" data-status="${instance.last_status || 'unknown'}"></span>
          <div>
            <div class="remote-server-label">${instance.name}</div>
            <div class="remote-server-meta-inline">${instance.has_api_token ? 'Signed in' : 'No saved login'}</div>
          </div>
        </div>
      </td>
      <td><div class="remote-server-url">${instance.base_url}</div></td>
      <td>
        <div class="remote-table-status">
          <span class="remote-status-badge" data-status="${instance.last_status || 'unknown'}">${remoteStatusLabel(instance.last_status)}</span>
          <div class="remote-server-meta-inline">${instance.last_checked_at ? `Checked ${instance.last_checked_at}` : 'Never checked'}</div>
          ${instance.last_error ? html(h`<div class="remote-server-meta-inline">${instance.last_error}</div>`) : ''}
        </div>
      </td>
      <td>
        <div class="command-profile-actions">
          <button type="button" class="btn btn-sm" data-edit-instance="${instance.id}">Edit</button>
          <button type="button" class="btn btn-sm" data-check-instance="${instance.id}">Check</button>
          <button type="button" class="btn btn-sm btn-danger" data-delete-instance="${instance.id}">Delete</button>
        </div>
      </td>
    </tr>`;
}

function renderFormRows(editing) {
  const formAction = editing
    ? `/api/remote-instances/${encodeURIComponent(editing.id)}`
    : '/api/remote-instances';
  const primaryAction = editing ? 'Save' : 'Add';
  const rowId = editing ? editing.id : '__new__';

  return h`
    <tr data-remote-instance-row="${rowId}">
      <td colspan="2">
        <form class="remote-inline-form" data-remote-instance-form="${rowId}">
          <input class="command-profile-input remote-inline-url" type="text" name="base_url" value="${editing?.base_url || ''}" placeholder="URL">
          <input class="command-profile-input remote-inline-username" type="text" name="remote_username" value="" placeholder="Username">
          <input class="command-profile-input remote-inline-password" type="password" name="remote_password" value="" placeholder="Password">
        </form>
      </td>
      <td>
        <div class="remote-table-status">
          <div class="remote-server-meta-inline">${editing ? `Editing ${editing.name}` : 'URL / Username / Password'}</div>
          ${editing?.has_api_token ? html(h`<div class="remote-server-meta-inline">Saved login: ${editing.api_token_preview || ''}</div>`) : ''}
        </div>
      </td>
      <td>
        <div class="command-profile-actions">
          <button type="submit" form="remote-instance-form" class="btn btn-sm btn-primary" data-submit-instance="${rowId}">${primaryAction}</button>
          ${editing ? html(h`<button type="button" class="btn btn-sm" data-cancel-edit>Cancel</button>`) : ''}
        </div>
      </td>
    </tr>`;
}

function renderRemoteInstancesPanel(instances, { editingId, error, notice, isAdmin }) {
  if (!isAdmin) {
    return h`<div class="remote-settings-shell"><div class="remote-settings-note">Remote instance configuration is only available to workspace admins.</div></div>`;
  }

  const editing = editingId
    ? instances.find((i) => i.id === editingId) || null
    : null;

  const rows = instances.length
    ? instances.map(renderInstanceRow).join('')
    : '<tr><td colspan="4" class="command-profiles-empty">No remote HAICO instances yet.</td></tr>';

  return h`
    <div class="remote-settings-shell">
      <div class="remote-settings-note">
        Add another HAICO machine here. HAICO will sign in once, store the remote session token on the server, and merge that machine's projects into this dashboard.
      </div>
      ${error ? html(h`<div class="command-profiles-status command-profiles-status-error">${error}</div>`) : ''}
      ${notice ? html(h`<div class="command-profiles-status">${notice}</div>`) : ''}
      <div class="command-profiles-table-wrap data-table-wrap">
        <table class="command-profiles-table remote-instances-table data-table">
          <thead>
            <tr>
              <th>Instance</th>
              <th>URL</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${html(rows)}
            ${html(renderFormRows(editing))}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ── State & API ────────────────────────────────────────────────────

let currentInstances = [];
let editingId = null;
let statusMessage = null;  // { type: 'error'|'notice', text: string }
let isNotAdmin = false;    // set true if API returns 403

async function fetchInstances() {
  const res = await fetch('/api/remote-instances');
  if (res.status === 403) { isNotAdmin = true; return []; }
  if (!res.ok) throw new Error('Failed to load remote instances');
  const data = await res.json();
  return data.instances || [];
}

function refreshView() {
  const container = document.getElementById('remote-instances-settings');
  if (!container) return;
  // Admin page is server-gated; user is admin if this page loads at all.
  // isNotAdmin is only set if the JSON API returns 403 (session expired / role changed).
  container.innerHTML = renderRemoteInstancesPanel(currentInstances, {
    editingId,
    error: statusMessage?.type === 'error' ? statusMessage.text : undefined,
    notice: statusMessage?.type === 'notice' ? statusMessage.text : undefined,
    isAdmin: !isNotAdmin,
  });
}

async function loadAndRender() {
  try {
    currentInstances = await fetchInstances();
    statusMessage = null;
  } catch {
    statusMessage = { type: 'error', text: 'Failed to load remote instances' };
  }
  refreshView();
}

// ── Event handlers ─────────────────────────────────────────────────

function clearStatus() {
  statusMessage = null;
}

async function handleAddSubmit(form) {
  const baseUrl = String(form.base_url?.value || '').trim();
  const remoteUsername = String(form.remote_username?.value || '').trim();
  const remotePassword = String(form.remote_password?.value || '').trim();

  if (!baseUrl) {
    statusMessage = { type: 'error', text: 'base_url is required' };
    refreshView();
    return;
  }

  const body = { base_url: baseUrl, name: deriveRemoteInstanceName(baseUrl) };
  if (remoteUsername) body.remote_username = remoteUsername;
  if (remotePassword) body.remote_password = remotePassword;

  try {
    const res = await fetch('/api/remote-instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to add instance');
    }
    clearStatus();
    await loadAndRender();
    invalidateDashboardProjects({ invalidateRemoteOptions: true });
    if (window.showToast) window.showToast('Remote instance added', 'success');
  } catch (err) {
    statusMessage = { type: 'error', text: err.message };
    refreshView();
  }
}

async function handleEditSubmit(form, instanceId) {
  const baseUrl = String(form.base_url?.value || '').trim();
  const remoteUsername = String(form.remote_username?.value || '').trim();
  const remotePassword = String(form.remote_password?.value || '').trim();

  if (!baseUrl) {
    statusMessage = { type: 'error', text: 'base_url is required' };
    refreshView();
    return;
  }

  const existing = currentInstances.find(i => i.id === instanceId);
  const body = { base_url: baseUrl, name: deriveRemoteInstanceName(baseUrl, existing?.name || '') };
  if (remoteUsername) body.remote_username = remoteUsername;
  if (remotePassword) body.remote_password = remotePassword;

  try {
    const res = await fetch(`/api/remote-instances/${encodeURIComponent(instanceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to update instance');
    }
    editingId = null;
    clearStatus();
    await loadAndRender();
    invalidateDashboardProjects({ invalidateRemoteOptions: true });
    if (window.showToast) window.showToast('Remote instance updated', 'success');
  } catch (err) {
    statusMessage = { type: 'error', text: err.message };
    refreshView();
  }
}

async function handleCheck(instanceId) {
  try {
    const res = await fetch(`/api/remote-instances/${encodeURIComponent(instanceId)}/check`, {
      method: 'POST',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to check instance');
    }
    statusMessage = { type: 'notice', text: 'Remote instance checked' };
    await loadAndRender();
    invalidateDashboardProjects({ invalidateRemoteOptions: true });
  } catch (err) {
    statusMessage = { type: 'error', text: err.message };
    refreshView();
  }
}

async function handleDelete(instanceId) {
  if (!confirm('Delete this remote HAICO instance from Settings?')) return;
  try {
    const res = await fetch(`/api/remote-instances/${encodeURIComponent(instanceId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete instance');
    }
    if (editingId === instanceId) editingId = null;
    clearStatus();
    await loadAndRender();
    invalidateDashboardProjects({ invalidateRemoteOptions: true });
    if (window.showToast) window.showToast('Remote instance deleted', 'success');
  } catch (err) {
    statusMessage = { type: 'error', text: err.message };
    refreshView();
  }
}

// ── DOM event delegation ───────────────────────────────────────────

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-edit-instance],[data-check-instance],[data-delete-instance],[data-cancel-edit],[data-submit-instance]');
  if (!target) return;

  if (target.hasAttribute('data-edit-instance')) {
    editingId = target.getAttribute('data-edit-instance');
    clearStatus();
    refreshView();
    return;
  }

  if (target.hasAttribute('data-cancel-edit')) {
    editingId = null;
    clearStatus();
    refreshView();
    return;
  }

  if (target.hasAttribute('data-check-instance')) {
    handleCheck(target.getAttribute('data-check-instance'));
    return;
  }

  if (target.hasAttribute('data-delete-instance')) {
    handleDelete(target.getAttribute('data-delete-instance'));
    return;
  }

  if (target.hasAttribute('data-submit-instance')) {
    const rowId = target.getAttribute('data-submit-instance');
    const form = document.querySelector(`[data-remote-instance-form="${rowId}"]`);
    if (!form) return;
    e.preventDefault();
    if (rowId === '__new__') {
      handleAddSubmit(form);
    } else {
      handleEditSubmit(form, rowId);
    }
    return;
  }
});

// Handle form submit via Enter key
document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-remote-instance-form]');
  if (!form) return;
  e.preventDefault();
  const rowId = form.getAttribute('data-remote-instance-form');
  if (rowId === '__new__') {
    handleAddSubmit(form);
  } else {
    handleEditSubmit(form, rowId);
  }
});

// ── Init ───────────────────────────────────────────────────────────

export async function initRemoteInstancesPanel() {
  await loadAndRender();
}

// Expose for external refresh triggers
window.__refreshRemoteInstances = loadAndRender;
