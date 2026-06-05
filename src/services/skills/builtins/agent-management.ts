import type { SkillDefinition, SkillPromptContext } from '../types';

const agentManagementSkill: SkillDefinition = {
  id: 'agent-management',
  description: 'Controller 专属：创建、启动、停止、删除 agent，管理项目设置',
  promptFragment(ctx: SkillPromptContext): string {
    const { project, baseUrl: base, curl: C } = ctx;

    return `
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
  },
};

export default agentManagementSkill;
