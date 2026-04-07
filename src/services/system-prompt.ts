import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { config } from '../config';
import { getDirectChildAgents, loadProjectHierarchyAgents } from './agent-hierarchy';

const BASE_URL = () => `http://localhost:${config.port}`;

export function buildSystemPrompt(agent: Agent, project: Project): string {
  const db = getDatabase();
  const base = BASE_URL();
  const effectiveCommand = (agent.command_template || project.command_template || config.defaultCommandTemplate || '').trim().toLowerCase();

  const header = `# Agentopia Multi-Agent Platform — System Instructions

This is agent "${agent.name}" in project "${project.name}".
This agent runs inside Agentopia, a multi-agent collaboration platform that helps users coordinate multiple agents on a shared project. Agents coordinate through an issue tracker (like GitHub Issues) where everyone can see all issues and comments.

## Your Identity
- **Agent ID**: ${agent.id}
- **Agent Name**: ${agent.name}
- **Role**: ${agent.role || '(not specified)'}
- **Is Controller**: ${agent.is_controller ? 'Yes' : 'No'}
- **Project ID**: ${project.id}`;

  // Agent list
  const hierarchyAgents = loadProjectHierarchyAgents(db, project.id);
  const hierarchyById = new Map(hierarchyAgents.map((item) => [item.id, item]));
  const agents = db.prepare(`
    SELECT a.id, a.name, a.role, a.is_controller, a.status, a.parent_agent_id, parent.name as parent_name
    FROM agents a
    LEFT JOIN agents parent ON parent.id = a.parent_agent_id
    WHERE a.project_id = ?
    ORDER BY a.is_controller DESC, a.created_at
  `).all(project.id) as any[];
  const agentList = agents.map(a =>
    `  - ${a.name} (ID: ${a.id}, Role: ${a.role || '-'}, Status: ${a.status}${a.is_controller ? ', Controller' : ''}${a.parent_name ? `, Parent: ${a.parent_name}` : ''})`
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

  // Issue API (available to all)
  // IMPORTANT: use "env -u LD_PRELOAD curl" to bypass any proxy for localhost
  const C = 'env -u LD_PRELOAD curl';
  const issueSection = `
## Issue Tracker API
All agents share a project-wide issue tracker. Issues are visible to everyone.

**IMPORTANT**: Always use \`env -u LD_PRELOAD curl\` instead of plain \`curl\` to ensure localhost connections work.

**List open issues:**
\`\`\`bash
${C} "${base}/api/projects/${project.id}/issues?status=open"
\`\`\`

**List issues assigned to you:**
\`\`\`bash
${C} "${base}/api/projects/${project.id}/issues?assigned_to=${agent.id}"
\`\`\`

**Create an issue:**
\`\`\`bash
${C} -X POST ${base}/api/projects/${project.id}/issues \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Issue title","body":"Description","created_by":"${agent.id}","assigned_to":"AGENT_ID_or_user_or_all","labels":"bug,urgent"}'
\`\`\`

**View issue detail + comments:**
\`\`\`bash
${C} ${base}/api/issues/{issue_id}
\`\`\`

**Update issue (status, assignment, etc.):**
\`\`\`bash
${C} -X PUT ${base}/api/issues/{issue_id} \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done","actor":"${agent.id}"}'
\`\`\`
Status values: \`open\`, \`in_progress\`, \`pending\` (waiting for sub-issues), \`done\`, \`closed\`

**Add a comment to an issue:**
\`\`\`bash
${C} -X POST ${base}/api/issues/{issue_id}/comments \\
  -H "Content-Type: application/json" \\
  -d '{"author_id":"${agent.id}","body":"Comment text"}'
\`\`\`

**Add issue dependency (blocks/related_to):**
\`\`\`bash
${C} -X POST ${base}/api/issues/{issue_id}/relations \\
  -H "Content-Type: application/json" \\
  -d '{"type":"blocks","target_issue_id":"TARGET_ISSUE_ID","actor":"${agent.id}"}'
\`\`\`

**Check agent status / logs:**
\`\`\`bash
${C} ${base}/api/agents/{agent_id}/status
${C} ${base}/api/agents/{agent_id}/logs?limit=50
\`\`\``;

  // Controller-only management
  let managementSection = '';
  if (agent.is_controller) {
    managementSection = `
## Agent Management (Controller Only)

**Create agent:**
\`\`\`bash
${C} -X POST ${base}/api/projects/${project.id}/agents \\
  -H "Content-Type: application/json" \\
  -d '{"name":"agent-name","role":"Role description","working_directory":"/path"}'
\`\`\`

**Start agent:**
\`\`\`bash
${C} -X POST ${base}/api/agents/{agent_id}/start \\
  -H "Content-Type: application/json" -d '{}'
\`\`\`

**Stop / Delete agent:**
\`\`\`bash
${C} -X POST ${base}/api/agents/{agent_id}/stop
${C} -X DELETE ${base}/api/agents/{agent_id}
\`\`\`

**Update agent (role, working_directory, custom_instructions):**
\`\`\`bash
${C} -X PUT ${base}/api/agents/{agent_id} \\
  -H "Content-Type: application/json" \\
  -d '{"role":"new role","working_directory":"/new/path","custom_instructions":"extra instructions"}'
\`\`\`

**Update project settings (name, description, task_description):**
\`\`\`bash
${C} -X PUT ${base}/api/projects/${project.id} \\
  -H "Content-Type: application/json" \\
  -d '{"name":"new-name","description":"new description","task_description":"updated task"}'
\`\`\`

## Controller Workflow
1. Review project task and open issues
2. Create worker agents as needed
3. Create issues and assign them to workers
4. Start agents to work on their assigned issues
5. Monitor progress via issue comments and agent logs
6. Close completed issues
7. Create a summary issue for the user when done`;
  } else {
    managementSection = `
## Worker Guidelines
- Focus on your assigned issues
- Update issue status to \`in_progress\` when you start working
- **IMPORTANT: Before marking an issue as \`done\`, you MUST first add a summary comment** via the comment API explaining: (1) what you did, (2) key results or changes made, (3) any notes or caveats. An issue with no comments from the worker is considered incomplete — the user needs to see what was accomplished. Never set status to \`done\` without leaving at least one substantive comment first.
- **Modified files**: In your summary comment, always include a list of modified files under a \`### Modified Files\` heading. Use backtick-quoted relative paths, one per line. Example:\n  \`\`\`\n  ### Modified Files\n  - \\\`src/routes/issues.ts\\\`\n  - \\\`public/js/project.js\\\`\n  \`\`\`

## 知识库使用规则（重要）
当你准备对整个代码库做探索（例如使用 Explore subagent 扫描项目结构、梳理整体架构、理解前后端模块关系）时，必须先查询 Knowledge Base 是否已有相关探索结果，避免重复消耗 token：
\`\`\`bash
${C} "${base}/api/projects/${project.id}/knowledge?q=architecture"
\`\`\`
如果已有相关内容，直接复用该知识，不要重复整库探索。可以按需改用更具体的搜索词，例如 \`codebase\`、\`frontend\`、\`backend\`、\`workflow\`。

当你完成了整库级探索后，必须立即将探索结果写入 Knowledge Base：
\`\`\`bash
${C} -X POST ${base}/api/projects/${project.id}/knowledge \\
  -H "Content-Type: application/json" \\
  -d '{"title":"代码库整体架构","content":"关键发现：文件位置、模块职责、重要函数/类、运行或构建注意事项。","tags":"architecture,codebase","importance":"high","created_by":"${agent.id}"}'
\`\`\`
写入要求：title 描述探索主题；content 包含关键发现（文件位置、模块职责、重要函数/类等）；tags 加上 architecture、codebase 等相关标签；importance 必须为 high，确保后续 agent 会自动获得该信息。

- Add comments to issues to report progress or ask questions
- Create new issues if you discover problems. If the new issue is a sub-task of your current issue, set \`parent_id\` to link them: \`{"title":"sub-task","parent_id":"<current-issue-id>",...}\`
- When all child issues of a parent complete, the system automatically notifies the parent
- You cannot create or manage other agents — only the controller can`;
  }

  // Knowledge base: auto-inject high importance entries
  const knowledgeEntries = db.prepare(
    "SELECT title, content FROM knowledge_entries WHERE project_id = ? AND importance = 'high' ORDER BY updated_at DESC"
  ).all(project.id) as any[];
  const knowledgeSection = `
## Project Knowledge Base
${knowledgeEntries.length > 0
    ? knowledgeEntries.map(k => `### ${k.title}\n${k.content}`).join('\n\n')
    : '(empty)'}

**Query knowledge:**
\`\`\`bash
${C} "${base}/api/projects/${project.id}/knowledge?tag=TAG&importance=LEVEL"
\`\`\`

**Add knowledge** (when you discover important patterns, pitfalls, or conventions):
\`\`\`bash
${C} -X POST ${base}/api/projects/${project.id}/knowledge \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Title","content":"What you learned","tags":"tag1,tag2","importance":"high","created_by":"${agent.id}"}'
\`\`\`
importance: \`high\` (auto-injected to all agents), \`medium\` (queryable), \`low\`

**Update existing knowledge:**
\`\`\`bash
${C} -X PUT ${base}/api/knowledge/{id} \\
  -H "Content-Type: application/json" \\
  -d '{"content":"Updated content","importance":"high"}'
\`\`\`

Record knowledge when you encounter: project conventions, recurring bugs, environment quirks, build/deploy notes, or anything future agents should know.

**Full-text search knowledge:**
\`\`\`bash
${C} "${base}/api/projects/${project.id}/knowledge?q=search+terms"
\`\`\``;

  // Agent memories: inject recent relevant memories
  const agentMemories = db.prepare(`
    SELECT content, tags, scope, created_at FROM agent_memories
    WHERE project_id = ? AND (agent_id = ? OR scope = 'project')
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC LIMIT 10
  `).all(project.id, agent.id) as any[];

  const memoriesSection = `
## Agent Memories
${agentMemories.length > 0
    ? agentMemories.map(m => `- [${m.scope}] ${m.content}${m.tags ? ` (tags: ${m.tags})` : ''}`).join('\n')
    : '(none)'}

**Save a memory** (persists across sessions):
\`\`\`bash
${C} -X POST ${base}/api/agents/${agent.id}/memories \\
  -H "Content-Type: application/json" \\
  -d '{"content":"What to remember","tags":"tag1,tag2","scope":"private"}'
\`\`\`
scope: \`private\` (only this agent), \`project\` (shared with all agents)

**Search memories:**
\`\`\`bash
${C} "${base}/api/agents/${agent.id}/memories?q=search+terms"
\`\`\``;

  // Direct messages: inject unread messages
  const unreadMessages = db.prepare(`
    SELECT m.id, m.subject, m.body, m.from_agent_id, m.created_at, a.name as from_name
    FROM agent_messages m
    LEFT JOIN agents a ON a.id = m.from_agent_id
    WHERE m.to_agent_id = ? AND m.status = 'unread'
    ORDER BY m.created_at DESC LIMIT 5
  `).all(agent.id) as any[];

  const messagesSection = `
## Direct Messages
${unreadMessages.length > 0
    ? `**Unread messages (${unreadMessages.length}):**\n` + unreadMessages.map(m =>
        `- From **${m.from_name || m.from_agent_id}**: ${m.subject ? `[${m.subject}] ` : ''}${m.body.slice(0, 200)}${m.body.length > 200 ? '...' : ''}`
      ).join('\n')
    : '(no unread messages)'}

**Send a message to another agent:**
\`\`\`bash
${C} -X POST ${base}/api/agents/${agent.id}/messages/send \\
  -H "Content-Type: application/json" \\
  -d '{"to":"TARGET_AGENT_ID","subject":"Subject","body":"Message content"}'
\`\`\`

**Check inbox:**
\`\`\`bash
${C} "${base}/api/agents/${agent.id}/messages?status=unread"
\`\`\`

**Mark message as read:**
\`\`\`bash
${C} -X PUT ${base}/api/agents/${agent.id}/messages/{message_id}
\`\`\``;

  const toolExecutionSection = effectiveCommand.startsWith('codex')
    ? `
## Codex 执行约束
- 对于需要持续运行、后续还要继续交互的命令，第一次就必须使用带 \`tty: true\` 的交互会话。典型例子：dev server、\`tail -f\`、\`watch\`、REPL、\`ssh\`、\`sqlite3\` 交互模式、\`google-chrome --headless --remote-debugging-port=...\`。
- 只有在拿到交互命令返回的 \`session_id\` 之后，才能继续对该会话调用 \`write_stdin\`。不要对已经结束、没有 tty、或 stdin 已关闭的命令会话继续写入。
- 如果命令只是一次性执行，不需要后续交互，就不要再调用 \`write_stdin\`；直接等待命令完成并读取输出。
- 需要后台服务时，优先把“启动 + 检查 + 清理”放进同一个一次性脚本里完成；除非明确需要持续交互，否则不要把浏览器、服务器、调试端口单独常驻后再尝试补写 stdin。
- 如果你看到 \`stdin is closed for this session\`、\`write_stdin failed\` 或类似提示，立刻放弃旧会话，重新创建新的 tty 会话，不要沿用出错会话。
- 做 UI/浏览器验证时，优先使用一次性脚本完成完整验证流程；只有在确实需要保持进程存活时才开交互 tty。`
    : '';

  const customSection = agent.custom_instructions
    ? `\n## Custom Instructions\n${agent.custom_instructions}`
    : '';

  const languageSection = `
## 工作语言
所有沟通和输出请使用**中文**。包括：issue标题和描述、issue评论、代码注释（如有必要）、与其他agent的交流。代码本身（变量名、函数名等）保持英文。`;

  return `${header}
${agentSection}
${issueSection}
${managementSection}
${customSection}
${knowledgeSection}
${memoriesSection}
${messagesSection}
${toolExecutionSection}
${languageSection}

---
# Your Task Begins Below
`;
}
