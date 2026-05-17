import { getDatabase } from '../db/database';
import { Agent, Project, Issue } from '../types';
import { startAgentProcess, isAgentRunning, isAgentInCooldown } from './process-manager';
import { getAgentIssueBatch, buildAssignedIssuesPrompt, markCurrentBatchInProgress } from './issue/batch';
import { buildAgentWakeupSignature, getAgentWakeupDecision, recordAgentWakeup } from './agent-wakeup-guard';
import { buildSystemPrompt } from './system-prompt';
import { findControllerRecoveryIssue, getPendingDependencyState, listDispatchableIssuesForAgent } from './issue/dispatch';
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

  // 规则2: issue assigned_to = "user" 且非 open/in_progress → 无需操作
  // open/in_progress 的 user-assigned issue 需要 controller 重新分配（如用户 reopen 了已完成的 issue）
  if (issue.assigned_to === 'user' && issue.status !== 'open' && issue.status !== 'in_progress') {
    logger.debug({ projectId, issueNumber: triggerIssueNumber, status: issue.status }, 'pre_controller.skipped_user_assigned');
    return true;
  }

  // 规则2b: issue is pending (waiting for child issues / blockers)
  // 只有在所有依赖都已解除时才恢复执行，否则继续等待。
  if (issue.status === 'pending') {
    const deps = getPendingDependencyState(db, projectId, issue.id);
    if (deps.activeChildren > 0 || deps.activeBlockers > 0) {
      logger.debug({
        projectId,
        issueNumber: triggerIssueNumber,
        activeChildren: deps.activeChildren,
        activeBlockers: deps.activeBlockers,
      }, 'pre_controller.skipped_pending_dependencies');
      return true;
    }
    logger.info({ projectId, issueNumber: triggerIssueNumber }, 'pre_controller.pending_ready');
  }

  // 规则3: issue 已完成 (done/closed) → 检查是否还有其他需要 controller 处理的 issue
  if (issue.status === 'done' || issue.status === 'closed') {
    const pendingForController = findControllerRecoveryIssue(db, projectId);

    if (!pendingForController) {
      logger.debug({ projectId, issueNumber: triggerIssueNumber, status: issue.status }, 'pre_controller.skipped_completed_issue');
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
      logger.debug({ projectId, issueNumber: triggerIssueNumber, agentId: agent.id }, 'pre_controller.skipped_agent_running');
      return true;
    }

    // agent in cooldown → skip restart, treat as handled (will restart after cooldown)
    if (agent.status === 'idle' && isAgentInCooldown(agent.id)) {
      logger.debug({ projectId, issueNumber: triggerIssueNumber, agentId: agent.id }, 'pre_controller.skipped_agent_cooldown');
      return true;
    }

    // agent idle → 直接启动，但每轮只处理一个小批次，避免 prompt 过载
    if (agent.status === 'idle') {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
      if (!project) return false;

      const allAssigned = listDispatchableIssuesForAgent(db, projectId, agent.id);
      const wakeDecision = getAgentWakeupDecision(agent, allAssigned, { source: 'pre-controller' });
      if (!wakeDecision.allowed) {
        logger.debug({ projectId, issueNumber: triggerIssueNumber, agentId: agent.id, reason: wakeDecision.reason }, 'pre_controller.autostart_suppressed');
        return true;
      }
      const issueBatch = getAgentIssueBatch(allAssigned);

      const parts: string[] = [];
      if (agent.role) parts.push(`Role: ${agent.role}`);
      if (project.task_description) parts.push(`Task: ${project.task_description}`);
      if (issueBatch.currentBatch.length > 0) {
        parts.push(buildAssignedIssuesPrompt(issueBatch));
        markCurrentBatchInProgress(db, issueBatch);
      }
      const prompt = parts.join('\n\n');
      if (!prompt) return false;

      const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
      const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
      const systemPrompt = isRawShell ? undefined : buildSystemPrompt(agent, project);
      const recordedWakeup = buildAgentWakeupSignature(
        listDispatchableIssuesForAgent(db, projectId, agent.id)
      );

      logger.info({
        projectId,
        issueNumber: triggerIssueNumber,
        agentId: agent.id,
        currentBatchCount: issueBatch.currentBatch.length,
        activeIssueCount: issueBatch.activeIssues.length,
      }, 'pre_controller.agent_started');
      startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
      recordAgentWakeup(agent.id, recordedWakeup.signature, 'pre-controller', recordedWakeup.activityKey);
      return true;
    }
  }

  // 默认: 交给 LLM controller
  return false;
}
