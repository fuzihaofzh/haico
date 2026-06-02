import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../../db/database';
import { applyTemplateToProject } from '../../services/templates';

export function registerTemplateRoutes(fastify: FastifyInstance): void {
  // List all templates (builtin + custom)
  fastify.get('/templates', async () => {
    const db = getDatabase();
    const templates = db.prepare('SELECT * FROM project_templates ORDER BY is_builtin DESC, created_at DESC').all();
    return { templates };
  });

  // Get single template
  fastify.get<{ Params: { id: string } }>('/templates/:id', async (request, reply) => {
    const db = getDatabase();
    const template = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(request.params.id);
    if (!template) return reply.status(404).send({ error: 'Template not found' });
    return template;
  });

  // Create custom template
  fastify.post<{ Body: { name: string; description?: string; template_data: any; created_by?: string } }>(
    '/templates',
    async (request, reply) => {
      const db = getDatabase();
      const { name, description, template_data, created_by } = request.body as any;

      if (!name) return reply.status(400).send({ error: 'name is required' });
      if (!template_data) return reply.status(400).send({ error: 'template_data is required' });

      const id = uuidv4();
      const dataStr = typeof template_data === 'string' ? template_data : JSON.stringify(template_data);

      db.prepare(
        'INSERT INTO project_templates (id, name, description, template_data, created_by, is_builtin) VALUES (?, ?, ?, ?, ?, 0)'
      ).run(id, name, description || '', dataStr, created_by || 'user');

      return reply.status(201).send(db.prepare('SELECT * FROM project_templates WHERE id = ?').get(id));
    }
  );

  // Delete custom template (cannot delete builtin)
  fastify.delete<{ Params: { id: string } }>('/templates/:id', async (request, reply) => {
    const db = getDatabase();
    const template = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(request.params.id) as any;
    if (!template) return reply.status(404).send({ error: 'Template not found' });
    if (template.is_builtin) return reply.status(403).send({ error: 'Cannot delete builtin template' });

    db.prepare('DELETE FROM project_templates WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // Apply template to a project — creates agents and issues from template
  fastify.post<{ Params: { pid: string }; Body: { template_id: string; params?: Record<string, string> } }>(
    '/projects/:pid/apply-template',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const { template_id, params: templateParams } = request.body as any;

      if (!template_id) return reply.status(400).send({ error: 'template_id is required' });

      try {
        const result = applyTemplateToProject(db, pid, template_id, templateParams);
        const templateRow = db.prepare('SELECT name FROM project_templates WHERE id = ?').get(template_id) as { name: string } | undefined;
        return reply.status(201).send({
          template: templateRow?.name || template_id,
          created_agents: result.createdAgents,
          created_issues: result.createdIssues,
        });
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    }
  );
}
