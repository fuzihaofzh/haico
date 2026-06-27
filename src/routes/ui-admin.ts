import { FastifyInstance } from 'fastify';
import { requireAdminRolePrehandler } from './prehandlers';
import { mapErrorToHttp, getUnexpectedErrorMessage } from '../errors/error-mapper';
import { h, renderToString } from '../views/html';
import { renderAdminShell } from '../views/shell';
import { renderSystemPage, renderSystemStatus, renderMaintenanceResult } from '../views/admin/system';
import { getSystemStatus } from '../services/admin/system-status';
import { resetStuckAgents, runMaintenance } from '../services/admin/maintenance';
import { renderGlobalSettingsPage, renderEventLogToggleButton } from '../views/admin/settings';
import { getAdminSettings, applyLogRetention, applyEventLogEnabled } from '../services/admin/settings';
import { renderUsersPage, renderUserList, renderAddUserDialog, renderResetPasswordDialog, renderResetPasswordSuccess } from '../views/admin/users';
import { listUsers, registerUser, updateUserRole, deleteUser, resetUserPassword } from '../services/auth/users';
import { renderRemotePanel, deriveRemoteInstanceName, type RemoteInstanceView } from '../views/admin/remote';
import {
  loadRemoteInstances,
  serializeRemoteInstance,
} from '../services/remote-instances/core';
import {
  createRemoteInstance,
  updateRemoteInstance,
  checkRemoteInstance,
  deleteRemoteInstance,
  type CreateRemoteInstanceInput,
  type UpdateRemoteInstanceInput,
} from '../services/remote-instances/crud';
import { getDatabase } from '../db/database';
import logger from '../logger';

/** HTML fragment rendered for any error inside the /ui/admin fragment scope. */
function adminErrorFragment(message: string): string {
  return renderToString(h`<div class="admin-error-toast" role="alert">${message}</div>`);
}

