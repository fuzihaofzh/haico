import { h, type HtmlFragment } from '../html';

/** Serialized remote instance shape consumed by the admin views. Mirrors the
 * JSON-safe output of serializeRemoteInstance() but is declared here so the
 * views stay pure and testable without importing service internals. */
export interface RemoteInstanceView {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  last_status: 'unknown' | 'ok' | 'error';
  last_error: string;
  has_api_token: boolean;
  api_token_preview: string;
}

/** Port of the client deriveRemoteInstanceName helper (remote-instances.js). */
export function deriveRemoteInstanceName(baseUrl: string, fallback = ''): string {
  const raw = String(baseUrl || '').trim();
  if (!raw) return String(fallback || '').trim();
  try {
    const url = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
    return url.hostname || String(fallback || '').trim() || raw;
  } catch {
    return String(fallback || '').trim() || raw;
  }
}

function remoteStatusLabel(status: string | undefined): string {
  if (status === 'ok') return 'Connected';
  if (status === 'error') return 'Needs Review';
  return 'Unchecked';
}

function renderRemoteRow(instance: RemoteInstanceView): HtmlFragment {
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
          ${instance.last_error ? h`<div class="remote-server-meta-inline">${instance.last_error}</div>` : ''}
        </div>
      </td>
      <td>
        <div class="command-profile-actions">
          <button type="button" class="btn btn-sm" hx-get="/ui/admin/remote-instances?editing=${instance.id}" hx-target="#remote-instances-settings" hx-swap="innerHTML">Edit</button>
          <button type="button" class="btn btn-sm" hx-post="/ui/admin/remote-instances/${instance.id}/check" hx-target="#remote-instances-settings" hx-swap="innerHTML">Check</button>
          <button type="button" class="btn btn-sm btn-danger" hx-delete="/ui/admin/remote-instances/${instance.id}" hx-confirm="Delete this remote HAICO instance from Settings?" hx-target="#remote-instances-settings" hx-swap="innerHTML">Delete</button>
        </div>
      </td>
    </tr>`;
}

function renderRemoteFormRow(editing: RemoteInstanceView | null): HtmlFragment {
  if (editing) {
    const formId = `remote-form-${editing.id}`;
    return h`
    <tr data-remote-instance-row="${editing.id}">
      <td colspan="2">
        <form id="${formId}" class="remote-inline-form" hx-put="/ui/admin/remote-instances/${editing.id}" hx-target="#remote-instances-settings" hx-swap="innerHTML">
          <input class="command-profile-input remote-inline-url" type="text" name="base_url" value="${editing.base_url}" placeholder="URL">
          <input class="command-profile-input remote-inline-username" type="text" name="remote_username" placeholder="Username">
          <input class="command-profile-input remote-inline-password" type="password" name="remote_password" placeholder="Password">
        </form>
      </td>
      <td>
        <div class="remote-table-status">
          <div class="remote-server-meta-inline">Editing ${editing.name}</div>
          ${editing.has_api_token ? h`<div class="remote-server-meta-inline">Saved login: ${editing.api_token_preview}</div>` : ''}
        </div>
      </td>
      <td>
        <div class="command-profile-actions">
          <button type="submit" form="${formId}" class="btn btn-sm btn-primary">Save</button>
          <button type="button" class="btn btn-sm" hx-get="/ui/admin/remote-instances" hx-target="#remote-instances-settings" hx-swap="innerHTML">Cancel</button>
        </div>
      </td>
    </tr>`;
  }
  return h`
    <tr data-remote-instance-row="__new__">
      <td colspan="2">
        <form id="remote-form-new" class="remote-inline-form" hx-post="/ui/admin/remote-instances" hx-target="#remote-instances-settings" hx-swap="innerHTML">
          <input class="command-profile-input remote-inline-url" type="text" name="base_url" placeholder="URL">
          <input class="command-profile-input remote-inline-username" type="text" name="remote_username" placeholder="Username">
          <input class="command-profile-input remote-inline-password" type="password" name="remote_password" placeholder="Password">
        </form>
      </td>
      <td>
        <div class="remote-table-status">
          <div class="remote-server-meta-inline">URL / Username / Password</div>
        </div>
      </td>
      <td>
        <div class="command-profile-actions">
          <button type="submit" form="remote-form-new" class="btn btn-sm btn-primary">Add</button>
        </div>
      </td>
    </tr>`;
}

export interface RemotePanelOptions {
  editingId?: string | null;
  error?: string;
  notice?: string;
}

/**
 * Inner content of #remote-instances-settings. Re-rendered in full on every
 * CRUD action (outerHTML/innerHTML swap). State (editing row, status message)
 * lives entirely server-side — the client holds none.
 */
export function renderRemotePanel(
  instances: RemoteInstanceView[],
  opts: RemotePanelOptions = {},
): HtmlFragment {
  const editing = opts.editingId
    ? instances.find((i) => i.id === opts.editingId) || null
    : null;

  const rows = instances.length
    ? instances.map(renderRemoteRow)
    : [h`<tr><td colspan="4" class="command-profiles-empty">No remote HAICO instances yet.</td></tr>`];

  return h`
    <div class="remote-settings-shell">
      <div class="remote-settings-note">
        Add another HAICO machine here. HAICO will sign in once, store the remote session token on the server, and merge that machine's projects into this dashboard.
      </div>
      ${opts.error ? h`<div class="command-profiles-status command-profiles-status-error">${opts.error}</div>` : ''}
      ${opts.notice ? h`<div class="command-profiles-status">${opts.notice}</div>` : ''}
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
            ${rows}
            ${renderRemoteFormRow(editing)}
          </tbody>
        </table>
      </div>
    </div>`;
}
