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

  const formatIssue = (i: Issue): string => {
    const assignee = i.assigned_to
      ? (workers.find((a: any) => a.id === i.assigned_to)?.name || (i.assigned_to === 'user' ? 'User' : i.assigned_to))
      : 'unassigned';
    const labels = i.labels ? ` [${i.labels}]` : '';

    // Parent-child info
    const parentInfo = i.parent_id
      ? ` [child of #${(db.prepare('SELECT number FROM issues WHERE id = ?').get(i.parent_id) as any)?.number || '?'}]`
      : '';
    const cc = childCountMap.get(i.id);
    const childInfo = cc ? ` [children: ${cc.completed}/${cc.total} done]` : '';

    const comments = db.prepare(
      'SELECT author_id, body, created_at FROM issue_comments WHERE issue_id = ? ORDER BY created_at'
    ).all(i.id) as Array<{ author_id: string; body: string }>;

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
    let line = `- ${a.name} (ID: ${a.id}, Status: ${a.status}${a.paused ? ', ⏸ PAUSED' : ''}, Role: ${a.role})`;
    if (a.paused) {
      line = `- ⏸ ${a.name} PAUSED (ID: ${a.id}, Role: ${a.role}) — user paused, do NOT start`;
    } else if (a.status === 'error') {
      const errLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND stream = 'stderr' ORDER BY id DESC LIMIT 1"
      ).get(a.id) as { content: string } | undefined;
      const errMsg = errLog?.content || 'Unknown error';
      line = `- ⚠️ ${a.name} ERRORED (ID: ${a.id}, Role: ${a.role}) — last error: ${errMsg}`;
    }
    return line;
  }).join('\n') || '(none yet)'}

## Rules
1. **复用agent。** NEVER create a new agent if one with a similar role already exists. Reuse existing agents.
2. **分配unassigned issues。** 将未分配的issue分配给合适的idle agent，或"user"用于需要人工处理的任务。
3. **不要手动启动agent。** 系统会自动启动有assigned issue的idle agent，你只需要分配issue即可。**NEVER start paused agents。**
4. **拆分issue用parent_id。** 将大issue拆成子issue时，创建子issue时设置\`parent_id\`指向父issue的ID，然后将父issue状态设为\`pending\`。系统会自动追踪子issue进度，全部完成后自动通知。创建子issue示例：\`{"title":"子任务","parent_id":"父issue的ID",...}\`
5. **用户issue自动回流。** 用户创建的issue完成后，系统会自动assign回user，你不需要手动处理。但如果你发现用户issue的结果需要补充说明，可以添加评论。
6. **NEVER自己写代码。** Controller只负责协调和决策。所有代码修改（无论大小）都必须分配给开发agent。
7. **与用户沟通用issue。** 需要用户输入、审批、决策时，创建issue assigned给"user"。
8. **NEVER长时间等待。** 不要用sleep/wait/poll。如需等worker完成就直接退出，系统会在worker完成后自动触发你。每次turn应在60秒内完成。
9. **需求需用户确认。** 产品agent提出的新功能需求必须先分配给"user"等待确认。Bug修复可以直接分配开发。
10. **开发→测试流程。** 开发完成后创建测试验证issue（设parent_id关联父issue）分配给测试agent。测试通过标done，发现bug创建bug issue分配给开发。
11. **新issue还是新session。** 启动worker时通过start API的\`force_new_session\`决定：任务相关用默认session，全新任务用\`"force_new_session": true\`。

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

  if (!skipActivityCheck) {
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

  const snapshot = buildActivitySnapshot(project.id);
  if (!skipActivityCheck) {
    const prevSnapshot = lastTriggerSnapshot.get(project.id);
    if (prevSnapshot && prevSnapshot === snapshot) {
      logger.info(`Skipping controller trigger: no-op snapshot unchanged for project "${project.name}"`);
      return;
    }
  }

  const triggerTime = nowAsDbTimestamp();
  const taskPrompt = buildControllerTaskPrompt(project, triggerIssueNumber);

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
