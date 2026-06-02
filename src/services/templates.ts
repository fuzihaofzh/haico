import Database from 'better-sqlite3';
import { createAgent } from './agents/core';
import { createIssue } from './issue/core';
import { ProjectNotFoundError } from './projects/errors';

class TemplateNotFoundError extends Error {
  constructor() {
    super('Template not found');
  }
}

export function applyTemplateToProject(
  db: Database.Database,
  projectId: string,
  templateId: string,
  templateParams?: Record<string, string>
): { createdAgents: any[]; createdIssues: any[] } {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) throw new ProjectNotFoundError();

  const template = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(templateId) as any;
  if (!template) throw new TemplateNotFoundError();

  const data = JSON.parse(template.template_data);
  const createdAgents: any[] = [];
  const createdIssues: any[] = [];
  const agentMap: Record<string, string> = {};

  if (data.agents && Array.isArray(data.agents)) {
    for (const agentDef of data.agents) {
      const existing = db.prepare('SELECT id FROM agents WHERE project_id = ? AND name = ?').get(projectId, agentDef.name) as any;
      if (existing) {
        agentMap[agentDef.name] = existing.id;
        continue;
      }

      const agent = createAgent(projectId, {
        name: agentDef.name,
        role: agentDef.role,
        working_directory: agentDef.working_directory || project.working_directory,
      });
      agentMap[agentDef.name] = agent.id;
      createdAgents.push({ id: agent.id, name: agent.name, role: agent.role });
    }
  }

  if (data.issues && Array.isArray(data.issues)) {
    const target = templateParams?.target || template.name;
    const parentIssue = createIssue(db, projectId, {
      title: `[${template.name}] ${target}`,
      body: `使用模板「${template.name}」创建的工作流。\n\n${template.description}`,
      created_by: 'system',
    });

    for (const issueDef of data.issues) {
      const assignedTo = issueDef.assigned_to_role ? (agentMap[issueDef.assigned_to_role] || null) : null;
      let body = issueDef.body || '';
      if (templateParams) {
        for (const [key, value] of Object.entries(templateParams)) {
          body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value as string);
        }
      }
      const issue = createIssue(db, projectId, {
        title: issueDef.title,
        body,
        created_by: 'system',
        assigned_to: assignedTo || undefined,
        parent_id: parentIssue.id,
      });
      createdIssues.push({ id: issue.id, number: issue.number, title: issue.title, assigned_to: assignedTo });
    }

    createdIssues.unshift({ id: parentIssue.id, number: parentIssue.number, title: parentIssue.title, is_parent: true });
  }

  return { createdAgents, createdIssues };
}
