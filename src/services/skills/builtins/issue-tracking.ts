import type { SkillDefinition, SkillPromptContext } from '../types';

const issueTrackingSkill: SkillDefinition = {
  id: 'issue-tracking',
  description: '读写项目 issue tracker：创建、查询、更新 issue 和评论',
  promptFragment(ctx: SkillPromptContext): string {
    const { agent, project, baseUrl: base, curl: C } = ctx;
    return `
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

**View issue detail + comments by UUID** (\`issue_id\` means the long UUID, not \`#123\`):
\`\`\`bash
${C} ${base}/api/issues/{issue_id}
\`\`\`

**View issue detail by issue number** (when you only have \`#123\` from a prompt or comment):
\`\`\`bash
${C} ${base}/api/projects/${project.id}/issues/number/{issue_number}
\`\`\`

**Update issue (status, assignment, etc.):**
\`\`\`bash
${C} -X PUT ${base}/api/issues/{issue_id} \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done","actor":"${agent.id}"}'
\`\`\`
Status values: \`open\`, \`in_progress\`, \`pending\` (waiting for sub-issues), \`done\`, \`closed\`
If you only know an issue number, fetch it via the by-number endpoint first and then use the returned UUID for update/comment APIs.

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
  },
};

export default issueTrackingSkill;
