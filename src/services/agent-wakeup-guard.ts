import { Agent, Issue } from '../types';
import { getAgentIssueBatch, MAX_ASSIGNED_ISSUES_PER_RUN } from './issue/batch';

interface WakeupRecord {
  signature: string;
  activityKey: string;
  startedAtMs: number;
  source: string;
  attempts: number;
}

export interface AgentWakeupDecision {
  allowed: boolean;
  reason: string;
  signature: string;
  activityKey: string;
  activeIssueCount: number;
  currentBatchIssueNumbers: number[];
}

const recentWakeups = new Map<string, WakeupRecord>();
const UNCHANGED_ERROR_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const MAX_UNCHANGED_ERROR_RETRIES = 2;

function buildIssueFingerprint(issue: Issue): string {
  return [
    issue.id,
    issue.number,
  ].join(':');
}

function buildIssueActivityFingerprint(issue: Issue): string {
  return [
    issue.id,
    issue.number,
    issue.status,
    issue.assigned_to || '',
    parseIssueUpdatedAt(issue.updated_at),
  ].join(':');
}

function parseIssueUpdatedAt(updatedAt: string | null | undefined): number {
  if (!updatedAt) return 0;
  const normalized = updatedAt.includes('T')
    ? (updatedAt.endsWith('Z') ? updatedAt : updatedAt + 'Z')
    : updatedAt.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function buildAgentWakeupSignature(
  issues: Issue[],
  maxIssues = MAX_ASSIGNED_ISSUES_PER_RUN
): { signature: string; activityKey: string; activeIssueCount: number; currentBatchIssueNumbers: number[] } {
  const issueBatch = getAgentIssueBatch(issues, maxIssues);
  const signature = issueBatch.currentBatch.map(buildIssueFingerprint).join('|');
  const activityKey = issueBatch.currentBatch.map(buildIssueActivityFingerprint).join('|');
  return {
    signature,
    activityKey,
    activeIssueCount: issueBatch.activeIssues.length,
    currentBatchIssueNumbers: issueBatch.currentBatch.map((issue) => issue.number),
  };
}

export function getAgentWakeupDecision(
  agent: Pick<Agent, 'id' | 'status' | 'paused'>,
  issues: Issue[],
  opts?: {
    source?: string;
    allowStatuses?: Agent['status'][];
    maxIssues?: number;
    nowMs?: number;
  }
): AgentWakeupDecision {
  const source = opts?.source || 'auto-wake';
  const allowStatuses = opts?.allowStatuses || ['idle'];
  const nowMs = opts?.nowMs ?? Date.now();
  const signatureInfo = buildAgentWakeupSignature(issues, opts?.maxIssues);

  if (agent.paused) {
    return {
      allowed: false,
      reason: `${source}: agent is paused`,
      ...signatureInfo,
    };
  }

  if (!allowStatuses.includes(agent.status)) {
    return {
      allowed: false,
      reason: `${source}: agent status ${agent.status} is not auto-startable`,
      ...signatureInfo,
    };
  }

  if (!signatureInfo.signature) {
    return {
      allowed: false,
      reason: `${source}: no issue batch available`,
      ...signatureInfo,
    };
  }

  const existing = recentWakeups.get(agent.id);
  if (existing
      && existing.signature === signatureInfo.signature
      && existing.activityKey === signatureInfo.activityKey) {
    const ageMs = nowMs - existing.startedAtMs;

    if (agent.status === 'error' && allowStatuses.includes('error')) {
      const retriesUsed = Math.max(0, existing.attempts - 1);
      if (retriesUsed >= MAX_UNCHANGED_ERROR_RETRIES) {
        return {
          allowed: false,
          reason: `${source}: unchanged issue batch already auto-started ${existing.attempts} time(s) and still errors; waiting for issue activity or manual intervention`,
          ...signatureInfo,
        };
      }

      const retryNumber = retriesUsed + 1;
      if (ageMs < UNCHANGED_ERROR_RETRY_BACKOFF_MS) {
        const waitSeconds = Math.max(1, Math.ceil((UNCHANGED_ERROR_RETRY_BACKOFF_MS - ageMs) / 1000));
        return {
          allowed: false,
          reason: `${source}: unchanged issue batch errored; retry ${retryNumber}/${MAX_UNCHANGED_ERROR_RETRIES} available in ${waitSeconds}s`,
          ...signatureInfo,
        };
      }

      return {
        allowed: true,
        reason: `${source}: retrying unchanged issue batch after error (${retryNumber}/${MAX_UNCHANGED_ERROR_RETRIES})`,
        ...signatureInfo,
      };
    }

    return {
      allowed: false,
      reason: `${source}: same unchanged issue batch already auto-started ${Math.round(ageMs / 1000)}s ago via ${existing.source}`,
      ...signatureInfo,
    };
  }

  return {
    allowed: true,
    reason: `${source}: allowed`,
    ...signatureInfo,
  };
}

export function recordAgentWakeup(
  agentId: string,
  signature: string,
  source: string,
  activityKey = '',
  startedAtMs = Date.now()
): void {
  if (!signature) return;
  const existing = recentWakeups.get(agentId);
  const attempts = existing
    && existing.signature === signature
    && existing.activityKey === activityKey
      ? existing.attempts + 1
      : 1;
  recentWakeups.set(agentId, {
    signature,
    activityKey,
    startedAtMs,
    source,
    attempts,
  });
}

export function resetAgentWakeupState(agentId?: string): void {
  if (agentId) {
    recentWakeups.delete(agentId);
    return;
  }
  recentWakeups.clear();
}
