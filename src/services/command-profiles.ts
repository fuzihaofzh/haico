import { config } from '../config';
import { Agent, Project } from '../types';

export const COMMAND_PROFILE_TYPES = ['claude', 'codex', 'gemini'] as const;

export type CommandProfileType = (typeof COMMAND_PROFILE_TYPES)[number];
export type CommandProfileConfig = Record<string, unknown>;

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

export function normalizeCommandProfileConfig(value: unknown): CommandProfileConfig {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as CommandProfileConfig : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CommandProfileConfig : {};
}

export function isEmptyCommandProfileConfig(value: unknown): boolean {
  return Object.keys(normalizeCommandProfileConfig(value)).length === 0;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return null;
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function hasCommandFlag(commandTemplate: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?:\\s|=|$)`).test(commandTemplate);
}

export function appendClaudeConfigArgs(commandTemplate: string, configValue: unknown): string {
  const config = normalizeCommandProfileConfig(configValue);
  if (Object.keys(config).length === 0) return commandTemplate;

  const parts = [commandTemplate];
  const model = stringValue(config.model);
  if (model && !hasCommandFlag(commandTemplate, '--model')) {
    parts.push('--model', shellQuote(model));
  }

  const verbose = booleanValue(config.verbose);
  if (verbose === true && !hasCommandFlag(commandTemplate, '--verbose')) {
    parts.push('--verbose');
  }

  const allowedTools = stringListValue(config.allowedTools);
  if (allowedTools.length > 0 && !hasCommandFlag(commandTemplate, '--allowedTools')) {
    parts.push('--allowedTools', shellQuote(allowedTools.join(' ')));
  }

  return parts.join(' ');
}

export function appendCodexConfigArgs(commandTemplate: string, configValue: unknown): string {
  const config = normalizeCommandProfileConfig(configValue);
  if (Object.keys(config).length === 0) return commandTemplate;

  const parts = [commandTemplate];
  const sandbox = stringValue(config.sandbox);
  if (sandbox && !hasCommandFlag(commandTemplate, '--sandbox')) {
    parts.push('--sandbox', shellQuote(sandbox));
  }

  if (booleanValue(config.bypassApprovals) === true && !hasCommandFlag(commandTemplate, '--dangerously-bypass-approvals-and-sandbox')) {
    parts.push('--dangerously-bypass-approvals-and-sandbox');
  }

  if (booleanValue(config.skipGitRepoCheck) === true && !hasCommandFlag(commandTemplate, '--skip-git-repo-check')) {
    parts.push('--skip-git-repo-check');
  }

  return parts.join(' ');
}

export function appendGeminiConfigArgs(commandTemplate: string, configValue: unknown): string {
  const config = normalizeCommandProfileConfig(configValue);
  if (Object.keys(config).length === 0) return commandTemplate;

  const parts = [commandTemplate];
  const outputFormat = stringValue(config.outputFormat);
  if (outputFormat && !hasCommandFlag(commandTemplate, '--output-format')) {
    parts.push('--output-format', shellQuote(outputFormat));
  }

  if (booleanValue(config.sandbox) === true && !hasCommandFlag(commandTemplate, '--sandbox')) {
    parts.push('--sandbox');
  }

  const approvalMode = stringValue(config.approvalMode);
  if (approvalMode && !hasCommandFlag(commandTemplate, '--approval-mode')) {
    parts.push('--approval-mode', shellQuote(approvalMode));
  }

  return parts.join(' ');
}

export function buildControllerCommandConfig(input: {
  commandTemplate?: string | null;
  commandType?: unknown;
  commandProfileConfigJson?: string | Record<string, unknown> | null;
  fallbackCommandTemplate?: string | null;
  fallbackCommandType?: unknown;
  fallbackCommandProfileConfigJson?: string | Record<string, unknown> | null;
}): { commandTemplate: string; commandType: CommandProfileType | null } {
  const baseCommandTemplate = String(input.commandTemplate || '').trim()
    || String(input.fallbackCommandTemplate || '').trim()
    || config.defaultCommandTemplate;
  const explicitType = input.commandType !== undefined ? input.commandType : input.fallbackCommandType;
  const commandType = resolveCommandType(explicitType, baseCommandTemplate);
  const configValue = input.commandProfileConfigJson !== undefined
    ? input.commandProfileConfigJson
    : input.fallbackCommandProfileConfigJson;

  if (commandType === 'claude' && isEmptyCommandProfileConfig(configValue) && !hasCommandFlag(baseCommandTemplate, '--model')) {
    return {
      commandTemplate: `${baseCommandTemplate} --model claude-sonnet-4-6`,
      commandType,
    };
  }

  if (commandType === 'claude') {
    return {
      commandTemplate: appendClaudeConfigArgs(baseCommandTemplate, configValue),
      commandType,
    };
  }

  if (commandType === 'codex') {
    return {
      commandTemplate: appendCodexConfigArgs(baseCommandTemplate, configValue),
      commandType,
    };
  }

  if (commandType === 'gemini') {
    return {
      commandTemplate: appendGeminiConfigArgs(baseCommandTemplate, configValue),
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
