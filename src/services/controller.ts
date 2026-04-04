import { getDatabase } from '../db/database';
import { Agent, Project, Issue } from '../types';
import { startControllerOrchestration } from './orchestrator';
import logger from '../logger';

const TRIGGER_DEBOUNCE_MS = 180000; // 3 minutes — reduce idle triggers to save cost

function buildActivitySnapshot(projectId: string): string {
  const db = getDatabase();

  const issueStats = db.prepare(
    `SELECT
      COUNT(*) AS active_count,
      SUM(CASE WHEN assigned_to IS NULL OR assigned_to = 'all' THEN 1 ELSE 0 END) AS unassigned_count,
      SUM(CASE WHEN assigned_to = 'user' THEN 1 ELSE 0 END) AS user_waiting_count,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
      MAX(updated_at) AS issue_updated_max
    FROM issues
    WHERE project_id = ? AND status IN ('open', 'in_progress')`
  ).get(projectId) as any;

  const commentStats = db.prepare(
    `SELECT
      COUNT(*) AS comment_count,
      MAX(ic.created_at) AS comment_created_max
    FROM issue_comments ic
    JOIN issues i ON ic.issue_id = i.id
    WHERE i.project_id = ?`
  ).get(projectId) as any;

  const workerStats = db.prepare(
    `SELECT
      SUM(CASE WHEN status = 'idle' AND paused = 0 THEN 1 ELSE 0 END) AS idle_count,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN paused = 1 THEN 1 ELSE 0 END) AS paused_count,
      MAX(finished_at) AS finished_max
    FROM agents
    WHERE project_id = ? AND is_controller = 0`
  ).get(projectId) as any;

  return [
    issueStats?.active_count ?? 0,
    issueStats?.unassigned_count ?? 0,
    issueStats?.user_waiting_count ?? 0,
    issueStats?.open_count ?? 0,
    issueStats?.in_progress_count ?? 0,
    issueStats?.issue_updated_max || '',
    commentStats?.comment_count ?? 0,
    commentStats?.comment_created_max || '',
    workerStats?.idle_count ?? 0,
    workerStats?.running_count ?? 0,
    workerStats?.error_count ?? 0,
    workerStats?.paused_count ?? 0,
    workerStats?.finished_max || '',
  ].join('|');
}

