/**
 * AdapterRunTracker — unified view of running tasks across all adapters.
 *
 * Adapters register/unregister runs here.  Watchdog, completion, and app
 * shutdown query this single source instead of importing adapter internals.
 */

import type { Adapter } from './types';

interface RunEntry {
  adapter: Adapter;
  taskRunId: string;
}

class RunTracker {
  private readonly runs = new Map<string, RunEntry>();

  register(taskRunId: string, adapter: Adapter): void {
    this.runs.set(taskRunId, { adapter, taskRunId });
  }

  unregister(taskRunId: string): void {
    this.runs.delete(taskRunId);
  }

  isRunning(taskRunId: string): boolean {
    const entry = this.runs.get(taskRunId);
    return entry ? entry.adapter.isRunning(taskRunId) : false;
  }

  getIdleMs(taskRunId: string): number {
    const entry = this.runs.get(taskRunId);
    return entry ? entry.adapter.getIdleMs(taskRunId) : -1;
  }

  stop(taskRunId: string): boolean {
    const entry = this.runs.get(taskRunId);
    return entry ? entry.adapter.stop(taskRunId) : false;
  }

  async stopAll(): Promise<void> {
    const taskRunIds = Array.from(this.runs.keys());
    for (const id of taskRunIds) {
      const entry = this.runs.get(id);
      if (entry) {
        entry.adapter.stop(id);
      }
    }
    this.runs.clear();
  }

  /** Get the adapter managing a task run (used by completion flow) */
  getAdapter(taskRunId: string): Adapter | undefined {
    return this.runs.get(taskRunId)?.adapter;
  }
}

// ── Global singleton ──

let globalTracker: RunTracker | null = null;

export function getRunTracker(): RunTracker {
  if (!globalTracker) {
    globalTracker = new RunTracker();
  }
  return globalTracker;
}

export { RunTracker };
