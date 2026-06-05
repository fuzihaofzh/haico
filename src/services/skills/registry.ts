import type { SkillDefinition, SkillPromptContext } from './types';

/**
 * Global skill registry. Built-in skills are registered at app startup
 * via registerBuiltinSkills(). Custom skills can be registered later.
 */
const skills = new Map<string, SkillDefinition>();

/**
 * Register a skill definition.
 */
export function registerSkill(skill: SkillDefinition): void {
  if (skills.has(skill.id)) {
    throw new Error(`Skill already registered: ${skill.id}`);
  }
  skills.set(skill.id, skill);
}

/**
 * Get a skill definition by id.
 */
export function getSkill(id: string): SkillDefinition | undefined {
  return skills.get(id);
}

/**
 * Resolve the prompt fragment for a skill given a context.
 * Handles both static strings and dynamic builder functions.
 */
export function resolvePromptFragment(skill: SkillDefinition, ctx: SkillPromptContext): string {
  if (!skill.promptFragment) return '';
  if (typeof skill.promptFragment === 'function') {
    return skill.promptFragment(ctx);
  }
  return skill.promptFragment;
}

/**
 * Parse capabilities_json into a list of skill ids.
 * Returns empty array for invalid/missing input.
 */
export function parseCapabilities(capabilitiesJson: string | undefined | null): string[] {
  if (!capabilitiesJson) return [];
  try {
    const parsed = JSON.parse(capabilitiesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

let builtinsRegistered = false;

/**
 * Register all built-in skills. Called once at app startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function registerBuiltinSkills(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  const builtins: SkillDefinition[] = [
    require('./builtins/issue-tracking').default,
    require('./builtins/knowledge-base').default,
    require('./builtins/direct-message').default,
    require('./builtins/agent-management').default,
    require('./builtins/code-edit').default,
    require('./builtins/issue-assigned').default,
    require('./builtins/scheduled-check').default,
  ];
  for (const skill of builtins) {
    if (skill) registerSkill(skill);
  }
}
