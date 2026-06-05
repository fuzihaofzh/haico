import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { config } from '../config';
import { getDirectChildAgents, loadProjectHierarchyAgents } from './agents/hierarchy';
import { resolveCommandType } from './command-profiles';
import { deriveAgentRuntimeStatus } from './tasks/runtime-state';
import { getSkill, parseCapabilities, resolvePromptFragment } from './skills';

const BASE_URL = () => `http://localhost:${config.port}`;

export function buildSystemPrompt(agent: Agent, project: Project): string {
  const db = getDatabase();
  const base = BASE_URL();
  const effectiveCommand = (agent.command_template || project.command_template || config.defaultCommandTemplate || '').trim().toLowerCase();
  const effectiveCommandType = resolveCommandType(agent.command_type, effectiveCommand);
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

  // ── Tool execution constraints (executor-type dependent, not skill-driven) ──
  const toolExecutionSection = effectiveCommandType === 'codex'
    ? `
## Codex 执行约束
- 对于需要持续运行、后续还要继续交互的命令，第一次就必须使用带 \`tty: true\` 的交互会话。典型例子：dev server、\`tail -f\`、\`watch\`、REPL、\`ssh\`、\`sqlite3\` 交互模式、\`google-chrome --headless --remote-debugging-port=...\`。
- 只有在拿到交互命令返回的 \`session_id\` 之后，才能继续对该会话调用 \`write_stdin\`。不要对已经结束、没有 tty、或 stdin 已关闭的命令会话继续写入。
- 如果命令只是一次性执行，不需要后续交互，就不要再调用 \`write_stdin\`；直接等待命令完成并读取输出。
- 需要后台服务时，优先把"启动 + 检查 + 清理"放进同一个一次性脚本里完成；除非明确需要持续交互，否则不要把浏览器、服务器、调试端口单独常驻后再尝试补写 stdin。
- 如果你看到 \`stdin is closed for this session\`、\`write_stdin failed\` 或类似提示，立刻放弃旧会话，重新创建新的 tty 会话，不要沿用出错会话。
- 做 UI/浏览器验证时，优先使用一次性脚本完成完整验证流程；只有在确实需要保持进程存活时才开交互 tty。`
    : '';

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