export function buildControllerTaskPrompt(project: Project, triggerIssueNumber?: number): string {
  const db = getDatabase();

  const issues = triggerIssueNumber
    ? db.prepare(
        "SELECT * FROM issues WHERE project_id = ? AND number = ?"
      ).all(project.id, triggerIssueNumber) as Issue[]
    : db.prepare(
        "SELECT * FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
      ).all(project.id) as Issue[];

  // Pending issues: already decomposed into sub-issues, show summary only
  const pendingIssues = triggerIssueNumber
    ? []
    : db.prepare(
        "SELECT * FROM issues WHERE project_id = ? AND status = 'pending' ORDER BY priority DESC, created_at"
      ).all(project.id) as Issue[];

  const agents = db.prepare(
    'SELECT id, name, role, status, paused, is_controller FROM agents WHERE project_id = ?'
  ).all(project.id) as any[];

  const workers = agents.filter((a: any) => !a.is_controller);
  const priorityLabel = (p: number) => (p >= 10 ? '🔴 USER' : p >= 5 ? '🟡 CTRL' : '⚪ AGENT');

  // Build child issue count map for parent-child display
  const childCounts = db.prepare(
    `SELECT parent_id, COUNT(*) as total,
     SUM(CASE WHEN status IN ('done','closed') THEN 1 ELSE 0 END) as completed
     FROM issues WHERE project_id = ? AND parent_id IS NOT NULL
     GROUP BY parent_id`
  ).all(project.id) as any[];
  const childCountMap = new Map(childCounts.map((r: any) => [r.parent_id, r]));

  const unassigned = issues.filter((i) => !i.assigned_to || i.assigned_to === 'all');
  const assigned = issues.filter((i) => i.assigned_to && i.assigned_to !== 'all');

  // Batch-fetch all comments for all active issues (avoids N+1 per-issue queries)
  const allComments = db.prepare(
    `SELECT ic.issue_id, ic.author_id, ic.body FROM issue_comments ic
     JOIN issues i ON ic.issue_id = i.id
     WHERE i.project_id = ? AND i.status NOT IN ('done', 'closed')
     ORDER BY ic.created_at`
  ).all(project.id) as Array<{ issue_id: string; author_id: string; body: string }>;
  const commentsByIssue = new Map<string, typeof allComments>();
  for (const c of allComments) {
    const arr = commentsByIssue.get(c.issue_id);
    if (arr) arr.push(c); else commentsByIssue.set(c.issue_id, [c]);
  }

  // Batch-fetch parent issue numbers (avoids per-issue parent lookup)
  const parentIds = [...new Set(issues.filter(i => i.parent_id).map(i => i.parent_id!))];
  const parentNumberMap = new Map<string, number>();
  if (parentIds.length > 0) {
    const ph = parentIds.map(() => '?').join(',');
    const parents = db.prepare(`SELECT id, number FROM issues WHERE id IN (${ph})`).all(...parentIds) as any[];
    for (const p of parents) parentNumberMap.set(p.id, p.number);
  }

  const formatIssue = (i: Issue): string => {
    const assignee = i.assigned_to
      ? (workers.find((a: any) => a.id === i.assigned_to)?.name || (i.assigned_to === 'user' ? 'User' : i.assigned_to))
      : 'unassigned';
    const labels = i.labels ? ` [${i.labels}]` : '';

    // Parent-child info
    const parentInfo = i.parent_id
      ? ` [child of #${parentNumberMap.get(i.parent_id) || '?'}]`
      : '';
    const cc = childCountMap.get(i.id);
    const childInfo = cc ? ` [children: ${cc.completed}/${cc.total} done]` : '';

    const comments = commentsByIssue.get(i.id) || [];

    const commentsText = comments.length > 0
      ? '\n   Comments:\n' + comments.map((c) => {
          const author = c.author_id === 'user'
            ? 'User'
            : (workers.find((a: any) => a.id === c.author_id)?.name || c.author_id.slice(0, 8));
          return `   [${author}] ${c.body || ''}`;
        }).join('\n')
      : '';

    return `#${i.number} [${priorityLabel(i.priority)}] [${i.status}] ${i.title} -> ${assignee}${labels}${parentInfo}${childInfo}\n   ${i.body || ''}${commentsText}`;
  };

  const doneRecent = db.prepare(
    "SELECT * FROM issues WHERE project_id = ? AND status IN ('done', 'closed') ORDER BY updated_at DESC"
  ).all(project.id) as Issue[];

  const triggerHint = triggerIssueNumber
    ? `\n## Trigger Context\n本次由 issue #${triggerIssueNumber} 触发，仅展示该 issue 信息。如需查看所有 issue，请通过 API 查询。\n`
    : '';

  return `## Project Task
${project.task_description}
${triggerHint}
## Unassigned Issues (${unassigned.length}) - ACTION REQUIRED
${unassigned.map(formatIssue).join('\n\n') || 'None - all issues are assigned.'}

## Assigned / In-Progress Issues (${assigned.length})
${assigned.map(formatIssue).join('\n\n') || 'None.'}

## Pending Issues (${pendingIssues.length}) — waiting for sub-issues to complete
${pendingIssues.map((i) => {
    const assignee = i.assigned_to
      ? (workers.find((a: any) => a.id === i.assigned_to)?.name || (i.assigned_to === 'user' ? 'User' : i.assigned_to))
      : 'unassigned';
    const cc = childCountMap.get(i.id);
    const progress = cc ? ` [${cc.completed}/${cc.total} done]` : '';
    return `#${i.number} [pending] ${i.title} -> ${assignee}${progress}`;
  }).join('\n') || 'None.'}

## Recently Completed (${doneRecent.length})
${doneRecent.map((i) => `#${i.number} [${i.status}] ${i.title}`).join('\n') || 'None.'}

## Existing Workers
${workers.map((a: any) => {
    if (a.paused) {
      return `- ⏸ ${a.name} PAUSED (ID: ${a.id}, Role: ${a.role}) — do NOT assign issues`;
    }
    return `- ${a.name} (ID: ${a.id}, Role: ${a.role})`;
  }).join('\n') || '(none yet)'}

## ⚠️ 用户 Issue 处理标准流程（MUST FOLLOW）

当你看到由用户创建的 issue（标记为 🔴 USER）时，**必须**按以下步骤执行：

