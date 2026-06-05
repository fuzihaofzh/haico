import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../../db/database';
import { Agent, CommandProfile, CommandProfileType, CreateAgentInput, Project } from '../../types';
import { validateParentAgentAssignment } from './hierarchy';
import { resolveCommandType } from '../command-profiles';
import { getAdapterRegistry } from '../adapters';
import { expandHomePath } from '../file-management';
import { getGitStatus, getGitLog } from '../git';
import logger from '../../logger';
import {
  AgentCommandProfileNotFoundError,
  AgentInvalidParentAssignmentError,
  AgentNameRequiredError,
  AgentNotFoundError,
  AgentProjectNotFoundError,
} from './errors';
import { UpdateAgentInput } from './types';
import { ensureProjectDefaultExecutorProfile } from '../executors/profiles';
import { handleTaskRunExit } from '../tasks/completion';
import { deriveAgentRuntimeState } from '../tasks/runtime-state';
import { eventBus } from '../../events';

function parseCoalescedInt(value: unknown, fallback: number, min: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Math.max(min, Number.isNaN(parsed) ? fallback : parsed);
}

export function getAgentOrThrow(db: Database.Database, agentId: string): Agent {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
  if (!agent) throw new AgentNotFoundError();
  return agent;
}

export function getProjectOrThrow(db: Database.Database, projectId: string, message = 'Project not found'): Project {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) throw new AgentProjectNotFoundError(message);
  return project;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function resolveCommandProfile(db: Database.Database, profileId: string | null | undefined): CommandProfile | null {
  const normalized = String(profileId || '').trim();
  if (!normalized) return null;
  const profile = db.prepare('SELECT * FROM command_profiles WHERE id = ?').get(normalized) as CommandProfile | undefined;
  if (!profile) throw new AgentCommandProfileNotFoundError();
  return profile;
}

function serializeAgent(db: Database.Database, agent: Agent): any {
  const runtimeState = deriveAgentRuntimeState(db, agent);
  return {
    ...agent,
    status: runtimeState.status === 'paused' ? 'idle' : runtimeState.status,
    pid: null,
    started_at: null,
    finished_at: null,
    runtime_state: runtimeState,
    active_task_id: runtimeState.active_task_id,
    active_task_run_id: runtimeState.active_task_run_id,
  };
}

export function listProjectAgents(projectId: string): any[] {
  const db = getDatabase();
  const agents = db.prepare(`
    SELECT
      id,
      project_id,
      name,
      role,
      is_controller,
      parent_agent_id,
      working_directory,
      custom_instructions,
      constraints_json,
      context_json,
      capabilities_json,
      executor_preferences_json,
      new_session_per_run,
      session_run_count,
      session_max_runs,
      session_token_count,
      session_max_tokens,
      session_resume_timeout,
      command_profile_id,
      command_template,
      command_type,
      status,
      paused,
      pid,
      started_at,
      finished_at,
      created_at,
      (last_prompt IS NOT NULL AND last_prompt != '') as has_last_prompt
    FROM agents
    WHERE project_id = ?
    ORDER BY is_controller DESC, created_at
  `).all(projectId) as Agent[];
  return agents.map((agent) => serializeAgent(db, agent));
}

