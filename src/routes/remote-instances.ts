import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDatabase } from '../db/database';
import { getRequestUser } from '../middleware/auth';
import {
  authenticateRemoteInstance,
  applyProbeToRemoteInstance,
  fetchRemoteProjects,
  loadRemoteInstances,
  normalizeRemoteInstanceBaseUrl,
  normalizeRemoteInstanceName,
  probeRemoteInstance,
  RemoteInstanceRecord,
  saveRemoteInstances,
  serializeRemoteInstance,
} from '../services/remote-instances';

function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = getRequestUser(request);
  if (!user || user.role !== 'admin') {
    reply.status(403).send({ error: 'Admin access required' });
    return null;
  }
  return user;
}

function normalizeRemoteApiToken(value: unknown): string {
  return String(value || '').trim();
}

export function registerRemoteInstanceRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/remote-instances', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const db = getDatabase();
    return {
      instances: loadRemoteInstances(db).map(serializeRemoteInstance),
    };
  });

  fastify.post<{
    Body: {
      name?: string;
      base_url?: string;
      api_token?: string;
      remote_username?: string;
      remote_password?: string;
      enabled?: boolean;
    };
  }>('/api/remote-instances', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const name = normalizeRemoteInstanceName(request.body?.name);
    const apiToken = normalizeRemoteApiToken(request.body?.api_token);
    const remoteUsername = normalizeRemoteInstanceName(request.body?.remote_username);
    const remotePassword = normalizeRemoteApiToken(request.body?.remote_password);
    let baseUrl = '';

    try {
      baseUrl = normalizeRemoteInstanceBaseUrl(request.body?.base_url);
    } catch (error: any) {
      return reply.status(400).send({ error: error?.message || 'Invalid remote instance URL' });
    }

    if (!name) return reply.status(400).send({ error: 'name is required' });
    if (!baseUrl) return reply.status(400).send({ error: 'base_url is required' });

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    if (instances.some((instance) => instance.base_url === baseUrl)) {
      return reply.status(409).send({ error: 'A remote instance with this URL already exists' });
    }

    const now = new Date().toISOString();
    let resolvedToken = apiToken;
    if (remotePassword) {
      try {
        const auth = await authenticateRemoteInstance({
          baseUrl,
          username: remoteUsername || undefined,
          password: remotePassword,
        });
        resolvedToken = auth.token;
      } catch (error: any) {
        return reply.status(400).send({ error: error?.message || 'Failed to log into remote instance' });
      }
    }

    const candidate: RemoteInstanceRecord = {
      id: randomUUID(),
      name,
      base_url: baseUrl,
      api_token: resolvedToken,
      enabled: request.body?.enabled !== false,
      created_at: now,
      updated_at: now,
      last_checked_at: null,
      last_status: 'unknown',
      last_error: '',
    };
    const probe = await probeRemoteInstance(candidate);
    const nextInstances = instances.concat(applyProbeToRemoteInstance(candidate, probe));
    saveRemoteInstances(db, nextInstances);

    return reply.status(201).send({
      instance: serializeRemoteInstance(nextInstances[nextInstances.length - 1]),
      probe,
    });
  });

  fastify.put<{
    Params: { id: string };
    Body: {
      name?: string;
      base_url?: string;
      api_token?: string;
      remote_username?: string;
      remote_password?: string;
      enabled?: boolean;
    };
  }>('/api/remote-instances/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const existing = instances.find((instance) => instance.id === request.params.id);
    if (!existing) return reply.status(404).send({ error: 'Remote instance not found' });

    const hasName = Object.prototype.hasOwnProperty.call(request.body || {}, 'name');
    const hasBaseUrl = Object.prototype.hasOwnProperty.call(request.body || {}, 'base_url');
    const hasApiToken = Object.prototype.hasOwnProperty.call(request.body || {}, 'api_token');
    const hasRemoteUsername = Object.prototype.hasOwnProperty.call(request.body || {}, 'remote_username');
    const hasRemotePassword = Object.prototype.hasOwnProperty.call(request.body || {}, 'remote_password');
    const hasEnabled = Object.prototype.hasOwnProperty.call(request.body || {}, 'enabled');

    const name = hasName ? normalizeRemoteInstanceName(request.body?.name) : existing.name;
    const apiToken = hasApiToken ? normalizeRemoteApiToken(request.body?.api_token) : existing.api_token;
    const enabled = hasEnabled ? request.body?.enabled !== false : existing.enabled;
    const remoteUsername = hasRemoteUsername ? normalizeRemoteInstanceName(request.body?.remote_username) : '';
    const remotePassword = hasRemotePassword ? normalizeRemoteApiToken(request.body?.remote_password) : '';
    let baseUrl = existing.base_url;

    if (hasBaseUrl) {
      try {
        baseUrl = normalizeRemoteInstanceBaseUrl(request.body?.base_url);
      } catch (error: any) {
        return reply.status(400).send({ error: error?.message || 'Invalid remote instance URL' });
      }
    }

    if (!name) return reply.status(400).send({ error: 'name is required' });
    if (!baseUrl) return reply.status(400).send({ error: 'base_url is required' });
    if (instances.some((instance) => instance.id !== existing.id && instance.base_url === baseUrl)) {
      return reply.status(409).send({ error: 'A remote instance with this URL already exists' });
    }

    let resolvedToken = apiToken;
    if (remotePassword) {
      try {
        const auth = await authenticateRemoteInstance({
          baseUrl,
          username: remoteUsername || undefined,
          password: remotePassword,
        });
        resolvedToken = auth.token;
      } catch (error: any) {
        return reply.status(400).send({ error: error?.message || 'Failed to log into remote instance' });
      }
    }

    const updated: RemoteInstanceRecord = {
      ...existing,
      name,
      base_url: baseUrl,
      api_token: resolvedToken,
      enabled,
      updated_at: new Date().toISOString(),
    };
    const probe = await probeRemoteInstance(updated);
    const finalInstance = applyProbeToRemoteInstance(updated, probe);
    saveRemoteInstances(
      db,
      instances.map((instance) => (instance.id === existing.id ? finalInstance : instance))
    );

    return {
      instance: serializeRemoteInstance(finalInstance),
      probe,
    };
  });

  fastify.post<{
    Params: { id: string };
  }>('/api/remote-instances/:id/check', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const existing = instances.find((instance) => instance.id === request.params.id);
    if (!existing) return reply.status(404).send({ error: 'Remote instance not found' });

    const probe = await probeRemoteInstance(existing);
    const checked = applyProbeToRemoteInstance(existing, probe);
    saveRemoteInstances(
      db,
      instances.map((instance) => (instance.id === existing.id ? checked : instance))
    );

    return {
      instance: serializeRemoteInstance(checked),
      probe,
    };
  });

  fastify.delete<{
    Params: { id: string };
  }>('/api/remote-instances/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const db = getDatabase();
    const instances = loadRemoteInstances(db);
    const nextInstances = instances.filter((instance) => instance.id !== request.params.id);
    if (nextInstances.length === instances.length) {
      return reply.status(404).send({ error: 'Remote instance not found' });
    }
    saveRemoteInstances(db, nextInstances);
    return { ok: true };
  });

  fastify.get('/api/remote-projects', async () => {
    const db = getDatabase();
    const instances = loadRemoteInstances(db).filter((instance) => instance.enabled);
    const results = await Promise.all(
      instances.map(async (instance) => {
        const result = await fetchRemoteProjects(instance);
        return {
          instance: {
            ...serializeRemoteInstance(instance),
            runtime_status: result.status,
            runtime_error: result.error,
            project_count: result.projects.length,
          },
          projects: result.projects,
        };
      })
    );

    return {
      instances: results.map((result) => result.instance),
      projects: results.flatMap((result) => result.projects),
    };
  });
}
