import { ChildProcess } from 'child_process';

export interface CpuSnapshot {
  totalCpuTime: number;
  staleCount: number;
}

export const runningProcesses = new Map<string, ChildProcess>();
export const lastActivityTime = new Map<string, number>();
export const childCpuSnapshots = new Map<string, CpuSnapshot>();

export const agentApiConnectErrorCount = new Map<string, number>();
export const agentLastErrorWasApiConnect = new Map<string, boolean>();
export const pendingRetryTimers = new Map<string, NodeJS.Timeout>();
export const pendingStopTimers = new Set<NodeJS.Timeout>();
export const agentFinalResultTime = new Map<string, number>();

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