/** Resolve which instance id is being edited, if any, from the ?editing= query. */
function editingIdFromQuery(query: unknown): string | null {
  if (typeof query === 'object' && query !== null && 'editing' in query) {
    const raw = (query as { editing: unknown }).editing;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return null;
}

function remoteViews() {
  return loadRemoteInstances(getDatabase()).map(serializeRemoteInstance) as RemoteInstanceView[];
}

/**
 * Admin UI routes in two scopes sharing one preHandler:
 *
 * 1. Shell scope (no prefix, /admin/*) — first-paint SSR shells. No custom
 *    error handler: AdminRoleRequiredError (403) flows to the global handler
 *    which redirects non-admins to /overview (GET, non-/api/).
 *
 * 2. Fragment scope (prefix /ui, /ui/admin/*) — htmx HTML fragments. A
 *    scope-level setErrorHandler maps any error to an HTML error fragment +
 *    4xx/5xx status, overriding the global JSON handler. /api/admin/* is
 *    untouched (separate route tree, global handler returns JSON).
 */
export function registerAdminUIRoutes(fastify: FastifyInstance): void {
  // ── Shell scope: first-paint admin pages ──
  fastify.register(async (shellScope) => {
    shellScope.addHook('preHandler', requireAdminRolePrehandler());

    shellScope.get('/admin', async (_request, reply) => {
      return reply.redirect('/admin/users');
    });

    // Migrated: SSR shell with htmx-wired user list + dialog modals.
    shellScope.get('/admin/users', async (_request, reply) => {
      const body = renderUsersPage('/admin/users');
      return reply
        .type('text/html')
        .send(renderToString(renderAdminShell({ title: 'Admin - Users - HAICO', body })));
    });

    // Migrated: SSR shell with htmx-wired sections + remote panel.
    shellScope.get('/admin/global-settings', async (_request, reply) => {
      const body = renderGlobalSettingsPage('/admin/global-settings', getAdminSettings());
      return reply
        .type('text/html')
        .send(renderToString(renderAdminShell({ title: 'Admin - Global Settings - HAICO', body })));
    });

    shellScope.get('/admin/system', async (_request, reply) => {
      const body = renderSystemPage('/admin/system');
      return reply
        .type('text/html')
        .send(renderToString(renderAdminShell({ title: 'Admin - System - HAICO', body })));
    });
  });

  // ── Fragment scope: htmx HTML fragments ──
  fastify.register(async (fragmentScope) => {
    fragmentScope.addHook('preHandler', requireAdminRolePrehandler());

    fragmentScope.setErrorHandler((error, request, reply) => {
      const mapped = mapErrorToHttp(error);
      const statusCode = mapped?.statusCode || 500;
      if (statusCode >= 500) {
        request.log.error({ err: error }, 'Admin UI fragment request failed');
      } else {
        request.log.debug({ err: error, statusCode }, 'Admin UI fragment request failed');
      }
      const message = mapped
        ? mapped.message
        : process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : getUnexpectedErrorMessage(error);
      return reply.code(statusCode).type('text/html').send(adminErrorFragment(message));
    });

    // ── System ──
    fragmentScope.get('/admin/system/status', async () => {
      return renderToString(renderSystemStatus(getSystemStatus()));
    });
    fragmentScope.post('/admin/system/reset-stuck-agents', async () => {
      return renderToString(renderMaintenanceResult(resetStuckAgents()));
    });
    fragmentScope.post('/admin/system/run-maintenance', async () => {
      return renderToString(renderMaintenanceResult(runMaintenance()));
    });

    // ── Settings ──
    // Log retention: input change fires PUT, returns nothing (swap=none);
    // success is signaled via HX-Trigger toast.
    fragmentScope.put('/admin/settings/log-retention', async (request, reply) => {
      const body = request.body as { log_retention_days?: unknown } | undefined;
      const value = applyLogRetention(body?.log_retention_days);
      reply.header('HX-Trigger', JSON.stringify({ showToast: `Log retention set to ${value} days` }));
      return '';
    });

    // Event-log toggle: POST the target boolean, returns a fresh button.
    fragmentScope.post('/admin/settings/event-log', async (request) => {
      const body = request.body as { event_log_enabled?: unknown } | undefined;
      const enabled = applyEventLogEnabled(body?.event_log_enabled);
      return renderToString(renderEventLogToggleButton(enabled));
    });

    // ── Remote instances ──
    fragmentScope.get('/admin/remote-instances', async (request) => {
      const editingId = editingIdFromQuery(request.query);
      return renderToString(renderRemotePanel(remoteViews(), { editingId }));
    });

    fragmentScope.post('/admin/remote-instances', async (request) => {
      const body = request.body as CreateRemoteInstanceInput;
      const baseUrl = String(body?.base_url || '').trim();
      if (!baseUrl) {
        return renderToString(renderRemotePanel(remoteViews(), {
          error: 'base_url is required',
        }));
      }
      try {
        await createRemoteInstance(getDatabase(), {
          base_url: baseUrl,
          name: deriveRemoteInstanceName(baseUrl),
          remote_username: body?.remote_username,
          remote_password: body?.remote_password,
        }, logger);
        return renderToString(renderRemotePanel(remoteViews(), {
          notice: 'Remote instance added',
        }));
      } catch (err) {
        return renderToString(renderRemotePanel(remoteViews(), {
          error: err instanceof Error ? err.message : 'Failed to add instance',
        }));
      }
    });

    fragmentScope.put('/admin/remote-instances/:id', async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateRemoteInstanceInput;
      const baseUrl = String(body?.base_url || '').trim();
      if (!baseUrl) {
        return renderToString(renderRemotePanel(remoteViews(), {
          editingId: id,
          error: 'base_url is required',
        }));
      }
      try {
        const existing = remoteViews().find((i) => i.id === id);
        await updateRemoteInstance(getDatabase(), id, {
          base_url: baseUrl,
          name: deriveRemoteInstanceName(baseUrl, existing?.name || ''),
          remote_username: body?.remote_username,
          remote_password: body?.remote_password,
        }, logger);
        return renderToString(renderRemotePanel(remoteViews(), {
          notice: 'Remote instance updated',
        }));
      } catch (err) {
        return renderToString(renderRemotePanel(remoteViews(), {
          editingId: id,
          error: err instanceof Error ? err.message : 'Failed to update instance',
        }));
      }
    });

    fragmentScope.post('/admin/remote-instances/:id/check', async (request) => {
      const { id } = request.params as { id: string };
      try {
        await checkRemoteInstance(getDatabase(), id, logger);
        return renderToString(renderRemotePanel(remoteViews(), {
          notice: 'Remote instance checked',
        }));
      } catch (err) {
        return renderToString(renderRemotePanel(remoteViews(), {
          error: err instanceof Error ? err.message : 'Failed to check instance',
        }));
      }
    });

    fragmentScope.delete('/admin/remote-instances/:id', async (request) => {
      const { id } = request.params as { id: string };
      try {
        deleteRemoteInstance(getDatabase(), id, logger);
        return renderToString(renderRemotePanel(remoteViews(), {
          notice: 'Remote instance deleted',
        }));
      } catch (err) {
        return renderToString(renderRemotePanel(remoteViews(), {
          error: err instanceof Error ? err.message : 'Failed to delete instance',
        }));
      }
    });

    // ── Users ──
    fragmentScope.get('/admin/users/list', async (request) => {
      const currentUserId = request.user!.id;
      return renderToString(renderUserList(listUsers(getDatabase()), currentUserId));
    });

    fragmentScope.get('/admin/users/add', async () => {
      return renderToString(renderAddUserDialog());
    });

    fragmentScope.post('/admin/users/add', async (request, reply) => {
      const body = request.body as { username?: string; password?: string; display_name?: string; role?: string };
      const db = getDatabase();
      const result = registerUser(db, {
        username: body.username,
        password: body.password,
        display_name: body.display_name,
      });
      if (result === 'duplicate') {
        reply.header('HX-Retarget', '#modal-mount');
        return renderToString(renderAddUserDialog());
      }
      // Promote to admin if requested (registerUser defaults to member).
      if (body.role === 'admin' && result.role !== 'admin') {
        updateUserRole(db, result.id, 'admin');
      }
      // Close modal + refresh list.
      reply.header('HX-Trigger', JSON.stringify({ showToast: 'User added' }));
      return renderToString(renderUserList(listUsers(db), request.user!.id));
    });

    fragmentScope.put('/admin/users/:id/role', async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { role?: string };
      updateUserRole(getDatabase(), id, body.role);
      return '';
    });

    fragmentScope.delete('/admin/users/:id', async (request) => {
      const { id } = request.params as { id: string };
      deleteUser(getDatabase(), id);
      return renderToString(renderUserList(listUsers(getDatabase()), request.user!.id));
    });

    fragmentScope.get('/admin/users/:id/reset-password', async (request) => {
      const { id } = request.params as { id: string };
      const db = getDatabase();
      const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
      if (!target) return adminErrorFragment('User not found');
      return renderToString(renderResetPasswordDialog(id, target.username));
    });

    fragmentScope.post('/admin/users/:id/reset-password', async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { password?: string };
      const db = getDatabase();
      const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
      if (!target) return adminErrorFragment('User not found');
      resetUserPassword(db, target.username, body.password || '');
      return renderToString(renderResetPasswordSuccess());
    });
  }, { prefix: '/ui' });
}
