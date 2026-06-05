import { FastifyInstance } from 'fastify';
import { listSkills } from '../../services/skills';

export function registerSkillRoutes(fastify: FastifyInstance): void {
  fastify.get('/skills', async (_request, reply) => {
    return listSkills();
  });
}
