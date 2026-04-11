import { getDatabase, isDatabaseOpen } from '../db/database';
import { Agent, Project, Issue } from '../types';
import { startControllerOrchestration } from './orchestrator';
import {
  buildControllerActivitySnapshot,
  clearControllerBackoff,
  formatBackoffDuration,
  getControllerBackoff,
  getRemainingBackoffMs,
} from './controller-backoff';
import logger from '../logger';

// --- Event Coalescing Architecture ---
// Instead of triggering controller on every event, events are queued and coalesced.
// Two priority levels with different coalesce windows:
//   urgent (user actions): 3 seconds — user is waiting for response
//   normal (agent actions): 60 seconds — batch agent activity into one controller run
// Hard minimum interval: 5 minutes between controller runs, NEVER bypassed.

const MIN_CONTROLLER_INTERVAL_MS = 300_000; // 5 minutes hard floor
const COALESCE_URGENT_MS = 3_000;           // 3s for user events
const COALESCE_NORMAL_MS = 60_000;          // 60s for agent events

interface CoalescedTrigger {
  project: Project;
  issueNumbers: Set<number>;
  highestPriority: 'urgent' | 'normal';
  reasons: string[];
  skipActivityCheck: boolean;
}

const coalescedTriggers = new Map<string, CoalescedTrigger>();
const coalescingTimers = new Map<string, NodeJS.Timeout>();
const lastControllerRunMs = new Map<string, number>();

/**
 * Enqueue a controller trigger event. Events are coalesced per project.
 * This is the ONLY entry point for triggering the controller from event sources.
 */
export function enqueueControllerTrigger(
  project: Project,
  opts: {
    issueNumber?: number;
    priority: 'urgent' | 'normal';
    reason: string;
    skipActivityCheck?: boolean;
  }
): void {
  const pid = project.id;

  // Accumulate into existing coalesced trigger or create new one
  let coalesced = coalescedTriggers.get(pid);
  if (!coalesced) {
    coalesced = {
      project,
      issueNumbers: new Set(),
      highestPriority: opts.priority,
      reasons: [],
      skipActivityCheck: false,
    };
    coalescedTriggers.set(pid, coalesced);
  }

  if (opts.issueNumber) coalesced.issueNumbers.add(opts.issueNumber);
  if (opts.priority === 'urgent') coalesced.highestPriority = 'urgent';
  if (opts.skipActivityCheck) coalesced.skipActivityCheck = true;
  coalesced.reasons.push(opts.reason);

  // Determine coalesce delay
  const windowMs = coalesced.highestPriority === 'urgent'
    ? COALESCE_URGENT_MS
    : COALESCE_NORMAL_MS;

  // Check hard minimum interval
  const lastRun = lastControllerRunMs.get(pid) || 0;
  const sinceLast = Date.now() - lastRun;
  const minDelay = Math.max(0, MIN_CONTROLLER_INTERVAL_MS - sinceLast);
  const delay = Math.max(windowMs, minDelay);

  // Reset timer if we upgraded to urgent (shorter window) and min interval allows it
  const existingTimer = coalescingTimers.get(pid);
  if (existingTimer && opts.priority === 'urgent' && minDelay <= COALESCE_URGENT_MS) {
    clearTimeout(existingTimer);
    coalescingTimers.delete(pid);
  }

  // Set coalescing timer if not already set
  if (!coalescingTimers.has(pid)) {
    const timer = setTimeout(() => {
      coalescingTimers.delete(pid);
      const trigger = coalescedTriggers.get(pid);
      coalescedTriggers.delete(pid);
      if (!trigger) return;
      if (!isDatabaseOpen()) return;

      // Pick the most relevant trigger issue (first one added)
      const triggerIssueNumber = trigger.issueNumbers.size > 0
        ? trigger.issueNumbers.values().next().value as number
        : undefined;

      logger.info(
        `Coalesced controller trigger for "${trigger.project.name}": ${trigger.reasons.length} event(s) [${trigger.highestPriority}], issues=[${[...trigger.issueNumbers].join(',')}], reasons=[${trigger.reasons.slice(0, 3).join('; ')}${trigger.reasons.length > 3 ? '...' : ''}]`
      );

      try {
        triggerControllerAgent(trigger.project, trigger.skipActivityCheck, triggerIssueNumber);
      } catch (e) {
        logger.error(e, 'Coalesced controller trigger failed');
      }
    }, delay);
    coalescingTimers.set(pid, timer);

    if (delay > windowMs) {
      logger.info(`Controller trigger queued for "${project.name}" in ${Math.round(delay / 1000)}s (min interval enforced, ${opts.reason})`);
    }
  }
}

