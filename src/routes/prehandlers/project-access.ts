import { FastifyRequest } from 'fastify';
import { getDatabase } from '../../db/database';
import { getProjectRequestContext } from '../../middleware/request-context';
import { requireProjectAccess } from '../../services/project-access';

interface ProjectAccessPrehandlerOptions {
  param?: string;
  manage?: boolean;
}

export function requireProjectAccessPrehandler(
  options: ProjectAccessPrehandlerOptions = {}
) {
  const paramName = options.param ?? 'pid';
  const manage = options.manage ?? false;

  return async (request: FastifyRequest) => {
    const projectId = (request.params as Record<string, string>)[paramName];
    const db = getDatabase();
    const result = requireProjectAccess(
      db,
      getProjectRequestContext(request),
      projectId,
      manage
    );
    request.projectPermission = result.permission;
  };
}
