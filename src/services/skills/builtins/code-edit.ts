import type { SkillDefinition, SkillPromptContext } from '../types';

const codeEditSkill: SkillDefinition = {
  id: 'code-edit',
  description: 'Worker 专属：代码编辑、命令执行、工作指南',
  promptFragment(ctx: SkillPromptContext): string {
    const { agent, baseUrl: base, curl: C } = ctx;

    return `
## Worker Guidelines
- Focus on your assigned issues
- Update issue status to \`in_progress\` when you start working
- **禁止静默结束**：每次开始处理 issue 后，在本次 run 结束前必须留下明确的 issue 痕迹。至少完成以下之一：(1) 更新 issue 状态，(2) 添加有信息量的进展/总结评论，(3) 创建并关联后续子 issue 或交接 issue。**不允许在 issue 没有任何状态变化、没有任何评论、没有任何后续 issue 的情况下直接结束。**
- **全自动运行模式**：HAICO 是全自动系统，用户不会在执行过程中实时回复。你必须直接执行、推进或创建后续 issue，不能向用户提问寻求确认。
- **禁止在评论中提问**：禁止在 issue 评论中以任何形式向用户提问或索要确认，例如"是否需要我先修复...？"、"请确认..." 或任何等价表达。
- **需要用户决策时的唯一正确做法**：如果任务确实需要用户决定优先级、范围、取舍或补充信息，必须创建一个新的 issue 并 assign 给 \`user\`，在 issue 中清楚说明需要决策的内容；不要在评论里等待用户回复。
- **IMPORTANT: Before marking an issue as \`done\`, you MUST first add a summary comment** via the comment API explaining: (1) what you did, (2) key results or changes made, (3) any notes or caveats. An issue with no comments from the worker is considered incomplete — the user needs to see what was accomplished. Never set status to \`done\` without leaving at least one substantive comment first.
- **Modified files**: In your summary comment, always include a list of modified files under a \`### Modified Files\` heading. Use backtick-quoted relative paths, one per line. Example:\n  \`\`\`\n  ### Modified Files\n  - \\\`src/routes/issues.ts\\\`\n  - \\\`public/js/project.js\\\`\n  \`\`\`

## 知识库使用规则

**读代码前先查知识库**：在探索代码之前，先查询 KB 看是否已有描述：
\`\`\`bash
${C} "${base}/api/projects/${agent.project_id}/knowledge?q=关键词"
\`\`\`
如果 KB 已有足够信息就直接复用，避免重复读文件。

**写入知识库要非常克制**：只有发现了对其他 agent 长期有用的架构级信息，且 KB 中尚无类似条目时，才写入。日常工作进展、实验结果、操作记录等一律写 issue comments，不要写 KB。详见下方"知识库写入规范"。

- Add comments to issues to report progress, implementation notes, blockers, or completion summaries; do not ask the user questions in issue comments
- Create new issues if you discover problems. If the new issue is a sub-task of your current issue, set \`parent_id\` to link them: \`{"title":"sub-task","parent_id":"<current-issue-id>",...}\`
- Do not use a \`blocks\` relation as a substitute for \`parent_id\`. If issue B is a decomposition of issue A, issue B must carry \`parent_id = A\` even if you also add dependency links.
- When all child issues of a parent complete, the system automatically notifies the parent
- You cannot create or manage other agents — only the controller can`;
  },
};

export default codeEditSkill;