/** Cancel all pending coalescing timers (for shutdown). */
export function clearCoalescingTimers(): void {
  for (const timer of coalescingTimers.values()) clearTimeout(timer);
  coalescingTimers.clear();
  coalescedTriggers.clear();
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

    return `#${i.number} (ID: ${i.id}) [${priorityLabel(i.priority)}] [${i.status}] ${i.title} -> ${assignee}${labels}${parentInfo}${childInfo}\n   ${i.body || ''}${commentsText}`;
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
- 代码开发/Bug修复 → 分配给开发 agent（haico-developer）
- 产品需求分析 → 分配给产品 agent（haico-product）
- 测试验证 → 分配给测试 agent（haico-tester）
- 需要调研/分析 → 分配给助手 agent（haico-assistant）
然后将用户 issue 状态设为 \`pending\`。

**步骤 3 — 测试验证：** 当开发类子任务完成后，检查该父 issue 下是否已存在测试验证子 issue。如果没有，**必须**创建一个测试验证子 issue（设 \`parent_id\` 指向父 issue），分配给测试 agent，验证开发成果。**不要在没有测试验证的情况下直接关闭父 issue。**

**步骤 4 — 汇总并交付用户：** 所有子任务（包括测试验证）全部完成后（issue 评论中出现 'All X sub-issues completed'），系统会触发你。你**必须**：(1) 先写一条详细的总结评论，说明每个子 task 完成了什么、测试结果如何；(2) 然后将父 issue 的 assigned_to 改为 user、status 改为 done。**切勿跳过总结直接 assign。**

**步骤 5 — 切勿跳过步骤 1。** 即使 issue 很简单，也必须先评论再创建子任务。用户需要知道他们的 issue 被接收了。

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
10. **开发→测试流程（强制执行）。** 开发子 issue 完成后，**必须**创建测试验证子 issue（设 parent_id 关联同一个父 issue）分配给测试 agent。只有测试通过并标 done 后，才能进入汇总交付步骤。测试发现 bug 则创建 bug fix issue 分配给开发。**禁止跳过测试直接关闭父 issue。**
11. **新issue还是新session。** 启动worker时通过start API的\`force_new_session\`决定：任务相关用默认session，全新任务用\`"force_new_session": true\`。
12. **关闭用户issue时必须回复。** 当你关闭或完成一个由用户创建的issue时，必须先添加一条简短评论，说明你做了什么（如创建了哪些子任务、分配给了谁、结论是什么）。不要默默关闭issue。
13. **子issue全完成必须先验证测试再交付。** 当一个用户创建的 pending issue 的所有子 issue 已 done（系统评论显示 All X sub-issues completed），你**必须**先检查子 issue 中是否包含测试验证 issue。如果没有测试验证 issue，**必须先创建测试子 issue** 分配给测试 agent，等测试完成后再汇总交付。如果已有测试且全部通过，则：(1) 先写详细总结评论（说明每个子 task 做了什么、测试结果、最终产出）；(2) 再 UPDATE 父 issue status=done, assigned_to=user。**不得先 assign 再总结，不得跳过测试。**

Assignable targets: ${agents.map((a: any) => `"${a.id}" (${a.name})`).join(', ')}, "user" for human tasks, or "all" to broadcast to everyone.`;
}