export function createAgent(projectId: string, input: CreateAgentInput): Agent {
  const body = (input || {}) as CreateAgentInput;
  const { name, role, is_controller, session_id, working_directory, command_profile_id, command_template, command_type, parent_agent_id } = body;
  if (!name) throw new AgentNameRequiredError();

  const db = getDatabase();
  const project = getProjectOrThrow(db, projectId);
  const commandProfile = resolveCommandProfile(db, command_profile_id);
  const inheritedProjectCommandProfile = commandProfile ? null : resolveCommandProfile(db, project.command_profile_id);
  const finalCommandProfileId = commandProfile?.id || null;

  const hasExplicitParent = Object.prototype.hasOwnProperty.call(body, 'parent_agent_id');
  let resolvedParentAgentId = parent_agent_id;
  if (!is_controller && !hasExplicitParent) {
    const controllerAgent = db.prepare(
      `SELECT id
       FROM agents
       WHERE project_id = ? AND is_controller = 1
       ORDER BY created_at
       LIMIT 1`
    ).get(projectId) as { id: string } | undefined;
    resolvedParentAgentId = controllerAgent?.id || null;
  }

  const parentValidation = validateParentAgentAssignment(db, projectId, resolvedParentAgentId);
  if (parentValidation.error) {
    throw new AgentInvalidParentAssignmentError(parentValidation.error);
  }

  const id = uuidv4();
  let finalCommandTemplate = commandProfile?.command || (typeof command_template === 'string' ? command_template.trim() || null : null);
  let finalCommandType = commandProfile
    ? resolveCommandType(commandProfile.type, finalCommandTemplate)
    : resolveCommandType(command_type, finalCommandTemplate);
  if (is_controller) {
    // Resolve fallback command template if primary is empty
    if (!finalCommandTemplate) {
      finalCommandTemplate = String(project.command_template || '').trim();
      finalCommandType = resolveCommandType(project.command_type, finalCommandTemplate);
    }
    // Resolve config JSON: prefer profile config, fall back to project profile config
    const configJson = commandProfile?.config_json !== undefined
      ? commandProfile.config_json
      : inheritedProjectCommandProfile?.config_json;
    const adapter = getAdapterRegistry().resolveFromCommand(finalCommandTemplate, finalCommandType);
    finalCommandTemplate = adapter.buildControllerCommand(finalCommandTemplate, configJson);
    // Keep resolved type (claude/codex/gemini/null); adapter.type may be 'shell' which violates DB CHECK
  }

  const defaultExecutorProfile = ensureProjectDefaultExecutorProfile(db, project);
  const constraintsJson = body.constraints_json || safeJson({ paused: false, max_concurrent_tasks: 1 });
  const contextJson = body.context_json || safeJson({
    role: role || '',
    custom_instructions: '',
    collaboration_rules: [],
  });
  const defaultCapabilities = is_controller
    ? ['issue-tracking', 'knowledge-base', 'direct-message', 'agent-management']
    : ['issue-tracking', 'knowledge-base', 'direct-message', 'code-edit', 'issue-assigned'];
  const capabilitiesJson = body.capabilities_json || safeJson(defaultCapabilities);
  const executorPreferencesJson = body.executor_preferences_json || safeJson({
    default_executor_profile_id: defaultExecutorProfile.id,
  });

  db.prepare(`
    INSERT INTO agents (
      id, project_id, name, role, is_controller, parent_agent_id, session_id, working_directory,
      custom_instructions, constraints_json, context_json, capabilities_json, executor_preferences_json,
      command_profile_id, command_template, command_type, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'idle')
  `).run(
    id,
    projectId,
    name,
    role || '',
    is_controller ? 1 : 0,
    parentValidation.parentAgent?.id || null,
    session_id || null,
    working_directory || null,
    constraintsJson,
    contextJson,
    capabilitiesJson,
    executorPreferencesJson,
    finalCommandProfileId,
    finalCommandTemplate,
    finalCommandType
  );

  const createdAgent = getAgentOrThrow(db, id);
  logger.info({
    projectId,
    agentId: createdAgent.id,
    isController: Boolean(createdAgent.is_controller),
    parentAgentId: createdAgent.parent_agent_id,
    commandType: createdAgent.command_type,
  }, 'agent.created');

  eventBus.publish('agent.created', {
    type: 'agent.created',
    projectId,
    payload: { agentId: createdAgent.id, agentName: createdAgent.name, projectId, isController: Boolean(createdAgent.is_controller) },
    meta: { correlationId: createdAgent.id, timestamp: Date.now(), source: 'agents/core.createAgent' },
  });

  return serializeAgent(db, createdAgent);
}

export function getAgent(agentId: string): Agent {
  const db = getDatabase();
  return serializeAgent(db, getAgentOrThrow(db, agentId));
}