**步骤 1 — 分析并回复：** 先在该 issue 下添加一条评论，说明你理解的问题以及大致的解决计划（例如：将拆分为哪些子任务、分配给哪些 agent）。这条评论让用户知道他们的 issue 已被接收并正在处理。

**步骤 2 — 创建子任务：** 根据需求类型创建子 issue（设置 \`parent_id\` 指向用户 issue），并分配给对应 agent：
- 代码开发/Bug修复 → 分配给开发 agent（agentopia-developer）
- 产品需求分析 → 分配给产品 agent（agentopia-product）
- 测试验证 → 分配给测试 agent（agentopia-tester）
- 需要调研/分析 → 分配给助手 agent（agentopia-assistant）
然后将用户 issue 状态设为 \`pending\`。

**步骤 3 — 汇总并交付用户：** 子任务全部完成后（issue 评论中出现 'All X sub-issues completed'），系统会触发你。你**必须**：(1) 先写一条详细的总结评论，说明每个子 task 完成了什么、整体结果如何；(2) 然后将父 issue 的 assigned_to 改为 user、status 改为 done。**切勿跳过总结直接 assign。**

**步骤 4 — 切勿跳过步骤 1。** 即使 issue 很简单，也必须先评论再创建子任务。用户需要知道他们的 issue 被接收了。

## Rules
1. **复用agent。** NEVER create a new agent if one with a similar role already exists. Reuse existing agents.
2. **分配unassigned issues。** 将未分配的issue分配给合适的agent，无论agent当前是idle还是running。Agent完成当前任务后会自动处理新分配的issue。只有paused的agent不要分配。
3. **不要手动启动agent。** 系统会自动启动有assigned issue的agent，你只需要分配issue即可。**NEVER start paused agents。NEVER assign issues to paused agents。NEVER call unpause on paused agents — only the user can unpause。**
4. **拆分issue用parent_id。** 将大issue拆成子issue时，创建子issue时设置\`parent_id\`指向父issue的ID，然后将父issue状态设为\`pending\`。系统会自动追踪子issue进度，全部完成后自动通知。创建子issue示例：\`{"title":"子任务","parent_id":"父issue的ID",...}\`
5. **用户issue自动回流。** 用户创建的issue完成后，系统会自动assign回user，你不需要手动处理。但如果你发现用户issue的结果需要补充说明，可以添加评论。
6. **NEVER自己写代码。** Controller只负责协调和决策。所有代码修改（无论大小）都必须分配给开发agent。
7. **与用户沟通用issue。** 需要用户输入、审批、决策时，创建issue assigned给"user"。
8. **NEVER长时间等待。** 不要用sleep/wait/poll。如需等worker完成就直接退出，系统会在worker完成后自动触发你。每次turn应在60秒内完成。
9. **需求需用户确认。** 产品agent提出的新功能需求必须先分配给"user"等待确认。Bug修复可以直接分配开发。
10. **开发→测试流程。** 开发完成后创建测试验证issue（设parent_id关联父issue）分配给测试agent。测试通过标done，发现bug创建bug issue分配给开发。
11. **新issue还是新session。** 启动worker时通过start API的\`force_new_session\`决定：任务相关用默认session，全新任务用\`"force_new_session": true\`。
12. **关闭用户issue时必须回复。** 当你关闭或完成一个由用户创建的issue时，必须先添加一条简短评论，说明你做了什么（如创建了哪些子任务、分配给了谁、结论是什么）。不要默默关闭issue。
13. **子issue全完成必须先总结再交付用户。** 当一个用户创建的 pending issue，其所有子 issue 已 done（系统评论显示 All X sub-issues completed），你**必须**：(1) 先写详细总结评论（说明每个子 task 做了什么、最终产出）；(2) 再 UPDATE 父 issue status=done, assigned_to=user。**不得先 assign 再总结。**

Assignable targets: ${agents.map((a: any) => `"${a.id}" (${a.name})`).join(', ')}, "user" for human tasks, or "all" to broadcast to everyone.`;
}

const lastTriggerTime = new Map<string, string>();
const lastTriggerAtMs = new Map<string, number>();
const lastTriggerSnapshot = new Map<string, string>();

