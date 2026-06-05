/**
 * Adapter module — public exports.
 */

export { getAdapterRegistry, resetAdapterRegistry } from './registry';
export { getRunTracker, RunTracker } from './run-tracker';
export { BaseCliAdapter } from './base-cli-adapter';
export type { CliOutputState } from './base-cli-adapter';
export {
  isAdapterShuttingDown,
  setAdapterShuttingDown,
  getAdapterCpuSnapshots,
  getAgentFinalResultTime,
  resetAdapterGlobalState,
  resolveAgentCwd,
} from './base-cli-adapter';
export { TaskRunEventBridge } from './bridge';
export { ClaudeCliAdapter } from './claude';
export { CodexCliAdapter } from './codex';
export { GeminiCliAdapter } from './gemini';
export { ShellAdapter } from './shell';

export type {
  Adapter,
  AdapterRegistry,
  AdapterStartInput,
  AdapterRunHandle,
  AdapterEventSink,
  AdapterRuntimeEvent,
  AdapterOutputEvent,
  AdapterToolUseEvent,
  AdapterToolResultEvent,
  AdapterCostEvent,
  AdapterCompletedEvent,
  AdapterErrorEvent,
  AdapterSessionUpdatedEvent,
} from './types';