export function updateAgent(agentId: string, input: UpdateAgentInput): Agent {
  const db = getDatabase();
  const existing = getAgentOrThrow(db, agentId);
  const body = (input || {}) as UpdateAgentInput;
  const {
    name,
    role,
    session_id,
    working_directory,
    custom_instructions,
    session_max_runs,
    session_max_tokens,
    session_resume_timeout,
    command_profile_id,
    command_template,
    command_type,
    parent_agent_id,
    paused,
    constraints_json,
    context_json,
    capabilities_json,
    executor_preferences_json,
  } = body;

  let validatedParentId: string | null | undefined;
  if (parent_agent_id !== undefined) {
    const parentValidation = validateParentAgentAssignment(db, existing.project_id, parent_agent_id, existing.id);
    if (parentValidation.error) {
      throw new AgentInvalidParentAssignmentError(parentValidation.error);
    }
    validatedParentId = parentValidation.parentAgent?.id || null;
  }

  const fields: string[] = [
    'name = COALESCE(?, name)',
    'role = COALESCE(?, role)',
    'session_id = COALESCE(?, session_id)',
    'working_directory = COALESCE(?, working_directory)',
    'session_max_runs = COALESCE(?, session_max_runs)',
    'session_max_tokens = COALESCE(?, session_max_tokens)',
    'session_resume_timeout = COALESCE(?, session_resume_timeout)',
  ];
  const params: any[] = [
    name ?? null,
    role ?? null,
    session_id ?? null,
    working_directory ?? null,
    session_max_runs !== undefined ? parseCoalescedInt(session_max_runs, 10, 1) : null,
    session_max_tokens !== undefined ? parseCoalescedInt(session_max_tokens, 0, 0) : null,
    session_resume_timeout !== undefined ? parseCoalescedInt(session_resume_timeout, 300, 0) : null,
  ];

  const hasCommandTemplate = Object.prototype.hasOwnProperty.call(body, 'command_template');
  const hasCommandType = Object.prototype.hasOwnProperty.call(body, 'command_type');
  const hasCommandProfileId = Object.prototype.hasOwnProperty.call(body, 'command_profile_id');
  const nextCommandProfile = hasCommandProfileId
    ? resolveCommandProfile(db, command_profile_id)
    : null;
  const inheritedProjectCommandProfile = nextCommandProfile ? null : resolveCommandProfile(db, getProjectOrThrow(db, existing.project_id).command_profile_id);
  const nextCommandProfileId = hasCommandProfileId
    ? nextCommandProfile?.id || null
    : existing.command_profile_id || null;
  let nextCommandTemplate = nextCommandProfile
    ? nextCommandProfile.command
    : hasCommandTemplate
    ? (typeof command_template === 'string' ? command_template.trim() || null : null)
    : existing.command_template;
  let nextCommandType = nextCommandProfile
    ? resolveCommandType(nextCommandProfile.type, nextCommandTemplate)
    : hasCommandType
    ? resolveCommandType(command_type, nextCommandTemplate)
    : hasCommandTemplate
      ? resolveCommandType(null, nextCommandTemplate)
      : existing.command_type;

  if (existing.is_controller && (hasCommandProfileId || hasCommandTemplate) && nextCommandTemplate) {
    const configJson = nextCommandProfile?.config_json !== undefined
      ? nextCommandProfile.config_json
      : inheritedProjectCommandProfile?.config_json;
    const adapter = getAdapterRegistry().resolveFromCommand(nextCommandTemplate, nextCommandType);
    nextCommandTemplate = adapter.buildControllerCommand(nextCommandTemplate, configJson);
    // Keep resolved type; adapter.type may be 'shell' which violates DB CHECK
  }

  if (hasCommandProfileId) {
    fields.push('command_profile_id = ?');
    params.push(nextCommandProfileId);
  }

  if (hasCommandProfileId || hasCommandTemplate) {
    fields.push('command_template = ?');
    params.push(nextCommandTemplate);
  }

  if (hasCommandProfileId || hasCommandType || hasCommandTemplate) {
    fields.push('command_type = ?');
    params.push(nextCommandType);
  }

  if (custom_instructions !== undefined) {
    fields.push('custom_instructions = ?');
    params.push(custom_instructions || null);
  }
  if (constraints_json !== undefined) {
    fields.push('constraints_json = ?');
    params.push(constraints_json || '{}');
  }
  if (context_json !== undefined) {
    fields.push('context_json = ?');
    params.push(context_json || '{}');
  }
  if (capabilities_json !== undefined) {
    fields.push('capabilities_json = ?');
    params.push(capabilities_json || '{}');
  }
  if (executor_preferences_json !== undefined) {
    fields.push('executor_preferences_json = ?');
    params.push(executor_preferences_json || '{}');
  }

  if (validatedParentId !== undefined) {
    fields.push('parent_agent_id = ?');
    params.push(validatedParentId);
  }

  if (paused !== undefined) {
    fields.push('paused = ?');
    params.push(paused ? 1 : 0);
  }

  params.push(agentId);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  return serializeAgent(db, getAgentOrThrow(db, agentId));
}

export function deleteAgent(agentId: string): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  const activeBeforeDelete = deriveAgentRuntimeState(db, agent).active_task_run_id;
  if (activeBeforeDelete) {
    handleTaskRunExit({
      taskRunId: activeBeforeDelete,
      status: 'cancelled',
      exitCode: null,
      failureKind: 'agent_deleted',
      failureMessage: 'Agent deleted',
    });
  }

  db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);

  eventBus.publish('agent.deleted', {
    type: 'agent.deleted',
    projectId: agent.project_id,
    payload: { agentId: agent.id, agentName: agent.name, hadActiveTask: !!activeBeforeDelete },
    meta: { correlationId: agent.id, timestamp: Date.now(), source: 'agents/core.deleteAgent' },
  });

  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    activeTaskRunId: activeBeforeDelete,
  }, 'agent.deleted');
  return { success: true };
}

export function getAgentGitStatus(agentId: string): any {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  const dir = agent.working_directory ? expandHomePath(agent.working_directory) : null;
  if (!dir) return { branch: null, recent_commits: [], has_uncommitted: false, diff_stat: '' };

  const status = getGitStatus(dir);
  const log = getGitLog(dir, 5);

  return {
    branch: status.branch,
    recent_commits: log.map((entry) => ({
      hash: entry.shortHash,
      message: entry.message,
      date: entry.date,
    })),
    has_uncommitted: status.hasUncommitted,
    diff_stat: status.diffStat,
    uncommitted_files: status.uncommittedFiles,
  };
}
