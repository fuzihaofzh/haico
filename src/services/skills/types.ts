import type { Agent, Project } from '../../types';

/**
 * Memory strategy hint provided by a skill.
 * The agent holds the actual memory; the skill suggests how it should be maintained.
 */
export type SkillMemoryStrategy = 'none' | 'append' | 'reduce';

/**
 * Context passed to prompt fragment builders.
 * Provides all runtime data needed to generate a skill's prompt contribution.
 */
export interface SkillPromptContext {
  agent: Agent;
  project: Project;
  baseUrl: string;
  /** Shorthand for the curl command with proxy bypass */
  curl: string;
}

/**
 * A SkillDefinition is the declarative + implementation binding for an agent capability.
 *
 * - `promptFragment`: provides information the LLM needs to use this skill.
 *   Can be a static string or a function that generates dynamic content (e.g. API endpoints).
 * - `memoryStrategy`: hints how the agent should maintain memory for this skill.
 * - `triggerHandler`: optional handler invoked by the scheduling system when a trigger event fires.
 * - `actionHandler`: optional handler for executing skill actions directly (bypassing LLM).
 */
export interface SkillDefinition {
  /** Unique identifier, e.g. "issue-tracking", "watch-dir" */
  id: string;

  /** Human-readable description */
  description: string;

  /**
   * Prompt content to inject when the agent has this skill.
   * - Static string: used as-is
   * - Function: called with context to generate dynamic prompt
   * - Empty string / undefined: no prompt contribution (e.g. trigger-only skills)
   */
  promptFragment?: string | ((ctx: SkillPromptContext) => string);

  /**
   * Memory strategy hint for this skill.
   * The agent decides how to use this hint; it is not enforced.
   */
  memoryStrategy?: SkillMemoryStrategy;

  /**
   * Trigger handler: invoked by the scheduling system when a trigger event fires.
   * Registered as an EventBus subscriber internally.
   * The handler decides whether to activate the owning agent.
   */
  triggerHandler?: SkillTriggerHandler;

  /**
   * Action handler: executes a skill action directly.
   * Used when the skill can handle an action without LLM involvement,
   * or when the LLM delegates execution to the handler.
   */
  actionHandler?: SkillActionHandler;
}

/**
 * Trigger handler context.
 */
export interface SkillTriggerContext {
  projectId: string;
  /** Event payload from the triggering event */
  payload: Record<string, unknown>;
}

/**
 * Result of a trigger handler invocation.
 */
export interface SkillTriggerResult {
  /** Whether the trigger should activate the agent */
  shouldActivate: boolean;
  /** Optional prompt supplement for the activated agent */
  promptHint?: string;
  /** Optional metadata to attach to the created task */
  metadata?: Record<string, unknown>;
}

/**
 * Trigger handler: decides whether to activate an agent based on an event.
 */
export type SkillTriggerHandler = (ctx: SkillTriggerContext) => SkillTriggerResult | Promise<SkillTriggerResult>;

/**
 * Action handler context.
 */
export interface SkillActionContext {
  agent: Agent;
  project: Project;
  /** Parameters for the action, typically from LLM decision or trigger result */
  params: Record<string, unknown>;
}

/**
 * Result of an action handler invocation.
 */
export interface SkillActionResult {
  success: boolean;
  /** Result data to feed back to the agent or store */
  data?: Record<string, unknown>;
  /** Error message if success is false */
  error?: string;
}

/**
 * Action handler: executes a skill action.
 */
export type SkillActionHandler = (ctx: SkillActionContext) => SkillActionResult | Promise<SkillActionResult>;
