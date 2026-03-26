import { getDatabase } from '../db/database';
import { Agent, Project, Issue } from '../types';
import { startAgentProcess, isAgentRunning } from './process-manager';
import { buildSystemPrompt } from './system-prompt';
import { config } from '../config';
import logger from '../logger';

/**
 * Pre-Controller: 系统级规则引擎，在 LLM controller 之前拦截简单编排场景。
 * 返回 true = 已处理，不需要 LLM controller
 * 返回 false = 需要 LLM controller 接手
 */
export function tryHandleWithoutLLM(projectId: string, triggerIssueNumber?: number): boolean {
  if (!triggerIssueNumber) return false;

  const db = getDatabase();

  const issue = db.prepare(
    'SELECT * FROM issues WHERE project_id = ? AND number = ?'
  ).get(projectId, triggerIssueNumber) as Issue | undefined;

  if (!issue) return false;

  // 规则2: issue assigned_to = "user" → 无需操作
  if (issue.assigned_to === 'user') {
    logger.info(`Pre-controller: issue #${triggerIssueNumber} assigned to user, skipping LLM`);
    return true;
  }

  // 规则2b: issue is pending (waiting for child issues) → 无需操作
  if (issue.status === 'pending') {
    logger.info(`Pre-controller: issue #${triggerIssueNumber} is pending (waiting for children), skipping LLM`);
    return true;
  }

  // 规则3: issue 已完成 (done/closed) → 检查是否还有其他需要 controller 处理的 issue
  if (issue.status === 'done' || issue.status === 'closed') {
    const pendingForController = db.prepare(
      `SELECT 1 FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress')
       AND (assigned_to IS NULL OR assigned_to = 'all' OR assigned_to IN (
         SELECT id FROM agents WHERE project_id = ? AND is_controller = 1
       )) LIMIT 1`
    ).get(projectId, projectId);

    if (!pendingForController) {
      logger.info(`Pre-controller: issue #${triggerIssueNumber} is ${issue.status}, no pending controller issues, skipping LLM`);
      return true;
    }
    // 还有待处理的 issue 需要 controller 决策
    return false;
  }

  // 规则1: issue 分配给具体 worker agent 且 agent idle → 直接启动
  if (issue.assigned_to && issue.assigned_to !== 'all') {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND project_id = ?'
    ).get(issue.assigned_to, projectId) as Agent | undefined;

    if (!agent) return false; // agent 不存在，交给 LLM

    // 是 controller → 交给 LLM controller 处理
    if (agent.is_controller) return false;

    // agent 被暂停 → 交给 LLM controller 处理
    if (agent.paused) return false;

    // agent 正在运行 → 无需操作（它会处理）
    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      logger.info(`Pre-controller: issue #${triggerIssueNumber} assigned to ${agent.name} which is running, skipping LLM`);
      return true;
    }

    // agent idle → 直接启动
    if (agent.status === 'idle') {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
      if (!project) return false;

      const issueBody = (issue.body || '').slice(0, 500);
      const prompt = `Issue #${issue.number} "${issue.title}" has been assigned to you. Review and take action.\n\nDescription: ${issueBody}`;
      const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
      const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
      const systemPrompt = isRawShell ? undefined : buildSystemPrompt(agent, project);

      logger.info(`Pre-controller: directly starting ${agent.name} for issue #${triggerIssueNumber}, bypassing LLM controller`);
      startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
      return true;
    }
  }

  // 默认: 交给 LLM controller
  return false;
}
