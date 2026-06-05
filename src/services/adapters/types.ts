/**
 * Agent Adapter types — the unified interface between the scheduler/consumers
 * and type-specific execution logic (CLI, future API).
 *
 * Adapters are sealed black boxes: invocation, output parsing, completion
 * detection, cost extraction all happen inside.  External code only sees
 * structured events through AdapterEventSink.
 */

import type { Agent, Project } from '../../types';
import type { ExecutorSnapshot } from '../executors/types';
import type { ToolReadinessSummary } from '../tool-readiness';

// ── Runtime events emitted by adapters ──

export interface AdapterOutputEvent {
  type: 'output';
  runId: string;
  stream: 'stdout' | 'stderr';
  content: string;
}

export interface AdapterToolUseEvent {
  type: 'tool_use';
  runId: string;
  toolName: string;
  input: string;
}

export interface AdapterToolResultEvent {
  type: 'tool_result';
  runId: string;
  output: string;
}

export interface AdapterCostEvent {
  type: 'cost';
  runId: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
  duration_ms?: number;
}

export interface AdapterCompletedEvent {
  type: 'completed';
  runId: string;
  result?: string;
  cost?: AdapterCostEvent;
}

export interface AdapterErrorEvent {
  type: 'error';
  runId: string;
  message: string;
  fatal: boolean;
}

export interface AdapterSessionUpdatedEvent {
  type: 'session_updated';
  runId: string;
  sessionId: string;
}

export type AdapterRuntimeEvent =
  | AdapterOutputEvent
  | AdapterToolUseEvent
  | AdapterToolResultEvent
  | AdapterCostEvent
  | AdapterCompletedEvent
  | AdapterErrorEvent
  | AdapterSessionUpdatedEvent;

// ── Event sink — adapter calls, external implements ──

export interface AdapterEventSink {
  onEvent(event: AdapterRuntimeEvent): void;
}

// ── Adapter start input / run handle ──

export interface AdapterStartInput {
  agent: Agent;
  taskId: string;
  taskRunId: string;
  runId: string;
  prompt: string;
  systemPrompt?: string | null;
  executor: ExecutorSnapshot;
  executorProfileId: string | null;
}

export interface AdapterRunHandle {
  runId: string;
  pid?: number;
  sessionId: string;
  command?: string;
}

// ── Adapter interface ──

export interface Adapter {
  /** adapter type identifier — the registry key */
  readonly type: string;

  /** Whether this adapter needs a completion signal to consider exit successful */
  readonly requiresCompletionSignal: boolean;

  /** Start a run. Returns handle immediately; progress via event sink. */
  start(input: AdapterStartInput, events: AdapterEventSink): AdapterRunHandle;

  /** Stop a running task */
  stop(taskRunId: string): boolean;

  /** Query whether a task run is still active */
  isRunning(taskRunId: string): boolean;

  /** Idle milliseconds since last output (watchdog) */
  getIdleMs(taskRunId: string): number;

  /** Detect readiness: binary exists, auth configured */
  inspectReadiness(commandTemplate: string): ToolReadinessSummary;

  /** Build type-specific system prompt section (may be empty) */
  buildSystemPromptSection(agent: Agent, project: Project): string;

  /** Build PTY launch arguments for interactive terminal */
  buildPtyArgs(commandTemplate: string, sessionId?: string): {
    command: string;
    args: string[];
    useShell: boolean;
  };

  /** Build CLI command for project metadata generation */
  buildMetadataCommand(commandTemplate: string): string;

  /** Build CLI command for dashboard chat one-shot invocation */
  buildChatCommand(commandTemplate: string): { command: string; binary: string };

  /** Default timeout for dashboard chat one-shot invocation (ms) */
  readonly chatTimeoutMs: number;

  /** Build controller-specific command (e.g. append default model for claude) */
  buildControllerCommand(commandTemplate: string, commandProfileConfigJson?: string | Record<string, unknown> | null): string;

  /** Build the full process-launch command for an agent run (replaces buildAgentProcessCommand) */
  buildProcessCommand(input: {
    commandTemplate: string;
    sessionId: string;
    existingSessionId: string | null;
    commandProfileConfigJson: string;
  }): { command: string; useStreamJson: boolean };

  /** Stop all runs managed by this adapter */
  stopAll(): Promise<void>;
}

// ── Adapter registry interface ──

export interface AdapterRegistry {
  register(adapter: Adapter): void;
  get(type: string): Adapter | undefined;
  listTypes(): string[];
  resolveFromCommand(commandTemplate: string, explicitType?: string | null): Adapter;
}
