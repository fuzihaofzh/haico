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

  const agents = db.prepare(
    'SELECT id, name, role, status, paused, is_controller FROM agents WHERE project_id = ?'
  ).all(project.id) as any[];

  const workers = agents.filter((a: any) => !a.is_controller);
  const priorityLabel = (p: number) => (p >= 10 ? '🔴 USER' : p >= 5 ? '🟡 CTRL' : '⚪ AGENT');

  const unassigned = issues.filter((i) => !i.assigned_to || i.assigned_to === 'all');
  const assigned = issues.filter((i) => i.assigned_to && i.assigned_to !== 'all');

  const formatIssue = (i: Issue): string => {
    const assignee = i.assigned_to
      ? (workers.find((a: any) => a.id === i.assigned_to)?.name || (i.assigned_to === 'user' ? 'User' : i.assigned_to))
      : 'unassigned';
    const labels = i.labels ? ` [${i.labels}]` : '';

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

    return `#${i.number} [${priorityLabel(i.priority)}] [${i.status}] ${i.title} -> ${assignee}${labels}\n   ${i.body || ''}${commentsText}`;
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
1. **NEVER create a new agent if one with a similar role already exists.** Reuse existing agents.
2. **Assign unassigned issues** to existing idle agents, or "user" for human tasks
3. **Start idle agents** that have assigned issues. **NEVER start paused agents** — they are paused by the user and must remain paused until the user unpauses them
4. **Check results** from completed agents and close resolved issues
5. **Create new issues** if the project task requires more work
6. **Only create a new agent** if no existing agent can handle the task
7. **Communicate with user via issues.** Create an issue assigned to "user" when:
   - You need user input, approval, or a decision
   - A task is blocked and requires human help
   - There is a significant milestone or progress update
   - All work is complete (create a summary issue for the user)
   - An error occurs that you cannot resolve
8. **NEVER do long-running waits yourself.** Do NOT use sleep/wait/poll loops. If you need to wait for a worker, just exit. You will be triggered again automatically when the worker finishes. Each turn should complete quickly (under 60 seconds).
9. **NEVER write code or edit files yourself.** Controller的职责是协调和决策，不是写代码。所有涉及代码修改的任务（无论大小，包括"简单"的UI修复、一行bug fix等）都必须分配给开发agent执行。Controller只负责：分配任务、启动agent、检查结果、管理流程。
10. **需求需用户确认。** 产品agent提出的新功能需求必须先分配给"user"等待确认。只有用户确认后（通过评论或状态变更），才能将需求issue分配给开发agent。Bug修复类issue可以直接分配开发。
11. **开发→测试流程。** 开发agent完成任务后，应创建测试验证issue分配给测试agent。测试agent验证通过后标记done，发现bug则创建bug issue分配给开发agent。Controller负责监督此流程。bug修复后必须经过测试验证，不能跳过测试直接完成。
12. **用户交办的issue完成后必须assign回用户。** 凡是由用户创建（created_by为"user"）的issue，在所有工作完成后，不要直接关闭，而是将issue assign给"user"并添加评论说明完成情况，让用户自行验证确认后关闭。
13. **Worker Session管理。** 启动worker agent时，通过start API的\`force_new_session\`参数决定是否新开session：
   - **继续session**（默认）：任务与上次相关（如修复同一个bug的下一步）
   - **新开session**（\`"force_new_session": true\`）：任务与上次无关（如开始全新的issue）
   - 优先考虑成本，除非上下文确实重要。

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
