import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import { isDefaultAdminEnabled } from '../services/auth/default-admin';
import { hasAnyUsers } from '../services/auth/users';
import {
  authenticateRemoteInstance,
  applyProbeToRemoteInstance,
  loadRemoteInstances,
  normalizeRemoteApiToken,
  normalizeRemoteInstanceBaseUrl,
  normalizeRemoteInstanceName,
  probeRemoteInstance,
  RemoteInstanceRecord,
  saveRemoteInstances,
  serializeRemoteInstance,
} from '../services/remote-instances';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deriveRemoteInstanceName(baseUrl: string, fallback = ''): string {
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

function remoteStatusLabel(instance: any): string {
  if (instance?.last_status === 'ok') return 'Connected';
  if (instance?.last_status === 'error') return 'Needs Review';
  return 'Unchecked';
}

function remoteInstancesPartial(input: {
  instances: ReturnType<typeof serializeRemoteInstance>[];
  editingId?: string;
  error?: string;
  notice?: string;
  isAdmin: boolean;
}): string {
  if (!input.isAdmin) {
    return '<div class="remote-settings-shell"><div class="remote-settings-note">Remote instance configuration is only available to workspace admins.</div></div>';
  }

  const editing = input.instances.find((instance) => instance.id === input.editingId) || null;
  const formAction = editing
    ? `/settings/partials/remote-instances/${encodeURIComponent(editing.id)}`
    : '/settings/partials/remote-instances';
  const formMethod = editing ? 'put' : 'post';
  const primaryAction = editing ? 'Save' : 'Add';
  const rows = input.instances.length
    ? input.instances.map((instance) => `
      <tr>
        <td>
          <div class="remote-table-instance">
            <span class="remote-server-dot" data-status="${esc(instance.last_status || 'unknown')}"></span>
            <div>
              <div class="remote-server-label">${esc(instance.name)}</div>
              <div class="remote-server-meta-inline">${instance.has_api_token ? 'Signed in' : 'No saved login'}</div>
            </div>
          </div>
        </td>
        <td><div class="remote-server-url">${esc(instance.base_url)}</div></td>
        <td>
          <div class="remote-table-status">
            <span class="remote-status-badge" data-status="${esc(instance.last_status || 'unknown')}">${esc(remoteStatusLabel(instance))}</span>
            <div class="remote-server-meta-inline">${instance.last_checked_at ? `Checked ${esc(instance.last_checked_at)}` : 'Never checked'}</div>
            ${instance.last_error ? `<div class="remote-server-meta-inline">${esc(instance.last_error)}</div>` : ''}
          </div>
        </td>
        <td>
          <div class="command-profile-actions">
            <button type="button" class="btn btn-sm" hx-get="/settings/partials/remote-instances?edit=${encodeURIComponent(instance.id)}" hx-target="#remote-instances-settings" hx-swap="innerHTML">Edit</button>
            <button type="button" class="btn btn-sm" hx-post="/settings/partials/remote-instances/${encodeURIComponent(instance.id)}/check" hx-target="#remote-instances-settings" hx-swap="innerHTML">Check</button>
            <button type="button" class="btn btn-sm btn-danger" hx-delete="/settings/partials/remote-instances/${encodeURIComponent(instance.id)}" hx-confirm="Delete this remote HAICO instance from Settings?" hx-target="#remote-instances-settings" hx-swap="innerHTML">Delete</button>
          </div>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="4" class="command-profiles-empty">No remote HAICO instances yet.</td></tr>';

  return `
    <div class="remote-settings-shell">
      <div class="remote-settings-note">
        Add another HAICO machine here. HAICO will sign in once, store the remote session token on the server, and merge that machine's projects into this dashboard.
      </div>
      ${input.error ? `<div class="command-profiles-status command-profiles-status-error">${esc(input.error)}</div>` : ''}
      ${input.notice ? `<div class="command-profiles-status">${esc(input.notice)}</div>` : ''}
      <div class="command-profiles-table-wrap">
        <table class="command-profiles-table remote-instances-table">
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
            <tr data-remote-instance-row="${editing ? esc(editing.id) : '__new__'}">
              <td colspan="2">
                <form id="remote-instance-form" class="remote-inline-form" hx-${formMethod}="${formAction}" hx-target="#remote-instances-settings" hx-swap="innerHTML">
                  <input class="command-profile-input remote-inline-url" type="text" name="base_url" value="${esc(editing?.base_url || '')}" placeholder="URL">
                  <input class="command-profile-input remote-inline-username" type="text" name="remote_username" value="" placeholder="Username">
                  <input class="command-profile-input remote-inline-password" type="password" name="remote_password" value="" placeholder="Password">
                </form>
              </td>
              <td>
                <div class="remote-table-status">
                  <div class="remote-server-meta-inline">${editing ? `Editing ${esc(editing.name)}` : 'URL / Username / Password'}</div>
                  ${editing?.has_api_token ? `<div class="remote-server-meta-inline">Saved login: ${esc(editing.api_token_preview || '')}</div>` : ''}
                </div>
              </td>
              <td>
                <div class="command-profile-actions">
                  <button type="submit" form="remote-instance-form" class="btn btn-sm btn-primary">${primaryAction}</button>
                  ${editing ? '<button type="button" class="btn btn-sm" hx-get="/settings/partials/remote-instances" hx-target="#remote-instances-settings" hx-swap="innerHTML">Cancel</button>' : ''}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function registerUIRoutes(fastify: FastifyInstance): void {
  // Resolve public dir relative to project root (works from both src/ and dist/)
  const publicDir = path.join(__dirname, '..', '..', 'public');

  function serveHtml(file: string) {
    const filePath = path.join(publicDir, file);
    return fs.readFileSync(filePath, 'utf-8');
  }

  const dashboardViews: Record<string, true> = { overview: true, inbox: true, chat: true, compose: true, projects: true, usage: true, settings: true };

  fastify.get<{ Querystring: { view?: string } }>('/', async (request, reply) => {
    // Priority: query param > user preference > default 'overview'
    const queryView = request.query.view;
    if (queryView && queryView in dashboardViews) {
      return reply.redirect('/' + String(queryView));
    }
    try {
      const userId = request.user?.id;
      if (userId) {
        const db = getDatabase();
        const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, 'default_landing_page') as { value: string } | undefined;
        if (row?.value && row.value in dashboardViews) {
          return reply.redirect('/' + row.value);
        }
      }
    } catch {}
    return reply.redirect('/overview');
  });

  fastify.get('/overview', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('overview.html'));
  });

  fastify.get('/inbox', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('inbox.html'));
  });

  fastify.get('/chat', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('chat.html'));
  });

  fastify.get('/compose', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('compose.html'));
  });
  fastify.get('/issue/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/projects', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('projects.html'));
  });

  fastify.get('/usage', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('usage.html'));
  });

  fastify.get('/settings', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('settings/general.html'));
  });

  fastify.get('/settings/agent-tools', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('settings/agent-tools.html'));
  });

  function sendRemoteInstancesPartial(reply: any, options: {
    editingId?: string;
    error?: string;
    notice?: string;
    isAdmin: boolean;
  }) {
    const db = getDatabase();
    const instances = options.isAdmin
      ? loadRemoteInstances(db).map(serializeRemoteInstance)
      : [];
    return reply.type('text/html').send(remoteInstancesPartial({
      instances,
      editingId: options.editingId,
      error: options.error,
      notice: options.notice,
      isAdmin: options.isAdmin,
    }));
  }

  function isRequestAdmin(request: any): boolean {
    return Boolean(request.user && request.user.role === 'admin');
  }

  fastify.get<{ Querystring: { edit?: string } }>('/settings/partials/remote-instances', async (request, reply) => {
    return sendRemoteInstancesPartial(reply, {
      editingId: request.query.edit,
      isAdmin: isRequestAdmin(request),
    });
  });

  fastify.post<{ Body: { base_url?: string; remote_username?: string; remote_password?: string } }>('/settings/partials/remote-instances', async (request, reply) => {
    if (!isRequestAdmin(request)) return sendRemoteInstancesPartial(reply.code(403), { isAdmin: false });

    const remoteUsername = normalizeRemoteInstanceName(request.body?.remote_username);
    const remotePassword = normalizeRemoteApiToken(request.body?.remote_password);
    let baseUrl = '';
    try {
      baseUrl = normalizeRemoteInstanceBaseUrl(request.body?.base_url);
    } catch (error: any) {
      return sendRemoteInstancesPartial(reply.code(400), { isAdmin: true, error: error?.message || 'Invalid remote instance URL' });
    }
    if (!baseUrl) return sendRemoteInstancesPartial(reply.code(400), { isAdmin: true, error: 'base_url is required' });

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    if (instances.some((instance) => instance.base_url === baseUrl)) {
      return sendRemoteInstancesPartial(reply.code(409), { isAdmin: true, error: 'A remote instance with this URL already exists' });
    }

    let resolvedToken = '';
    if (remotePassword) {
      try {
        const auth = await authenticateRemoteInstance({
          baseUrl,
          username: remoteUsername || undefined,
          password: remotePassword,
        });
        resolvedToken = auth.token;
      } catch (error: any) {
        return sendRemoteInstancesPartial(reply.code(400), { isAdmin: true, error: error?.message || 'Failed to log into remote instance' });
      }
    }

    const now = new Date().toISOString();
    const candidate: RemoteInstanceRecord = {
      id: randomUUID(),
      name: normalizeRemoteInstanceName(deriveRemoteInstanceName(baseUrl)),
      base_url: baseUrl,
      api_token: resolvedToken,
      enabled: true,
      created_at: now,
      updated_at: now,
      last_checked_at: null,
      last_status: 'unknown',
      last_error: '',
    };
    const probe = await probeRemoteInstance(candidate);
    saveRemoteInstances(db, instances.concat(applyProbeToRemoteInstance(candidate, probe)));
    return sendRemoteInstancesPartial(reply.code(201), { isAdmin: true, notice: 'Remote instance added' });
  });

  fastify.put<{
    Params: { id: string };
    Body: { base_url?: string; remote_username?: string; remote_password?: string };
  }>('/settings/partials/remote-instances/:id', async (request, reply) => {
    if (!isRequestAdmin(request)) return sendRemoteInstancesPartial(reply.code(403), { isAdmin: false });

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const existing = instances.find((instance) => instance.id === request.params.id);
    if (!existing) return sendRemoteInstancesPartial(reply.code(404), { isAdmin: true, error: 'Remote instance not found' });

    const remoteUsername = normalizeRemoteInstanceName(request.body?.remote_username);
    const remotePassword = normalizeRemoteApiToken(request.body?.remote_password);
    let baseUrl = existing.base_url;
    try {
      baseUrl = normalizeRemoteInstanceBaseUrl(request.body?.base_url);
    } catch (error: any) {
      return sendRemoteInstancesPartial(reply.code(400), { isAdmin: true, editingId: existing.id, error: error?.message || 'Invalid remote instance URL' });
    }
    if (!baseUrl) return sendRemoteInstancesPartial(reply.code(400), { isAdmin: true, editingId: existing.id, error: 'base_url is required' });
    if (instances.some((instance) => instance.id !== existing.id && instance.base_url === baseUrl)) {
      return sendRemoteInstancesPartial(reply.code(409), { isAdmin: true, editingId: existing.id, error: 'A remote instance with this URL already exists' });
    }

    let resolvedToken = existing.api_token;
    if (remotePassword) {
      try {
        const auth = await authenticateRemoteInstance({
          baseUrl,
          username: remoteUsername || undefined,
          password: remotePassword,
        });
        resolvedToken = auth.token;
      } catch (error: any) {
        return sendRemoteInstancesPartial(reply.code(400), { isAdmin: true, editingId: existing.id, error: error?.message || 'Failed to log into remote instance' });
      }
    }

    const updated: RemoteInstanceRecord = {
      ...existing,
      name: normalizeRemoteInstanceName(deriveRemoteInstanceName(baseUrl, existing.name)),
      base_url: baseUrl,
      api_token: resolvedToken,
      updated_at: new Date().toISOString(),
    };
    const probe = await probeRemoteInstance(updated);
    const finalInstance = applyProbeToRemoteInstance(updated, probe);
    saveRemoteInstances(db, instances.map((instance) => (instance.id === existing.id ? finalInstance : instance)));
    return sendRemoteInstancesPartial(reply, { isAdmin: true, notice: 'Remote instance updated' });
  });

  fastify.post<{ Params: { id: string } }>('/settings/partials/remote-instances/:id/check', async (request, reply) => {
    if (!isRequestAdmin(request)) return sendRemoteInstancesPartial(reply.code(403), { isAdmin: false });

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const existing = instances.find((instance) => instance.id === request.params.id);
    if (!existing) return sendRemoteInstancesPartial(reply.code(404), { isAdmin: true, error: 'Remote instance not found' });

    const probe = await probeRemoteInstance(existing);
    const checked = applyProbeToRemoteInstance(existing, probe);
    saveRemoteInstances(db, instances.map((instance) => (instance.id === existing.id ? checked : instance)));
    return sendRemoteInstancesPartial(reply, { isAdmin: true, notice: 'Remote instance checked' });
  });

  fastify.delete<{ Params: { id: string } }>('/settings/partials/remote-instances/:id', async (request, reply) => {
    if (!isRequestAdmin(request)) return sendRemoteInstancesPartial(reply.code(403), { isAdmin: false });

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const nextInstances = instances.filter((instance) => instance.id !== request.params.id);
    if (nextInstances.length === instances.length) {
      return sendRemoteInstancesPartial(reply.code(404), { isAdmin: true, error: 'Remote instance not found' });
    }
    saveRemoteInstances(db, nextInstances);
    return sendRemoteInstancesPartial(reply, { isAdmin: true, notice: 'Remote instance deleted' });
  });

  fastify.get('/login', async (request, reply) => {
    let usersConfigured = false;
    try {
      usersConfigured = hasAnyUsers(getDatabase());
    } catch {}
    if (!usersConfigured) return reply.redirect('/register');
    const manual = (request.query as { manual?: string | string[] } | null)?.manual;
    const manualLogin = Array.isArray(manual) ? manual[0] === '1' : manual === '1';
    if (isDefaultAdminEnabled() && !manualLogin) return reply.redirect('/auto-login');
    return reply.type('text/html').send(serveHtml('login.html'));
  });

  fastify.get('/auto-login', async (_request, reply) => {
    if (!isDefaultAdminEnabled()) return reply.redirect('/login');
    return reply.type('text/html').send(serveHtml('auto-login.html'));
  });

  fastify.get('/register', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('register.html'));
  });

  fastify.get('/change-password', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('change-password.html'));
  });

  fastify.get('/projects/new', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('projects-new.html'));
  });

  fastify.get('/project/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/overview.html'));
  });

  fastify.get('/project/:id/agents', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/agents.html'));
  });

  fastify.get('/project/:id/issues', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/issues.html'));
  });

  fastify.get('/project/:id/activity', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/activity.html'));
  });

  fastify.get('/project/:id/git', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/git.html'));
  });

  fastify.get('/project/:id/knowledge', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/knowledge.html'));
  });

  fastify.get('/project/:id/files', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/files.html'));
  });

  fastify.get('/project/:id/workflow', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/workflow.html'));
  });

  fastify.get('/project/:id/sharing', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('project/sharing.html'));
  });

  fastify.get('/project/:id/operations-console', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('operations-console.html'));
  });

  fastify.get('/agents/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('agent.html'));
  });

  fastify.get('/project/:pid/agent/:id/edit', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('agent-edit.html'));
  });

  fastify.get('/terminal', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('terminal.html'));
  });

  fastify.get('/issues/:id', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/project/:pid/issues/:num', async (_request, reply) => {
    return reply.type('text/html').send(serveHtml('issue.html'));
  });

  fastify.get('/admin', async (_request, reply) => {
    return reply.redirect('/admin/users');
  });

  const adminPages: Record<string, string> = {
    '/admin/users': 'admin-users.html',
    '/admin/global-settings': 'admin-global-settings.html',
    '/admin/system': 'admin-system.html',
  };
  for (const [path, file] of Object.entries(adminPages)) {
    fastify.get(path, async (request, reply) => {
      if (!request.user || request.user.role !== 'admin') {
        return reply.redirect('/overview');
      }
      return reply.type('text/html').send(serveHtml(file));
    });
  }
}
