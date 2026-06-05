import type { SkillDefinition, SkillPromptContext } from '../types';
import { getDatabase } from '../../../db/database';
import { ensureAgentKnowledgeEntry } from '../../knowledge/agent-memory';

interface KnowledgeEntryRow { title: string; content: string; }

const knowledgeBaseSkill: SkillDefinition = {
  id: 'knowledge-base',
  description: '查询和写入项目知识库，包括项目级共享知识和 agent 专属知识',
  memoryStrategy: 'reduce',
  promptFragment(ctx: SkillPromptContext): string {
    const { agent, project, baseUrl: base, curl: C } = ctx;
    const db = getDatabase();

    const knowledgeEntries = db.prepare(
      `SELECT title, content
       FROM knowledge_entries
       WHERE project_id = ?
         AND owner_agent_id IS NULL
         AND importance = 'high'
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at >= datetime('now'))
       ORDER BY updated_at DESC`
    ).all(project.id) as KnowledgeEntryRow[];

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
  -d '{"title":"Title","content":"What you learned","tags":"tag1,tag2","importance":"high","category":"architecture","created_by":"${agent.id}"}'
\`\`\`
importance: \`high\` (auto-injected to all agents), \`medium\` (queryable), \`low\`
category: \`architecture\`, \`convention\`, \`bug\`, \`environment\`, \`code\`, \`reference\`

**Verify knowledge** (when you used an entry and confirmed it is still accurate):
\`\`\`bash
${C} -X POST ${base}/api/knowledge/{id}/verify \\
  -H "Content-Type: application/json" \\
  -d '{"verified_by":"${agent.id}"}'
\`\`\`

**Update existing knowledge:**
\`\`\`bash
${C} -X PUT ${base}/api/knowledge/{id} \\
  -H "Content-Type: application/json" \\
  -d '{"content":"Updated content","importance":"high","category":"architecture","verified_by":"${agent.id}"}'
\`\`\`

Knowledge maintenance rules:
- When you query and use a KB entry, call the verify API if the content is still accurate.
- When you find a KB entry is outdated or conflicts with the current code, update it instead of relying on it.
- When you create a KB entry, choose a category so the lifecycle policy can expire it correctly.

**Full-text search knowledge:**
\`\`\`bash
${C} "${base}/api/projects/${project.id}/knowledge?q=search+terms"
\`\`\`

## ⚠️ 知识库写入规范（严格遵守 — 违规写入浪费所有 agent 的 token）

知识库的每一条 high importance 条目都会被注入到所有 agent 的 system prompt 中，直接增加每次调用的 token 消耗。因此必须严格控制写入。

### 该写入知识库的（长期有效、跨 session 复用）：
- **项目架构概览**：项目做什么、核心模块、目录结构（每个项目/子项目最多 1 条）
- **长期有效的约定和规范**：编码规范、命名约定、工作流程、API 协议
- **环境陷阱**：GPU 配置、内存限制、离线环境注意事项等长期不变的信息
- **已验证的结构性结论**：如"某方法已被证明不可行（附原因）"

### 绝对不要写入知识库的：
- ❌ **操作日志**：几点几分跑了什么命令、结果是什么（这些属于 issue comments）
- ❌ **Issue 级别的进展快照**：如"issue #123 的实验结果"（这些属于 issue comments）
- ❌ **审稿/评审结论快照**：如"当前评分 6.5/10"（会过时）
- ❌ **临时状态**：如"当前 frontier 推进到 xxx"、"当前代码还没整合 xxx"
- ❌ **代码细节路径**：具体函数名、行号（代码会变，直接读代码更准确）
- ❌ **重复内容**：写之前先搜索，已有类似条目就更新而不是新建

### 写入前检查清单：
1. 这条信息 6 个月后还有用吗？→ 否则不要写
2. 这条信息已经在某个 issue comment 里了吗？→ 是则不要重复写到 KB
3. KB 里已经有类似条目了吗？→ 有则更新，不要新建
4. 设为 high importance 是必要的吗？→ 非核心信息用 medium（不会注入 prompt）`;

    const agentKnowledgeEntry = ensureAgentKnowledgeEntry(db, agent);
    const agentKnowledgeSection = `
## Your Owned Knowledge Base Item
### ${agentKnowledgeEntry.title}
${agentKnowledgeEntry.content || '(empty)'}

**必须长期维护这条 owner knowledge：**
- 这是你的专属知识项，只注入给你自己，不会注入给其他 agent。
- 这条知识应该记录：你的主要职责、常做任务、常用资源路径、常用命令、关键代码架构认知、长期有效的注意事项。
- 开始工作前，先读取这条 knowledge；如果已有相关内容，优先复用，不要每次都重新摸索。
- **在准备结束当前任务、准备把 issue 标记为 \`done\`、准备输出 final result 之前，必须先更新这条 knowledge。**
- 不要把一次性进展、实验日志、临时结论写进这条 knowledge；这些内容应该写到 issue comments。

**Read your owned knowledge item:**
\`\`\`bash
${C} "${base}/api/agents/${agent.id}/knowledge-memory"
\`\`\`

**Update your owned knowledge item** (upsert; same item will be rewritten in place):
\`\`\`bash
${C} -X PUT ${base}/api/agents/${agent.id}/knowledge-memory \\
  -H "Content-Type: application/json" \\
  -d '{"content":"Updated long-term knowledge","tags":"agent-profile,commands,architecture","category":"reference","importance":"medium","verified_by":"${agent.id}"}'
\`\`\`

**Query your owned knowledge via project KB filter:**
\`\`\`bash
${C} "${base}/api/projects/${project.id}/knowledge?owner_agent_id=${agent.id}"
\`\`\``;

    return knowledgeSection + '\n' + agentKnowledgeSection;
  },
};

export default knowledgeBaseSkill;
