import { getDatabase } from '../db/database';
import { Agent, Project, Issue } from '../types';
import { startAgentProcess } from './process-manager';
import { buildSystemPrompt } from './system-prompt';
import { config } from '../config';
import logger from '../logger';

export function buildControllerTaskPrompt(project: Project): string {
  const db = getDatabase();

  // All active issues
  const issues = db.prepare(
    "SELECT * FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
  ).all(project.id) as Issue[];

  // Agents
  const agents = db.prepare('SELECT id, name, role, status, paused FROM agents WHERE project_id = ?').all(project.id) as any[];

  const priorityLabel = (p: number) => p >= 10 ? '🔴 USER' : p >= 5 ? '🟡 CTRL' : '⚪ AGENT';

  // Split by assignment
  const unassigned = issues.filter(i => !i.assigned_to);
  const assigned = issues.filter(i => i.assigned_to);

  const formatIssue = (i: Issue) => {
    const assignee = i.assigned_to
      ? (agents.find((a: any) => a.id === i.assigned_to)?.name || (i.assigned_to === 'user' ? 'User' : i.assigned_to))
      : 'unassigned';
    const labels = i.labels ? ` [${i.labels}]` : '';

    // Include recent comments so controller can see replies
    const comments = db.prepare(
      'SELECT author_id, body, created_at FROM issue_comments WHERE issue_id = ? ORDER BY created_at DESC LIMIT 5'
    ).all(i.id) as any[];
    const commentsText = comments.length > 0
      ? '\n   Comments:\n' + comments.reverse().map((c: any) => {
          const author = c.author_id === 'user' ? 'User' : (agents.find((a: any) => a.id === c.author_id)?.name || c.author_id.slice(0, 8));
          return `   [${author}] ${c.body.slice(0, 200)}`;
        }).join('\n')
      : '';

    return `#${i.number} [${priorityLabel(i.priority)}] [${i.status}] ${i.title} → ${assignee}${labels}\n   ${i.body.slice(0, 200)}${commentsText}`;
  };

  // Recently completed issues (for context)
  const doneRecent = db.prepare(
    "SELECT * FROM issues WHERE project_id = ? AND status IN ('done', 'closed') ORDER BY updated_at DESC LIMIT 5"
  ).all(project.id) as Issue[];

  return `## Project Task
${project.task_description}

## Unassigned Issues (${unassigned.length}) — ACTION REQUIRED
${unassigned.map(formatIssue).join('\n\n') || 'None — all issues are assigned.'}

## Assigned / In-Progress Issues (${assigned.length})
${assigned.map(formatIssue).join('\n\n') || 'None.'}

## Recently Completed (${doneRecent.length})
${doneRecent.map(i => `#${i.number} [${i.status}] ${i.title}`).join('\n') || 'None.'}

## Existing Workers
${agents.filter((a: any) => !a.is_controller).map((a: any) => {
    let line = `- ${a.name} (ID: ${a.id}, Status: ${a.status}${a.paused ? ', ⏸ PAUSED' : ''}, Role: ${a.role})`;
    if (a.paused) {
      line = `- ⏸ ${a.name} PAUSED (ID: ${a.id}, Role: ${a.role}) — user paused, do NOT start`;
    } else if (a.status === 'error') {
      const errLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND stream = 'stderr' ORDER BY id DESC LIMIT 1"
      ).get(a.id) as { content: string } | undefined;
      const errMsg = errLog?.content?.slice(0, 300) || 'Unknown error';
      line = `- \u26a0\ufe0f ${a.name} ERRORED (ID: ${a.id}, Role: ${a.role}) \u2014 last error: ${errMsg}`;
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

// Track last trigger time per project for incremental activity check
const lastTriggerTime = new Map<string, string>();

function hasNewActivity(projectId: string, since: string): boolean {
  const db = getDatabase();

  // Check for new or updated issues since last trigger
  const newIssues = db.prepare(
    "SELECT 1 FROM issues WHERE project_id = ? AND (created_at > ? OR updated_at > ?) LIMIT 1"
  ).get(projectId, since, since);
  if (newIssues) return true;

  // Check for new comments since last trigger
  const newComments = db.prepare(
    "SELECT 1 FROM issue_comments ic JOIN issues i ON ic.issue_id = i.id WHERE i.project_id = ? AND ic.created_at > ? LIMIT 1"
  ).get(projectId, since);
  if (newComments) return true;

  // Check for agent status changes (recently finished agents)
  const agentChanges = db.prepare(
    "SELECT 1 FROM agents WHERE project_id = ? AND is_controller = 0 AND finished_at > ? LIMIT 1"
  ).get(projectId, since);
  if (agentChanges) return true;

  return false;
}

export function triggerControllerAgent(project: Project, skipActivityCheck = false): void {
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

  // P0: Incremental check — skip if no new activity since last trigger
  if (!skipActivityCheck) {
    const since = lastTriggerTime.get(project.id);
    if (since && !hasNewActivity(project.id, since)) {
      logger.info(`Skipping controller trigger: no new activity since last run for project "${project.name}"`);
      return;
    }
  }

  // Record trigger time
  lastTriggerTime.set(project.id, new Date().toISOString().replace('T', ' ').replace('Z', ''));

  const taskPrompt = buildControllerTaskPrompt(project);
  const commandTemplate = project.command_template || config.defaultCommandTemplate;

  const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
  const fullPrompt = isRawShell
    ? taskPrompt
    : buildSystemPrompt(controller, project) + taskPrompt;

  // Controller is stateless (rebuilds full state from DB each run).
  // Always use fresh session to prevent conversation history accumulation and cost growth.
  const controllerFresh = { ...controller, session_id: null } as Agent;

  logger.info(`Triggering controller agent for project "${project.name}"`);
  startAgentProcess(controllerFresh, fullPrompt, commandTemplate);
}
