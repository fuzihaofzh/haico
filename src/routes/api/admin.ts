import { FastifyInstance } from 'fastify';
import { requireAdminRolePrehandler } from '../prehandlers';
import {
  getAdminSettings,
  applyLogRetention,
  applyEventLogEnabled,
} from '../../services/admin/settings';
import { getSystemStatus } from '../../services/admin/system-status';
import { resetStuckAgents, runMaintenance } from '../../services/admin/maintenance';

export function registerAdminRoutes(fastify: FastifyInstance): void {
  fastify.register(async (adminScope) => {
    adminScope.addHook('preHandler', requireAdminRolePrehandler());

    adminScope.get('/admin/system-status', async () => {
      return getSystemStatus();
    });

    adminScope.get('/admin/settings', async () => {
      return getAdminSettings();
    });

    adminScope.put('/admin/settings', async (request) => {
      const body = request.body as {
        log_retention_days?: unknown;
        event_log_enabled?: unknown;
      };
      const updated: string[] = [];

      if (body.log_retention_days !== undefined) {
        const value = applyLogRetention(body.log_retention_days);
        updated.push(`log_retention_days=${value}`);
      }

      if (body.event_log_enabled !== undefined) {
        const value = applyEventLogEnabled(body.event_log_enabled);
        updated.push(`event_log_enabled=${value}`);
      }

      return { ...getAdminSettings(), updated };
    });

    adminScope.post('/admin/reset-stuck-agents', async () => {
      return resetStuckAgents();
    });

    adminScope.post('/admin/run-maintenance', async () => {
      return runMaintenance();
    });
  });
}
