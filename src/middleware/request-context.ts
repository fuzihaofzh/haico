import type { FastifyRequest } from 'fastify';
import { createProjectRequestContext } from '../services/project-access';
import type { ProjectRequestContext } from '../services/project-access';

export function getProjectRequestContext(request: FastifyRequest): ProjectRequestContext {
  return createProjectRequestContext(request.user || null);
}
