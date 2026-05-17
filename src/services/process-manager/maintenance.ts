import type Database from 'better-sqlite3';
import { Agent } from '../../types';
import {
  getAgentIdleMs,
  isAgentRunning,
  resetAgentActivity,
  stopAgentProcess,
} from './controls';
import {
  checkChildCpuActivity,
  clearCpuSnapshot,
  getAgentFinalResultAge,
} from './watchdog';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  FINAL_RESULT_KILL_DELAY_MS,
} from './policy';

type LogMethod = {
  (message: string, ...args: unknown[]): void;
  (payload: unknown, message?: string, ...args: unknown[]): void;
};

export interface AgentWatchdogLogger {
  debug: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

function appendWatchdogLog(
  db: Database.Database,
  agentId: string,
  content: string
): void {
  db.prepare(
    "INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'stderr')"
  ).run(agentId, '', content);
}

function resetOrphanedRunningAgent(
  db: Database.Database,
  agent: Agent,
  log: AgentWatchdogLogger
): void {
  const startedAt = agent.started_at
    ? new Date(agent.started_at + (agent.started_at.includes('Z') ? '' : 'Z')).getTime()
    : 0;
  const runtimeMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : '?';
  log.warn(`Watchdog: agent "${agent.name}" marked running for ${runtimeMin} min but process is gone, resetting to idle`);
  db.prepare("UPDATE agents SET status = 'idle', pid = NULL, finished_at = datetime('now') WHERE id = ?")
    .run(agent.id);
}

function killFinalResultStuckAgent(
  db: Database.Database,
  agent: Agent,
  finalResultAge: number,
  log: AgentWatchdogLogger
): void {
  const ageMin = Math.round(finalResultAge / 60000);
  log.warn(`Watchdog: agent "${agent.name}" produced Final Result ${ageMin} min ago but process still running, force-killing`);
  appendWatchdogLog(
    db,
    agent.id,
    `[HAICO] Watchdog: process force-killed — Final Result received ${ageMin} min ago but child process stuck`
  );
  clearCpuSnapshot(agent.id);
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);
  stopAgentProcess(agent.id);
}

function killIdleAgent(
  db: Database.Database,
  agent: Agent,
  idleMs: number,
  log: AgentWatchdogLogger
): void {
  const idleMin = Math.round(idleMs / 60000);
  log.warn(`Watchdog: agent "${agent.name}" has no output for ${idleMin} min, killing (pid=${agent.pid})`);
  appendWatchdogLog(
    db,
    agent.id,
    `[HAICO] Watchdog: process killed after ${idleMin} minutes with no output`
  );
  clearCpuSnapshot(agent.id);
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);
  stopAgentProcess(agent.id);
}

export function runAgentWatchdogScan(
  db: Database.Database,
  log: AgentWatchdogLogger
): void {
  const runningAgents = db.prepare(
    "SELECT * FROM agents WHERE status = 'running'"
  ).all() as Agent[];

  for (const agent of runningAgents) {
    if (!isAgentRunning(agent.id)) {
      resetOrphanedRunningAgent(db, agent, log);
      continue;
    }

    const finalResultAge = getAgentFinalResultAge(agent.id);
    if (finalResultAge >= FINAL_RESULT_KILL_DELAY_MS) {
      killFinalResultStuckAgent(db, agent, finalResultAge, log);
      continue;
    }

    const idleMs = getAgentIdleMs(agent.id);
    if (idleMs < DEFAULT_IDLE_TIMEOUT_MS) continue;

    if (agent.pid) {
      const cpuStatus = checkChildCpuActivity(agent.id, agent.pid);
      if (cpuStatus === 'active') {
        log.debug({
          projectId: agent.project_id,
          agentId: agent.id,
          idleMinutes: Math.round(idleMs / 60000),
        }, 'watchdog.idle_cpu_active');
        resetAgentActivity(agent.id);
        continue;
      }
      if (cpuStatus === 'warming') {
        log.debug({
          projectId: agent.project_id,
          agentId: agent.id,
          idleMinutes: Math.round(idleMs / 60000),
        }, 'watchdog.idle_cpu_warming');
        resetAgentActivity(agent.id);
        continue;
      }
      if (cpuStatus === 'stale') {
        log.warn(`Watchdog: agent "${agent.name}" child processes exist but CPU stale for multiple scans, killing`);
      }
    }

    killIdleAgent(db, agent, idleMs, log);
  }
}
