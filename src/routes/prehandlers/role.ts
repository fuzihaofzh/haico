import { FastifyRequest } from 'fastify';
import { AdminRoleRequiredError } from '../../services/auth/errors';

export function requireAdminRolePrehandler() {
  return async (request: FastifyRequest) => {
    const user = request.user;
    if (!user || user.role !== 'admin') {
      throw new AdminRoleRequiredError();
    }
  };
}
