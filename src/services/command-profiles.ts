import { config } from '../config';
import { Agent, Project } from '../types';

export const COMMAND_PROFILE_TYPES = ['claude', 'codex', 'gemini'] as const;

export type CommandProfileType = (typeof COMMAND_PROFILE_TYPES)[number];

export function isCommandProfileType(value: unknown): value is CommandProfileType {
  return value === 'claude' || value === 'codex' || value === 'gemini';
}

export function normalizeCommandProfileType(value: unknown): CommandProfileType | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  return isCommandProfileType(normalized) ? normalized : null;
}

export function detectCommandTypeFromCommand(commandTemplate: string | null | undefined): CommandProfileType | null {
  const normalized = (commandTemplate || '').trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.startsWith('cld') || normalized.startsWith('claude') || normalized.startsWith('ccr')) {
    return 'claude';
  }

  if (normalized === 'cx' || normalized.startsWith('cx ') || normalized.startsWith('codex')) {
    return 'codex';
  }

  if (normalized.startsWith('gemini')) {
    return 'gemini';
  }

  return null;
}

export function resolveCommandType(
  explicitType: unknown,
  commandTemplate: string | null | undefined
): CommandProfileType | null {
  return normalizeCommandProfileType(explicitType) || detectCommandTypeFromCommand(commandTemplate);
}

function hasExplicitModelFlag(commandTemplate: string): boolean {
  return /(^|\s)--model(?:\s|=)/.test(commandTemplate);
}

export function buildControllerCommandConfig(input: {
  commandTemplate?: string | null;
  commandType?: unknown;
  fallbackCommandTemplate?: string | null;
  fallbackCommandType?: unknown;
}): { commandTemplate: string; commandType: CommandProfileType | null } {
  const baseCommandTemplate = String(input.commandTemplate || '').trim()
    || String(input.fallbackCommandTemplate || '').trim()
    || config.defaultCommandTemplate;
  const explicitType = input.commandType !== undefined ? input.commandType : input.fallbackCommandType;
  const commandType = resolveCommandType(explicitType, baseCommandTemplate);

  if (commandType === 'claude' && !hasExplicitModelFlag(baseCommandTemplate)) {
    return {
      commandTemplate: `${baseCommandTemplate} --model claude-sonnet-4-6`,
      commandType,
    };
  }

  return {
    commandTemplate: baseCommandTemplate,
    commandType,
  };
}

export function resolveEffectiveAgentCommandConfig(
  agent: Pick<Agent, 'command_template' | 'command_type'>,
  project: Pick<Project, 'command_template' | 'command_type'>
): { commandTemplate: string; commandType: CommandProfileType | null } {
  const agentCommandTemplate = String(agent.command_template || '').trim();
  const projectCommandTemplate = String(project.command_template || '').trim();
  const commandTemplate = agentCommandTemplate || projectCommandTemplate || config.defaultCommandTemplate;
  const explicitType = agentCommandTemplate
    ? agent.command_type
    : (agent.command_type || project.command_type);

  return {
    commandTemplate,
    commandType: resolveCommandType(explicitType, commandTemplate),
  };
}
