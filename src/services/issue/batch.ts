import type Database from 'better-sqlite3';
import { Issue } from '../../types';
import { updateIssue } from './core';

export const MAX_ASSIGNED_ISSUES_PER_RUN = 2;

export interface AgentIssueBatch {
  activeIssues: Issue[];
  currentBatch: Issue[];
  queuedIssues: Issue[];
}

function compareIssues(a: Issue, b: Issue): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.created_at !== b.created_at) return String(a.created_at).localeCompare(String(b.created_at));
  return a.number - b.number;
}

function formatCurrentIssue(issue: Issue, bodyCharLimit: number): string {
  const body = (issue.body || '').slice(0, bodyCharLimit) || '(no description)';
  return `#${issue.number} [${issue.status}] [p${issue.priority}] ${issue.title}: ${body}`;
}

function formatQueuedIssue(issue: Issue): string {
  return `#${issue.number} [${issue.status}] [p${issue.priority}] ${issue.title}`;
}

export function getAgentIssueBatch(assignedIssues: Issue[], maxIssues = MAX_ASSIGNED_ISSUES_PER_RUN): AgentIssueBatch {
  const activeIssues = [...assignedIssues].sort(compareIssues);
  const batchSize = Math.max(1, maxIssues);
  const currentBatch = activeIssues.slice(0, batchSize);
  const queuedIssues = activeIssues.slice(currentBatch.length);
  return { activeIssues, currentBatch, queuedIssues };
}

export function buildAssignedIssuesPrompt(
  batch: AgentIssueBatch,
  options?: {
    bodyCharLimit?: number;
    currentLabel?: string;
    queuedLabel?: string;
    stopInstruction?: string;
  }
): string {
  const bodyCharLimit = options?.bodyCharLimit ?? 200;
  const currentLabel = options?.currentLabel ?? `Current batch (${batch.currentBatch.length}/${batch.activeIssues.length} assigned issue(s))`;
  const queuedLabel = options?.queuedLabel ?? `Queued for later (${batch.queuedIssues.length} more assigned issue(s))`;
  const stopInstruction = options?.stopInstruction
    ?? 'Only work on the current batch in this run. When the current batch is complete, stop; HAICO will restart you for the next batch if more assigned issues remain.';

  const parts: string[] = [];
  parts.push(currentLabel + ':\n' + batch.currentBatch.map((issue) => formatCurrentIssue(issue, bodyCharLimit)).join('\n'));

  if (batch.queuedIssues.length > 0) {
    const preview = batch.queuedIssues.slice(0, 5).map(formatQueuedIssue).join('\n');
    const remainder = batch.queuedIssues.length - Math.min(batch.queuedIssues.length, 5);
    const moreLine = remainder > 0 ? `\n... and ${remainder} more queued issue(s)` : '';
    parts.push(queuedLabel + ':\n' + preview + moreLine);
  }

  if (stopInstruction) {
    parts.push(stopInstruction);
  }

  return parts.join('\n\n');
}

export function markCurrentBatchInProgress(db: Database.Database, batch: AgentIssueBatch): void {
  const resumableIssues = batch.currentBatch
    .filter((issue) => issue.status === 'open' || issue.status === 'pending');

  if (resumableIssues.length === 0) return;

  for (const issue of resumableIssues) {
    updateIssue(db, issue.id, {
      status: 'in_progress',
      actor: 'system',
    });
  }
}
