import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Agent, Issue, Project } from '../../types';
import { eventBus } from '../../events';
import { buildAgentWakeupSignature, getAgentWakeupDecision, recordAgentWakeup } from '../agent-wakeup-guard';
import { deriveAgentRuntimeStatus } from '../tasks/runtime-state';
import { buildAssignedIssuesPrompt, getAgentIssueBatch } from './batch';
import { listDispatchableIssuesForAgent } from './dispatch';

export interface AssignedIssueAutoStartResult {
  started: boolean;
  reason: string;
  activeIssueCount: number;
  currentBatchIssueNumbers: number[];
  runId?: string;
  taskId?: string;
}

export function autoStartAgentForDispatchableIssues(
  db: Database.Database,
  project: Project,
  agent: Agent,
  opts: {
    source: string;
    allowStatuses?: Agent['status'][];
    assignedIssues?: Issue[];
  }
): AssignedIssueAutoStartResult {
  if (project.status === 'paused') {
    return {
      started: false,
      reason: `${opts.source}: project is paused`,
      activeIssueCount: 0,
      currentBatchIssueNumbers: [],
    };
  }

  const dispatchableIssues = opts.assignedIssues
    || listDispatchableIssuesForAgent(db, project.id, agent.id);
  const batch = getAgentIssueBatch(dispatchableIssues);
  const signature = buildAgentWakeupSignature(batch.activeIssues);
  const runtimeStatus = deriveAgentRuntimeStatus(db, agent);
  const wakeupDecision = getAgentWakeupDecision(
    { id: agent.id, status: runtimeStatus === 'paused' ? 'waiting' : runtimeStatus === 'error' ? 'error' : runtimeStatus === 'running' ? 'running' : 'idle', paused: Boolean(agent.paused) },
    batch.activeIssues,
    {
      source: opts.source,
      allowStatuses: opts.allowStatuses || ['idle'],
    }
  );
  if (!signature.signature) {
    return {
      started: false,
      reason: `${opts.source}: no dispatchable assigned issues`,
      activeIssueCount: signature.activeIssueCount,
      currentBatchIssueNumbers: signature.currentBatchIssueNumbers,
    };
  }
  if (!wakeupDecision.allowed) {
    return {
      started: false,
      reason: wakeupDecision.reason,
      activeIssueCount: wakeupDecision.activeIssueCount,
      currentBatchIssueNumbers: wakeupDecision.currentBatchIssueNumbers,
    };
  }

  const prompt = [
    `You have been assigned issue work in project "${project.name}".`,
    '',
    buildAssignedIssuesPrompt(batch),
    '',
    'Use the HAICO issue APIs to inspect full issue details, update progress, and leave a substantive summary comment before marking work complete.',
  ].join('\n');
  const dedupeKey = [
    'issue-work',
    project.id,
    agent.id,
    signature.activityKey || signature.signature,
  ].join(':');
  const taskId = uuidv4();
  eventBus.publish('task.requested', {
    type: 'task.requested',
    projectId: project.id,
    payload: {
      taskId,
      agentId: agent.id,
      source: 'issue-assignment',
      sourceRef: batch.currentBatch[0]?.id || null,
      taskType: 'issue-work',
      reason: `${opts.source}: assigned issue batch queued`,
      prompt,
      priority: Math.max(...batch.currentBatch.map((issue) => issue.priority), 0),
      metadata: {
        source: opts.source,
        active_issue_count: batch.activeIssues.length,
        current_batch_issue_ids: batch.currentBatch.map((issue) => issue.id),
        current_batch_issue_numbers: batch.currentBatch.map((issue) => issue.number),
        queued_issue_numbers: batch.queuedIssues.map((issue) => issue.number),
      },
      dedupeKey,
      forceNewSession: false,
      scheduledAt: null,
    },
    meta: { correlationId: taskId, timestamp: Date.now(), source: 'issue/agent-autostart.autoStartAgentForDispatchableIssues' },
  });
  recordAgentWakeup(agent.id, wakeupDecision.signature, opts.source, wakeupDecision.activityKey);

  return {
    started: true,
    reason: `${opts.source}: queued issue-work task`,
    activeIssueCount: batch.activeIssues.length,
    currentBatchIssueNumbers: batch.currentBatch.map((issue) => issue.number),
    taskId,
  };
}