const lastTriggerSnapshot = new Map<string, string>();

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

  const snapshot = buildControllerActivitySnapshot(project.id);

  if (!skipActivityCheck) {
    // Backoff check: if controller set a backoff and snapshot is unchanged, respect it
    const backoff = getControllerBackoff(project.id);
    if (backoff) {
      if (backoff.snapshot === snapshot) {
        const remainingMs = getRemainingBackoffMs(project.id);
        logger.info(
          `Skipping controller trigger: active ${backoff.source} backoff (${formatBackoffDuration(remainingMs)}) for project "${project.name}" because snapshot is unchanged; reason=${backoff.reason}`
        );
        return;
      }
      clearControllerBackoff(project.id);
      logger.info(
        `Clearing controller backoff for project "${project.name}" because activity snapshot changed (previous=${backoff.label})`
      );
    }
  }

  // If triggered by a specific issue, check its status first.
  // Pending issues with active children should NOT trigger the controller — they are
  // waiting for child issues to complete and the system will auto-trigger when children finish.
  if (triggerIssueNumber) {
    const triggerIssue = db.prepare(
      'SELECT id, status FROM issues WHERE project_id = ? AND number = ?'
    ).get(project.id, triggerIssueNumber) as { id: string; status: string } | undefined;

    if (triggerIssue && triggerIssue.status === 'pending') {
      const depState = db.prepare(`
        SELECT
          (
            SELECT COUNT(*) FROM issues child
            WHERE child.project_id = ? AND child.parent_id = ? AND child.status NOT IN ('done', 'closed')
          ) AS active_children,
          (
            SELECT COUNT(*)
            FROM issue_relations r
            JOIN issues blocker ON blocker.id = r.from_issue_id
            JOIN issues blocked ON blocked.id = r.to_issue_id
            WHERE blocked.project_id = ?
              AND r.to_issue_id = ?
              AND r.relation_type = 'blocks'
              AND blocker.status NOT IN ('done', 'closed')
          ) AS active_blockers
      `).get(project.id, triggerIssue.id, project.id, triggerIssue.id) as {
        active_children: number;
        active_blockers: number;
      };

      if ((depState?.active_children ?? 0) > 0 || (depState?.active_blockers ?? 0) > 0) {
        logger.info(
          `Skipping controller trigger: issue #${triggerIssueNumber} is pending with active_children=${depState?.active_children ?? 0}, active_blockers=${depState?.active_blockers ?? 0} in project "${project.name}"`
        );
        return;
      }
    }
  }

  // Necessity check: skip LLM call entirely when controller has nothing to do.
  if (!triggerIssueNumber) {
    // Check 1: any issues that need controller to assign or handle?
    const needsControllerAction = db.prepare(
      `SELECT 1 FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress')
       AND (assigned_to IS NULL OR assigned_to = 'all' OR assigned_to IN (
         SELECT id FROM agents WHERE project_id = ? AND is_controller = 1
       )) LIMIT 1`
    ).get(project.id, project.id);

    if (!needsControllerAction) {
      // Check 2: error workers WITH active issues only (not bare error workers)
      const errorWorkersWithIssues = db.prepare(
        `SELECT 1 FROM agents a
         WHERE a.project_id = ? AND a.is_controller = 0 AND a.status = 'error' AND a.paused = 0
         AND EXISTS (
           SELECT 1 FROM issues i
           WHERE i.assigned_to = a.id AND i.project_id = ? AND i.status IN ('open', 'in_progress')
         ) LIMIT 1`
      ).get(project.id, project.id);

      // Check 3: any pending issues whose dependencies are all cleared?
      const stalePending = db.prepare(
        `SELECT 1
         FROM issues p
         LEFT JOIN (
           SELECT parent_id,
                  SUM(CASE WHEN status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_children
           FROM issues
           WHERE project_id = ? AND parent_id IS NOT NULL
           GROUP BY parent_id
         ) child_stats ON child_stats.parent_id = p.id
         LEFT JOIN (
           SELECT r.to_issue_id AS issue_id,
                  SUM(CASE WHEN blocker.status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS active_blockers
           FROM issue_relations r
           JOIN issues blocker ON blocker.id = r.from_issue_id
           JOIN issues blocked ON blocked.id = r.to_issue_id
           WHERE blocked.project_id = ? AND r.relation_type = 'blocks'
           GROUP BY r.to_issue_id
         ) blocker_stats ON blocker_stats.issue_id = p.id
         WHERE p.project_id = ? AND p.status = 'pending'
           AND COALESCE(p.assigned_to, '') <> 'user'
           AND COALESCE(child_stats.active_children, 0) = 0
           AND COALESCE(blocker_stats.active_blockers, 0) = 0
         LIMIT 1`
      ).get(project.id, project.id, project.id);

      if (!errorWorkersWithIssues && !stalePending) {
        logger.info(`Skipping controller trigger: no unassigned issues, no errored workers with active issues, and no stale pending issues in project "${project.name}"`);
        return;
      }
      if (errorWorkersWithIssues) logger.info(`Controller trigger: errored workers with active issues detected in project "${project.name}"`);
      if (stalePending) logger.info(`Controller trigger: pending issue(s) with all children completed detected in project "${project.name}"`);
    }
  }

  // Snapshot dedup: don't re-run controller if nothing structurally changed
  if (!skipActivityCheck) {
    const prevSnapshot = lastTriggerSnapshot.get(project.id);
    if (prevSnapshot && prevSnapshot === snapshot) {
      logger.info(`Skipping controller trigger: snapshot unchanged for project "${project.name}"`);
      return;
    }
  }

  const taskPrompt = buildControllerTaskPrompt(project, triggerIssueNumber);

  // Record that controller is running now (for MIN_CONTROLLER_INTERVAL_MS enforcement)
  lastControllerRunMs.set(project.id, Date.now());

  try {
    logger.info(`Triggering controller agent for project "${project.name}"`);
    startControllerOrchestration({ project, controller, taskPrompt, triggerIssueNumber, activitySnapshot: snapshot });

    lastTriggerSnapshot.set(project.id, snapshot);
  } catch (err) {
    lastControllerRunMs.delete(project.id);
    throw err;
  }
}