function hasNewActivity(projectId: string, since: string): boolean {
  const db = getDatabase();

  const newIssues = db.prepare(
    "SELECT 1 FROM issues WHERE project_id = ? AND (created_at > ? OR updated_at > ?) LIMIT 1"
  ).get(projectId, since, since);
  if (newIssues) return true;

  const newComments = db.prepare(
    "SELECT 1 FROM issue_comments ic JOIN issues i ON ic.issue_id = i.id WHERE i.project_id = ? AND ic.created_at > ? LIMIT 1"
  ).get(projectId, since);
  if (newComments) return true;

  const agentChanges = db.prepare(
    "SELECT 1 FROM agents WHERE project_id = ? AND is_controller = 0 AND finished_at > ? LIMIT 1"
  ).get(projectId, since);
  if (agentChanges) return true;

  return false;
}

function nowAsDbTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export function triggerControllerAgent(project: Project, skipActivityCheck = false, triggerIssueNumber?: number): void {
  const db = getDatabase();
  const controller = db.prepare(
    'SELECT * FROM agents WHERE project_id = ? AND is_controller = 1'
  ).get(project.id) as Agent | undefined;

  if (!controller) {
    logger.warn(`No controller agent found for project ${project.id}`);
    return;
  }

  if (controller.status === 'running') {
    logger.info(`Controller agent for project ${project.id} is already running, skipping.`);
    return;
  }

  if (controller.paused) {
    logger.info(`Controller agent for project ${project.id} is paused, skipping.`);
    return;
  }

  const now = Date.now();

  // Idle-period optimization: skip LLM call entirely when controller has nothing to do.
  if (!triggerIssueNumber) {
    // Check 1: any issues that need controller to assign or handle?
    const needsControllerAction = db.prepare(
      `SELECT 1 FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress')
       AND (assigned_to IS NULL OR assigned_to = 'all' OR assigned_to IN (
         SELECT id FROM agents WHERE project_id = ? AND is_controller = 1
       )) LIMIT 1`
    ).get(project.id, project.id);

    if (!needsControllerAction) {
      // Check 2: any workers in error state that controller might need to handle?
      const errorWorkers = db.prepare(
        `SELECT 1 FROM agents WHERE project_id = ? AND is_controller = 0 AND status = 'error' AND paused = 0 LIMIT 1`
      ).get(project.id);

      if (!errorWorkers) {
        logger.info(`Skipping controller trigger: no unassigned issues and no errored workers in project "${project.name}"`);
        return;
      }
      // If there are errored workers, let controller handle them
      logger.info(`Controller trigger: errored workers detected in project "${project.name}"`);
    }
  }

  if (!skipActivityCheck && controller.status !== 'error') {
    const lastAt = lastTriggerAtMs.get(project.id);
    if (lastAt && now - lastAt < TRIGGER_DEBOUNCE_MS) {
      logger.info(
        `Skipping controller trigger: debounced (${now - lastAt}ms < ${TRIGGER_DEBOUNCE_MS}ms) for project "${project.name}"`
      );
      return;
    }

    const since = lastTriggerTime.get(project.id);
    if (since && !hasNewActivity(project.id, since)) {
      logger.info(`Skipping controller trigger: no new activity since last run for project "${project.name}"`);
      return;
    }
  }

  const _ct0 = Date.now();
  const snapshot = buildActivitySnapshot(project.id);
  const _ct1 = Date.now();
  if (!skipActivityCheck) {
    const prevSnapshot = lastTriggerSnapshot.get(project.id);
    if (prevSnapshot && prevSnapshot === snapshot) {
      logger.info(`Skipping controller trigger: no-op snapshot unchanged for project "${project.name}"`);
      return;
    }
  }

  const triggerTime = nowAsDbTimestamp();
  const taskPrompt = buildControllerTaskPrompt(project, triggerIssueNumber);
  const _ct2 = Date.now();
  if (_ct2 - _ct0 > 200) {
    logger.warn(`SLOW triggerControllerAgent sync phase (${_ct2-_ct0}ms): snapshot=${_ct1-_ct0}ms prompt=${_ct2-_ct1}ms project="${project.name}"`);
  }

  lastTriggerAtMs.set(project.id, now);

  try {
    logger.info(`Triggering controller agent for project "${project.name}"`);
    startControllerOrchestration({ project, controller, taskPrompt, triggerIssueNumber });

    lastTriggerTime.set(project.id, triggerTime);
    lastTriggerSnapshot.set(project.id, snapshot);
  } catch (err) {
    lastTriggerAtMs.delete(project.id);
    throw err;
  }
}
