import { FastifyRequest } from 'fastify';
import { isLocalhostBypassRequest } from '../auth/localhost-bypass';
import { getRequestUser } from '../auth/request';
import { ProjectRequestContext } from './types';

export function getProjectRequestContext(request: FastifyRequest): ProjectRequestContext {
  return {
    user: getRequestUser(request),
    localhostBypass: isLocalhostBypassRequest(request),
  };
}
