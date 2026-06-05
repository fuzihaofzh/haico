import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { config } from '../config';
import { getDirectChildAgents, loadProjectHierarchyAgents } from './agents/hierarchy';
import { getAdapterRegistry } from './adapters';
import { deriveAgentRuntimeStatus } from './tasks/runtime-state';
import { getSkill, parseCapabilities, resolvePromptFragment } from './skills';

const BASE_URL = () => `http://localhost:${config.port}`;

export function buildSystemPrompt(agent: Agent, project: Project): string {
  const db = getDatabase();
  const base = BASE_URL();
  const effectiveCommand = (agent.command_template || project.command_template || config.defaultCommandTemplate || '').trim();
  const adapter = getAdapterRegistry().resolveFromCommand(effectiveCommand, agent.command_type);
  const C = 'env -u LD_PRELOAD curl';

  // ── Header: identity (always present, not skill-driven) ──
  const header = `# Human-Agent Interactive Collaboration Orchestrator (HAICO) — System Instructions

This is agent "${agent.name}" in project "${project.name}".
This agent runs inside HAICO, the Human-Agent Interactive Collaboration Orchestrator that helps users coordinate multiple agents on a shared project. Agents coordinate through an issue tracker (like GitHub Issues) where everyone can see all issues and comments.

## Your Identity
- **Agent ID**: ${agent.id}
- **Agent Name**: ${agent.name}
- **Role**: ${agent.role || '(not specified)'}
- **Is Controller**: ${agent.is_controller ? 'Yes' : 'No'}
- **Project ID**: ${project.id}`;

  // ── Agent list + hierarchy (always present, not skill-driven) ──
  const hierarchyAgents = loadProjectHierarchyAgents(db, project.id);
  const hierarchyById = new Map(hierarchyAgents.map((item) => [item.id, item]));
  const agents = db.prepare(`
    SELECT a.id, a.name, a.role, a.is_controller, a.paused, a.constraints_json, a.parent_agent_id, parent.name as parent_name
    FROM agents a
    LEFT JOIN agents parent ON parent.id = a.parent_agent_id
    WHERE a.project_id = ?
    ORDER BY a.is_controller DESC, a.created_at
  `).all(project.id) as Array<{ id: string; name: string; role: string; is_controller: number; paused: number; constraints_json: string; parent_agent_id: string | null; parent_name: string | null }>;
  const agentList = agents.map(a =>
    `  - ${a.name} (ID: ${a.id}, Role: ${a.role || '-'}, Status: ${deriveAgentRuntimeStatus(db, a)}${a.is_controller ? ', Controller' : ''}${a.parent_name ? `, Parent: ${a.parent_name}` : ''})`
  ).join('\n');
  const parentAgent = agent.parent_agent_id ? hierarchyById.get(agent.parent_agent_id) || null : null;
  const directChildren = getDirectChildAgents(hierarchyAgents, agent.id);
  const hierarchyNotes: string[] = [];
  if (parentAgent) {
    hierarchyNotes.push(`- 你的直接上级是 ${parentAgent.name}（ID: ${parentAgent.id}）`);
  }
  if (directChildren.length > 0) {
    hierarchyNotes.push(`- 你的直接下属：${directChildren.map((child) => `${child.name}（ID: ${child.id}）`).join('、')}`);
  }
  if (agent.parent_agent_id) {
    hierarchyNotes.push('- 通信限制：只能通过消息与直接上级或直接下属沟通，不能跨级通信。');
  }

  const agentSection = `
## Agents
${agentList || '  (none)'}${hierarchyNotes.length > 0 ? `\n\n### Hierarchy\n${hierarchyNotes.join('\n')}` : ''}`;

  // ── Skill-driven prompt sections ──
  const skillIds = parseCapabilities(agent.capabilities_json);
  const ctx = { agent, project, baseUrl: base, curl: C };
  const skillSections: string[] = [];
  for (const skillId of skillIds) {
    const skill = getSkill(skillId);
    if (skill) {
      const fragment = resolvePromptFragment(skill, ctx);
      if (fragment) skillSections.push(fragment);
    }
  }

  // ── Tool execution constraints (adapter-type dependent, not skill-driven) ──
  const toolExecutionSection = adapter.buildSystemPromptSection(agent, project);

  // ── Agent-level sections (not skill-driven) ──
  const customSection = agent.custom_instructions
    ? `\n## Custom Instructions\n${agent.custom_instructions}`
    : '';

  const languageSection = `
## 工作语言
所有沟通和输出请使用**中文**。包括：issue标题和描述、issue评论、代码注释（如有必要）、与其他agent的交流。代码本身（变量名、函数名等）保持英文。`;

  return `${header}
${agentSection}
${skillSections.join('\n')}
${customSection}
${toolExecutionSection}
${languageSection}

---
# Your Task Begins Below
`;
}
