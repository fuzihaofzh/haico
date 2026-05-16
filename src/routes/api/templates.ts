import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../../db/database';

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

      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as any;
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const template = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(template_id) as any;
      if (!template) return reply.status(404).send({ error: 'Template not found' });

      const data = JSON.parse(template.template_data);
      const createdAgents: any[] = [];
      const createdIssues: any[] = [];
      const agentMap: Record<string, string> = {}; // role name -> agent id

      // Create agents from template
      if (data.agents && Array.isArray(data.agents)) {
        for (const agentDef of data.agents) {
          // Check if agent with same name already exists
          const existing = db.prepare('SELECT id FROM agents WHERE project_id = ? AND name = ?').get(pid, agentDef.name) as any;
          if (existing) {
            agentMap[agentDef.name] = existing.id;
            continue;
          }

          const agentId = uuidv4();
          db.prepare(
            'INSERT INTO agents (id, project_id, name, role, working_directory) VALUES (?, ?, ?, ?, ?)'
          ).run(agentId, pid, agentDef.name, agentDef.role || '', agentDef.working_directory || project.working_directory || null);

          agentMap[agentDef.name] = agentId;
          createdAgents.push({ id: agentId, name: agentDef.name, role: agentDef.role });
        }
      }

      // Create issues from template
      if (data.issues && Array.isArray(data.issues)) {
        const lastNum = db.prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?').get(pid) as any;
        let nextNum = (lastNum?.n || 0) + 1;

        // Create parent issue for the workflow
        const parentId = uuidv4();
        const target = templateParams?.target || template.name;
        db.prepare(`
          INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status)
          VALUES (?, ?, ?, ?, ?, 'system', NULL, 5, 'open')
        `).run(parentId, pid, nextNum, `[${template.name}] ${target}`, `使用模板「${template.name}」创建的工作流。\n\n${template.description}`);
        nextNum++;

        for (const issueDef of data.issues) {
          const issueId = uuidv4();
          const assignedTo = issueDef.assigned_to_role ? (agentMap[issueDef.assigned_to_role] || null) : null;
          let body = issueDef.body || '';
          // Replace template params
          if (templateParams) {
            for (const [key, value] of Object.entries(templateParams)) {
              body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value as string);
            }
          }

          db.prepare(`
            INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, parent_id, status)
            VALUES (?, ?, ?, ?, ?, 'system', ?, 5, ?, 'open')
          `).run(issueId, pid, nextNum, issueDef.title, body, assignedTo, parentId);

          createdIssues.push({ id: issueId, number: nextNum, title: issueDef.title, assigned_to: assignedTo });
          nextNum++;
        }

        // Set parent to pending since it has children
        db.prepare("UPDATE issues SET status = 'pending' WHERE id = ?").run(parentId);
        createdIssues.unshift({ id: parentId, number: nextNum - data.issues.length - 1, title: `[${template.name}] ${target}`, is_parent: true });
      }

      return reply.status(201).send({
        template: template.name,
        created_agents: createdAgents,
        created_issues: createdIssues,
      });
    }
  );
}
