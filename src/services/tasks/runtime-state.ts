import Database from 'better-sqlite3';
import { getDatabase } from '../../db/database';
import { AgentRuntimeState, AgentRuntimeStatus } from '../../types';
import { AgentNotFoundError } from '../agents/errors';

export interface AgentRuntimeSource {
  id: string;
  paused?: number | boolean | null;
  constraints_json?: string | null;
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function deriveAgentRuntimeState(
  db: Database.Database,
  agent: AgentRuntimeSource
): AgentRuntimeState {
  const constraints = safeJsonParse<{ paused?: boolean }>(agent.constraints_json, {});
  const active = db.prepare(`
    SELECT id, task_id, status
    FROM task_runs
    WHERE agent_id = ? AND status IN ('starting', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(agent.id) as { id: string; task_id: string; status: string } | undefined;
  const last = db.prepare(`
    SELECT id, task_id, status
    FROM task_runs
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(agent.id) as { id: string; task_id: string; status: string } | undefined;

  if (agent.paused || constraints.paused) {
    return {
      status: 'paused',
      active_task_id: active?.task_id || null,
      active_task_run_id: active?.id || null,
      last_task_run_id: last?.id || null,
    };
  }

  if (active) {
    return {
      status: active.status === 'starting' ? 'waiting' : 'running',
      active_task_id: active.task_id,
      active_task_run_id: active.id,
      last_task_run_id: last?.id || null,
    };
  }

  return {
    status: last?.status === 'failed' ? 'error' : 'idle',
    active_task_id: null,
    active_task_run_id: null,
    last_task_run_id: last?.id || null,
  };
}

export function deriveAgentRuntimeStatus(
  db: Database.Database,
  agent: AgentRuntimeSource
): AgentRuntimeStatus {
  return deriveAgentRuntimeState(db, agent).status;
}

export function summarizeAgentRuntimeStates(
  db: Database.Database,
  agents: AgentRuntimeSource[]
): { total: number; running: number; error_count: number; idle_count: number; paused_count: number } {
  return agents.reduce((acc, agent) => {
    const status = deriveAgentRuntimeStatus(db, agent);
    acc.total += 1;
    if (status === 'running' || status === 'waiting') acc.running += 1;
    if (status === 'error') acc.error_count += 1;
    if (status === 'idle') acc.idle_count += 1;
    if (status === 'paused') acc.paused_count += 1;
    return acc;
  }, { total: 0, running: 0, error_count: 0, idle_count: 0, paused_count: 0 });
}

export function getAgentRuntimeState(agentId: string): AgentRuntimeState {
  const db = getDatabase();
  const agent = db.prepare(`
    SELECT id, paused, constraints_json
    FROM agents
    WHERE id = ?
  `).get(agentId) as AgentRuntimeSource | undefined;
  if (!agent) throw new AgentNotFoundError();
  return deriveAgentRuntimeState(db, agent);
}
