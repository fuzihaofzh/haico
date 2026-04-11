import type Database from 'better-sqlite3';
import { Agent, Project } from '../types';
import { config } from '../config';
import { getAgentIssueBatch, buildAssignedIssuesPrompt, markCurrentBatchInProgress } from './agent-issue-batch';
import { buildAgentWakeupSignature, getAgentWakeupDecision, recordAgentWakeup } from './agent-wakeup-guard';
import { listDispatchableIssuesForAgent } from './issue-dispatch';
import { startAgentProcess } from './process-manager';
import { buildSystemPrompt } from './system-prompt';

export interface AssignedIssueAutoStartResult {
  started: boolean;
  reason: string;
  activeIssueCount: number;
  currentBatchIssueNumbers: number[];
}

export function autoStartAgentForDispatchableIssues(
  db: Database.Database,
  project: Project,
  agent: Agent,
  opts: {
    source: string;
    allowStatuses?: Agent['status'][];
  }
): AssignedIssueAutoStartResult {
  const assignedIssues = listDispatchableIssuesForAgent(db, project.id, agent.id);
  const wakeDecision = getAgentWakeupDecision(agent, assignedIssues, {
    source: opts.source,
    allowStatuses: opts.allowStatuses,
  });

  if (!wakeDecision.allowed) {
    return {
      started: false,
      reason: wakeDecision.reason,
      activeIssueCount: wakeDecision.activeIssueCount,
      currentBatchIssueNumbers: wakeDecision.currentBatchIssueNumbers,
    };
  }

  const issueBatch = getAgentIssueBatch(assignedIssues);
  const parts: string[] = [];
  if (agent.role) parts.push(`Role: ${agent.role}`);
  if (project.task_description) parts.push(`Task: ${project.task_description}`);
  if (issueBatch.currentBatch.length > 0) {
    parts.push(buildAssignedIssuesPrompt(issueBatch));
    markCurrentBatchInProgress(db, issueBatch);
  }

  const prompt = parts.join('\n\n');
  if (!prompt) {
    return {
      started: false,
      reason: `${opts.source}: no prompt could be generated`,
      activeIssueCount: wakeDecision.activeIssueCount,
      currentBatchIssueNumbers: wakeDecision.currentBatchIssueNumbers,
    };
  }

  const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
  const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
  const systemPrompt = isRawShell ? undefined : buildSystemPrompt(agent, project);
  const recordedWakeup = buildAgentWakeupSignature(
    listDispatchableIssuesForAgent(db, project.id, agent.id)
  );

  startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
  recordAgentWakeup(agent.id, recordedWakeup.signature, opts.source, recordedWakeup.activityKey);

  return {
    started: true,
    reason: wakeDecision.reason,
    activeIssueCount: wakeDecision.activeIssueCount,
    currentBatchIssueNumbers: wakeDecision.currentBatchIssueNumbers,
  };
}
