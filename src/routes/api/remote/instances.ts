import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../../db/database';
import {
  serializeRemoteInstance,
  loadRemoteInstances,
  serializeRemoteInstanceOption,
} from '../../../services/remote-instances';
import { createRemoteInstance, updateRemoteInstance, checkRemoteInstance, deleteRemoteInstance, type CreateRemoteInstanceInput, type UpdateRemoteInstanceInput } from '../../../services/remote-instances/crud';
import { RemoteInstanceNotFoundError } from '../../../services/remote-instances/errors';
import { requireAdminRolePrehandler } from '../../prehandlers';

export function registerRemoteInstanceCrudRoutes(fastify: FastifyInstance): void {
  fastify.get('/remote-instance-options', async () => {
    const db = getDatabase();
    return {
      instances: loadRemoteInstances(db)
        .filter((instance) => instance.enabled)
        .map(serializeRemoteInstanceOption),
    };
  });

  fastify.register(async (adminScope) => {
    adminScope.addHook('preHandler', requireAdminRolePrehandler());

    adminScope.get('/remote-instances', async () => {
      const db = getDatabase();
      return {
        instances: loadRemoteInstances(db).map(serializeRemoteInstance),
      };
    });

    adminScope.post<{
      Body: CreateRemoteInstanceInput;
    }>('/remote-instances', async (request, reply) => {
      const db = getDatabase();

      try {
        const result = await createRemoteInstance(db, request.body, request.log as any);
        return reply.status(201).send({
          instance: serializeRemoteInstance(result.instance),
          probe: result.probe,
        });
      } catch (error: any) {
        if (error instanceof RemoteInstanceNotFoundError) return reply.status(404).send({ error: error.message });
        if (error.message === 'A remote instance with this URL already exists') return reply.status(409).send({ error: error.message });
        return reply.status(400).send({ error: error.message });
      }
    });

    adminScope.put<{
      Params: { id: string };
      Body: UpdateRemoteInstanceInput;
    }>('/remote-instances/:id', async (request, reply) => {
      const db = getDatabase();
      const input: UpdateRemoteInstanceInput = {};
      if (Object.prototype.hasOwnProperty.call(request.body || {}, 'name')) input.name = request.body?.name;
      if (Object.prototype.hasOwnProperty.call(request.body || {}, 'base_url')) input.base_url = request.body?.base_url;
      if (Object.prototype.hasOwnProperty.call(request.body || {}, 'api_token')) input.api_token = request.body?.api_token;
      if (Object.prototype.hasOwnProperty.call(request.body || {}, 'remote_username')) input.remote_username = request.body?.remote_username;
      if (Object.prototype.hasOwnProperty.call(request.body || {}, 'remote_password')) input.remote_password = request.body?.remote_password;
      if (Object.prototype.hasOwnProperty.call(request.body || {}, 'enabled')) input.enabled = request.body?.enabled;

      try {
        const result = await updateRemoteInstance(db, request.params.id, input, request.log as any);
        return {
          instance: serializeRemoteInstance(result.instance),
          probe: result.probe,
        };
      } catch (error: any) {
        if (error instanceof RemoteInstanceNotFoundError) return reply.status(404).send({ error: error.message });
        if (error.message === 'A remote instance with this URL already exists') return reply.status(409).send({ error: error.message });
        return reply.status(400).send({ error: error.message });
      }
    });

    adminScope.post<{
      Params: { id: string };
    }>('/remote-instances/:id/check', async (request, reply) => {
      const db = getDatabase();

      try {
        const result = await checkRemoteInstance(db, request.params.id, request.log as any);
        return {
          instance: serializeRemoteInstance(result.instance),
          probe: result.probe,
        };
      } catch (error: any) {
        if (error instanceof RemoteInstanceNotFoundError) return reply.status(404).send({ error: error.message });
        return reply.status(400).send({ error: error.message });
      }
    });

    adminScope.delete<{
      Params: { id: string };
    }>('/remote-instances/:id', async (request, reply) => {
      const db = getDatabase();

      try {
        deleteRemoteInstance(db, request.params.id, request.log as any);
        return { ok: true };
      } catch (error: any) {
        if (error instanceof RemoteInstanceNotFoundError) return reply.status(404).send({ error: error.message });
        return reply.status(400).send({ error: error.message });
      }
    });
  });
}
