import Database from 'better-sqlite3';
import { config } from '../../config';
import { Agent, Project } from '../../types';
import {
  CommandProfileNotFoundError,
  InvalidCommandProfileConfigJsonError,
  InvalidCommandProfileTypeError,
  MissingCommandProfileCommandError,
  MissingCommandProfileNameError,
} from './errors';

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

export function normalizeProfileName(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeProfileCommand(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeScenario(value: unknown): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeConfigJsonForStorage(value: unknown): string {
  if (value === undefined || value === null || value === '') return '{}';
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new InvalidCommandProfileConfigJsonError();
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidCommandProfileConfigJsonError();
  }
  return JSON.stringify(parsed);
}

export function serializeCommandProfile(row: any): any {
  if (!row) return row;
  let configJson: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      configJson = parsed;
    }
  } catch {
    configJson = {};
  }
  return {
    ...row,
    scenario: row.scenario || null,
    config_json: configJson,
  };
}

const COMMAND_PROFILE_FIELDS = 'id, name, command, type, scenario, config_json, created_at, updated_at';

export function listCommandProfiles(db: Database.Database): any[] {
  const profiles = db.prepare(
    `SELECT ${COMMAND_PROFILE_FIELDS}
     FROM command_profiles
     ORDER BY lower(name), created_at`
  ).all();
  return profiles.map(serializeCommandProfile);
}

export interface CreateCommandProfileInput {
  name?: unknown;
  command?: unknown;
  type?: unknown;
  scenario?: unknown;
  config_json?: unknown;
}

export function createCommandProfile(db: Database.Database, input: CreateCommandProfileInput): any {
  const name = normalizeProfileName(input.name);
  const command = normalizeProfileCommand(input.command);
  const type = resolveCommandType(input.type, command);
  const scenario = normalizeScenario(input.scenario);
  const configJson = normalizeConfigJsonForStorage(input.config_json);

  if (!name) throw new MissingCommandProfileNameError();
  if (!command) throw new MissingCommandProfileCommandError();
  if (!type) throw new InvalidCommandProfileTypeError();

  const result = db.prepare(
    `INSERT INTO command_profiles (name, command, type, scenario, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(name, command, type, scenario, configJson);

  return serializeCommandProfile(
    db.prepare(`SELECT ${COMMAND_PROFILE_FIELDS} FROM command_profiles WHERE rowid = ?`)
      .get(result.lastInsertRowid)
  );
}

export interface UpdateCommandProfileInput {
  name?: unknown;
  command?: unknown;
  type?: unknown;
  scenario?: unknown;
  config_json?: unknown;
}

export function updateCommandProfile(db: Database.Database, id: string, input: UpdateCommandProfileInput): any {
  const existing = db.prepare(`SELECT ${COMMAND_PROFILE_FIELDS} FROM command_profiles WHERE id = ?`)
    .get(id) as Record<string, any> | undefined;
  if (!existing) throw new CommandProfileNotFoundError();

  const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
  const hasCommand = Object.prototype.hasOwnProperty.call(input, 'command');
  const hasType = Object.prototype.hasOwnProperty.call(input, 'type');
  const hasScenario = Object.prototype.hasOwnProperty.call(input, 'scenario');
  const hasConfigJson = Object.prototype.hasOwnProperty.call(input, 'config_json');

  const name = hasName ? normalizeProfileName(input.name) : existing.name;
  const command = hasCommand ? normalizeProfileCommand(input.command) : existing.command;
  const type = hasType || hasCommand
    ? resolveCommandType(hasType ? input.type : existing.type, command)
    : normalizeCommandProfileType(existing.type);
  const scenario = hasScenario ? normalizeScenario(input.scenario) : existing.scenario;
  const configJson = hasConfigJson
    ? normalizeConfigJsonForStorage(input.config_json)
    : (existing.config_json || '{}');

  if (!name) throw new MissingCommandProfileNameError();
  if (!command) throw new MissingCommandProfileCommandError();
  if (!type) throw new InvalidCommandProfileTypeError();

  db.prepare(
    `UPDATE command_profiles
     SET name = ?, command = ?, type = ?, scenario = ?, config_json = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(name, command, type, scenario, configJson, id);

  return serializeCommandProfile(
    db.prepare(`SELECT ${COMMAND_PROFILE_FIELDS} FROM command_profiles WHERE id = ?`).get(id)
  );
}

export function deleteCommandProfile(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM command_profiles WHERE id = ?').run(id);
  if (result.changes === 0) throw new CommandProfileNotFoundError();
}
