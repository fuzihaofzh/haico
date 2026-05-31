import { FastifyRequest } from 'fastify';
import { getDatabase } from '../../db/database';
import { findRemoteInstanceById } from '../../services/remote-instances';
import { RemoteInstanceNotFoundError, RemoteInstanceDisabledError } from '../../services/remote-instances/errors';

interface RemoteInstancePrehandlerOptions {
  param?: string;
  requireEnabled?: boolean;
}

export function requireRemoteInstancePrehandler(
  options: RemoteInstancePrehandlerOptions = {}
) {
  const paramName = options.param ?? 'instanceId';
  const requireEnabled = options.requireEnabled ?? false;

  return async (request: FastifyRequest) => {
    const instanceId = (request.params as Record<string, string>)[paramName];
    const db = getDatabase();
    const instance = findRemoteInstanceById(db, instanceId);
    if (!instance) {
      throw new RemoteInstanceNotFoundError();
    }
    if (requireEnabled && !instance.enabled) {
      throw new RemoteInstanceDisabledError();
    }
    request.resolvedRemoteInstance = instance;
  };
}
