import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { config } from '../config';

const BASE_URL = () => `http://localhost:${config.port}`;

export function buildSystemPrompt(agent: Agent, project: Project): string {
  const db = getDatabase();
  const base = BASE_URL();

  const header = `# Argus Multi-Agent Platform — System Instructions

You are agent "${agent.name}" in project "${project.name}".
You are running inside Argus, a multi-agent collaboration platform. Multiple agents work together on a shared project. You coordinate through an issue tracker (like GitHub Issues) where everyone can see all issues and comments.

## Your Identity
- **Agent ID**: ${agent.id}
- **Agent Name**: ${agent.name}
- **Role**: ${agent.role || '(not specified)'}
- **Is Controller**: ${agent.is_controller ? 'Yes' : 'No'}
- **Project ID**: ${project.id}`;

  // Agent list
  const agents = db.prepare('SELECT id, name, role, is_controller, status FROM agents WHERE project_id = ?').all(project.id) as any[];
  const agentList = agents.map(a =>
    `  - ${a.name} (ID: ${a.id}, Role: ${a.role || '-'}, Status: ${a.status}${a.is_controller ? ', Controller' : ''})`
  ).join('\n');

  const agentSection = `
## Agents
${agentList || '  (none)'}`;

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
- Update issue status when you start (\`in_progress\`) and finish (\`done\`)
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
${languageSection}

---
# Your Task Begins Below
`;
}
