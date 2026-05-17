import logger from '../../logger';
import { detachChildProcessIo } from './command';
import { getDescendantPids } from './watchdog';
import {
  agentFinalResultTime,
  childCpuSnapshots,
  lastActivityTime,
  pendingRetryTimers,
  pendingStopTimers,
  runningProcesses,
  setShuttingDown,
} from './state';

export function stopAgentProcess(agentId: string): boolean {
  const retryTimer = pendingRetryTimers.get(agentId);
  if (retryTimer) {
    clearTimeout(retryTimer);
    pendingRetryTimers.delete(agentId);
  }

  const child = runningProcesses.get(agentId);
  if (!child) return false;

  logger.debug({ agentId, pid: child.pid }, 'agent.process.sigterm');
  child.kill('SIGTERM');

  const killTimer = setTimeout(() => {
    pendingStopTimers.delete(killTimer);
    if (runningProcesses.has(agentId)) {
      logger.warn({ agentId, pid: child.pid }, 'agent.process.sigkill');
      child.kill('SIGKILL');
      detachChildProcessIo(child);
      const cleanupTimer = setTimeout(() => {
        pendingStopTimers.delete(cleanupTimer);
        if (runningProcesses.has(agentId)) {
          logger.warn({ agentId, pid: child.pid }, 'agent.process.force_cleanup');
          detachChildProcessIo(child);
          runningProcesses.delete(agentId);
          lastActivityTime.delete(agentId);
        }
      }, 3000);
      pendingStopTimers.add(cleanupTimer);
    }
  }, 5000);
  pendingStopTimers.add(killTimer);

  return true;
}

export function isAgentRunning(agentId: string): boolean {
  return runningProcesses.has(agentId);
}

export function getAgentIdleMs(agentId: string): number {
  const t = lastActivityTime.get(agentId);
  return t ? Date.now() - t : -1;
}

export function resetAgentActivity(agentId: string): void {
  lastActivityTime.set(agentId, Date.now());
}

/** Currently disabled; agents restart immediately when they have assigned issues. */
export function isAgentInCooldown(_agentId: string): boolean {
  return false;
}

export function getRunningAgentIds(): string[] {
  return Array.from(runningProcesses.keys());
}

export function stopAllProcesses(): Promise<void> {
  setShuttingDown(true);

  for (const timer of pendingRetryTimers.values()) {
    clearTimeout(timer);
  }
  pendingRetryTimers.clear();

  for (const timer of pendingStopTimers) clearTimeout(timer);
  pendingStopTimers.clear();

  const agentIds = Array.from(runningProcesses.keys());
  if (agentIds.length === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let forceKillTimer: NodeJS.Timeout | null = null;
    let forceCleanupTimer: NodeJS.Timeout | null = null;

    function checkAllDone() {
      const allDone = agentIds.every(id => !runningProcesses.has(id));
      if (allDone) {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (forceCleanupTimer) clearTimeout(forceCleanupTimer);
        for (const timer of pendingRetryTimers.values()) clearTimeout(timer);
        pendingRetryTimers.clear();
        resolve();
      }
    }

    for (const agentId of agentIds) {
      const child = runningProcesses.get(agentId);
      if (!child) continue;
      logger.info(`Killing agent ${agentId} (pid: ${child.pid})`);
      child.kill('SIGTERM');
      child.once('close', () => checkAllDone());
    }

    forceKillTimer = setTimeout(() => {
      for (const agentId of agentIds) {
        const child = runningProcesses.get(agentId);
        if (child && child.pid) {
          const descendants = getDescendantPids(child.pid);
          logger.info(`Force killing agent ${agentId} (pid=${child.pid}) and ${descendants.length} descendants: [${descendants.join(',')}]`);
          for (const dpid of descendants) {
            if (dpid === process.pid || dpid === process.ppid) {
              logger.error(`stopAllProcesses: refusing to kill PID ${dpid} because it is the HAICO server (pid=${process.pid}, ppid=${process.ppid})`);
              continue;
            }
            try { process.kill(dpid, 'SIGKILL'); } catch {}
          }
          child.kill('SIGKILL');
          detachChildProcessIo(child);
        }
      }
    }, 3000);

    forceCleanupTimer = setTimeout(() => {
      for (const agentId of agentIds) {
        if (runningProcesses.has(agentId)) {
          detachChildProcessIo(runningProcesses.get(agentId));
          logger.info(`Force cleanup: agent ${agentId} close event not fired during stopAll, cleaning up`);
          runningProcesses.delete(agentId);
          lastActivityTime.delete(agentId);
          childCpuSnapshots.delete(agentId);
          agentFinalResultTime.delete(agentId);
        }
      }
      for (const timer of pendingRetryTimers.values()) clearTimeout(timer);
      pendingRetryTimers.clear();
      resolve();
    }, 6000);
  });
}

