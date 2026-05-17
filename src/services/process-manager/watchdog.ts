import fs from 'fs';
import { CPU_STALE_THRESHOLD } from './policy';
import { agentFinalResultTime, childCpuSnapshots } from './state';

export type ChildCpuActivity = 'active' | 'stale' | 'warming' | 'no_children';

/** Get all descendant PIDs of a process by traversing /proc. */
export function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    try {
      const entries = fs.readdirSync('/proc').filter(e => /^\d+$/.test(e));
      for (const entry of entries) {
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
          const match = stat.match(/^\d+\s+\([^)]*\)\s+\S+\s+(\d+)/);
          if (match && parseInt(match[1]) === parentPid) {
            const childPid = parseInt(entry);
            descendants.push(childPid);
            queue.push(childPid);
          }
        } catch {}
      }
    } catch {
      break;
    }
  }
  return descendants;
}

function getProcessCpuTime(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    const utime = parseInt(fields[11]) || 0;
    const stime = parseInt(fields[12]) || 0;
    return utime + stime;
  } catch {
    return 0;
  }
}

export function checkChildCpuActivity(agentId: string, pid: number): ChildCpuActivity {
  const descendants = getDescendantPids(pid);
  if (descendants.length === 0) return 'no_children';

  let totalCpu = 0;
  for (const dpid of descendants) {
    totalCpu += getProcessCpuTime(dpid);
  }

  const prev = childCpuSnapshots.get(agentId);
  if (!prev) {
    childCpuSnapshots.set(agentId, { totalCpuTime: totalCpu, staleCount: 0 });
    return 'active';
  }

  if (totalCpu > prev.totalCpuTime) {
    childCpuSnapshots.set(agentId, { totalCpuTime: totalCpu, staleCount: 0 });
    return 'active';
  }

  const newStaleCount = prev.staleCount + 1;
  childCpuSnapshots.set(agentId, { totalCpuTime: totalCpu, staleCount: newStaleCount });

  return newStaleCount >= CPU_STALE_THRESHOLD ? 'stale' : 'warming';
}

export function clearCpuSnapshot(agentId: string): void {
  childCpuSnapshots.delete(agentId);
}

export function getAgentFinalResultAge(agentId: string): number {
  const t = agentFinalResultTime.get(agentId);
  return t ? Date.now() - t : -1;
}

