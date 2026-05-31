import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import {
  listCommandProfiles,
  createCommandProfile,
  updateCommandProfile,
  deleteCommandProfile,
  resolveCommandType,
  RemoteCommandProfileCheckError,
} from '../../services/command-profiles';
import {
  checkRemoteCommandProfile,
  findRemoteInstanceById,
  isLocalTargetInstanceId,
} from '../../services/remote-instances';
import { RemoteInstanceNotFoundError, RemoteInstanceDisabledError } from '../../services/remote-instances/errors';
import { inspectToolReadiness } from '../../services/tool-readiness';
import { requireAdminRolePrehandler } from '../prehandlers';

export function registerCommandProfileRoutes(fastify: FastifyInstance): void {
  fastify.register((profileRoutes, _opts, done) => {
    const defaultJsonParser = profileRoutes.getDefaultJsonParser('error', 'error');

    profileRoutes.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, parserDone) => {
      const bodyText = typeof body === 'string' ? body : body.toString();
      if (bodyText.length === 0) {
        parserDone(null, undefined);
        return;
      }

      defaultJsonParser(request, bodyText, parserDone);
    });

    profileRoutes.get('/command-profiles', async () => {
      const db = getDatabase();
      return { profiles: listCommandProfiles(db) };
    });

    profileRoutes.post<{
      Body: { command?: string; type?: string | null; target_instance_id?: string | null };
    }>('/command-profiles/check', async (request) => {
      const command = String(request.body?.command || '').trim();
      const type = resolveCommandType(request.body?.type, command);
      const targetInstanceId = String(request.body?.target_instance_id || '').trim();

      if (!isLocalTargetInstanceId(targetInstanceId)) {
        const db = getDatabase();
        const remoteInstance = findRemoteInstanceById(db, targetInstanceId);
        if (!remoteInstance) throw new RemoteInstanceNotFoundError();
        if (!remoteInstance.enabled) throw new RemoteInstanceDisabledError();

        const result = await checkRemoteCommandProfile(remoteInstance, { command, type });
        if (!result.ok) {
          throw new RemoteCommandProfileCheckError(
            result.error || 'Failed to inspect CLI on remote instance',
            result.status || 502,
            result.data,
          );
        }
        return result.data;
      }

      return inspectToolReadiness({
        commandTemplate: command,
        commandType: type,
      });
    });

    profileRoutes.register((adminScope, _opts, adminDone) => {
      adminScope.addHook('preHandler', requireAdminRolePrehandler());

      adminScope.post<{
        Body: { name?: string; command?: string; type?: string | null; scenario?: string | null; config_json?: unknown };
      }>('/command-profiles', async (request, reply) => {
        const db = getDatabase();
        const profile = createCommandProfile(db, request.body || {});
        return reply.status(201).send(profile);
      });

      adminScope.put<{
        Params: { id: string };
        Body: { name?: string; command?: string; type?: string | null; scenario?: string | null; config_json?: unknown };
      }>('/command-profiles/:id', async (request) => {
        const db = getDatabase();
        return updateCommandProfile(db, request.params.id, request.body || {});
      });

      adminScope.delete<{ Params: { id: string } }>('/command-profiles/:id', async (request) => {
        const db = getDatabase();
        deleteCommandProfile(db, request.params.id);
        return { success: true };
      });

      adminDone();
    });

    done();
  });
}
