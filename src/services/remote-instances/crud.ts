import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BaseLogger } from 'pino';
type Logger = BaseLogger;
import {
  loadRemoteInstances,
  saveRemoteInstances,
  normalizeRemoteInstanceName,
  normalizeRemoteInstanceBaseUrl,
  serializeRemoteInstance,
  applyProbeToRemoteInstance,
  type RemoteInstanceRecord,
  type RemoteInstanceProbeResult,
} from './core';
import { authenticateRemoteInstance, probeRemoteInstance } from './proxy';
import { RemoteInstanceNotFoundError } from './errors';

export function normalizeRemoteApiToken(value: unknown): string {
  return String(value || '').trim();
}

export interface CreateRemoteInstanceInput {
  name?: string;
  base_url?: string;
  api_token?: string;
  remote_username?: string;
  remote_password?: string;
  enabled?: boolean;
}

export interface UpdateRemoteInstanceInput {
  name?: string;
  base_url?: string;
  api_token?: string;
  remote_username?: string;
  remote_password?: string;
  enabled?: boolean;
}

export async function createRemoteInstance(
  db: Database.Database,
  input: CreateRemoteInstanceInput,
  logger: Logger,
): Promise<{ instance: RemoteInstanceRecord; probe: RemoteInstanceProbeResult }> {
  const name = normalizeRemoteInstanceName(input.name);
  const apiToken = normalizeRemoteApiToken(input.api_token);
  const remoteUsername = normalizeRemoteInstanceName(input.remote_username);
  const remotePassword = normalizeRemoteApiToken(input.remote_password);
  const baseUrl = normalizeRemoteInstanceBaseUrl(input.base_url);

  if (!name) throw new Error('name is required');
  if (!baseUrl) throw new Error('base_url is required');

  const instances = loadRemoteInstances(db);
  if (instances.some((instance) => instance.base_url === baseUrl)) {
    throw new Error('A remote instance with this URL already exists');
  }

  let resolvedToken = apiToken;
  if (remotePassword) {
    const auth = await authenticateRemoteInstance({
      baseUrl,
      username: remoteUsername || undefined,
      password: remotePassword,
    });
    resolvedToken = auth.token;
  }

  const now = new Date().toISOString();
  const candidate: RemoteInstanceRecord = {
    id: randomUUID(),
    name,
    base_url: baseUrl,
    api_token: resolvedToken,
    enabled: input.enabled !== false,
    created_at: now,
    updated_at: now,
    last_checked_at: null,
    last_status: 'unknown',
    last_error: '',
  };
  const probe = await probeRemoteInstance(candidate);
  const nextInstances = instances.concat(applyProbeToRemoteInstance(candidate, probe));
  saveRemoteInstances(db, nextInstances);
  const saved = nextInstances[nextInstances.length - 1];
  logger.info({
    remoteInstanceId: saved.id,
    enabled: saved.enabled,
    probeOk: probe.ok,
    projectCount: probe.projectCount,
  }, 'remote_instance.created');

  return { instance: saved, probe };
}

export async function updateRemoteInstance(
  db: Database.Database,
  id: string,
  input: UpdateRemoteInstanceInput,
  logger: Logger,
): Promise<{ instance: RemoteInstanceRecord; probe: RemoteInstanceProbeResult }> {
  const instances = loadRemoteInstances(db);
  const existing = instances.find((instance) => instance.id === id);
  if (!existing) throw new RemoteInstanceNotFoundError();

  const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
  const hasBaseUrl = Object.prototype.hasOwnProperty.call(input, 'base_url');
  const hasApiToken = Object.prototype.hasOwnProperty.call(input, 'api_token');
  const hasRemoteUsername = Object.prototype.hasOwnProperty.call(input, 'remote_username');
  const hasRemotePassword = Object.prototype.hasOwnProperty.call(input, 'remote_password');
  const hasEnabled = Object.prototype.hasOwnProperty.call(input, 'enabled');

  const name = hasName ? normalizeRemoteInstanceName(input.name) : existing.name;
  const apiToken = hasApiToken ? normalizeRemoteApiToken(input.api_token) : existing.api_token;
  const enabled = hasEnabled ? input.enabled !== false : existing.enabled;
  const remoteUsername = hasRemoteUsername ? normalizeRemoteInstanceName(input.remote_username) : '';
  const remotePassword = hasRemotePassword ? normalizeRemoteApiToken(input.remote_password) : '';
  let baseUrl = existing.base_url;

  if (hasBaseUrl) {
    baseUrl = normalizeRemoteInstanceBaseUrl(input.base_url);
  }

  if (!name) throw new Error('name is required');
  if (!baseUrl) throw new Error('base_url is required');
  if (instances.some((instance) => instance.id !== existing.id && instance.base_url === baseUrl)) {
    throw new Error('A remote instance with this URL already exists');
  }

  let resolvedToken = apiToken;
  if (remotePassword) {
    const auth = await authenticateRemoteInstance({
      baseUrl,
      username: remoteUsername || undefined,
      password: remotePassword,
    });
    resolvedToken = auth.token;
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
    instances.map((instance) => (instance.id === existing.id ? finalInstance : instance)),
  );
  logger.info({
    remoteInstanceId: finalInstance.id,
    enabled: finalInstance.enabled,
    probeOk: probe.ok,
    projectCount: probe.projectCount,
  }, 'remote_instance.updated');

  return { instance: finalInstance, probe };
}

export async function checkRemoteInstance(
  db: Database.Database,
  id: string,
  logger: Logger,
): Promise<{ instance: RemoteInstanceRecord; probe: RemoteInstanceProbeResult }> {
  const instances = loadRemoteInstances(db);
  const existing = instances.find((instance) => instance.id === id);
  if (!existing) throw new RemoteInstanceNotFoundError();

  const probe = await probeRemoteInstance(existing);
  const checked = applyProbeToRemoteInstance(existing, probe);
  saveRemoteInstances(
    db,
    instances.map((instance) => (instance.id === existing.id ? checked : instance)),
  );
  logger.info({
    remoteInstanceId: checked.id,
    enabled: checked.enabled,
    probeOk: probe.ok,
    projectCount: probe.projectCount,
  }, 'remote_instance.checked');

  return { instance: checked, probe };
}

export function deleteRemoteInstance(
  db: Database.Database,
  id: string,
  logger: Logger,
): boolean {
  const instances = loadRemoteInstances(db);
  const nextInstances = instances.filter((instance) => instance.id !== id);
  if (nextInstances.length === instances.length) {
    throw new RemoteInstanceNotFoundError();
  }
  saveRemoteInstances(db, nextInstances);
  logger.info({ remoteInstanceId: id }, 'remote_instance.deleted');
  return true;
}
