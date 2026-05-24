import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../../db/database';
import { Agent, CreateAgentInput, Project } from '../../types';
import { ensureAgentKnowledgeEntry } from '../knowledge/agent-memory';
import { validateParentAgentAssignment } from './hierarchy';
import { buildControllerCommandConfig, resolveCommandType } from '../command-profiles';
import logger from '../../logger';
import { AgentInvalidParentAssignmentError, AgentNameRequiredError, AgentNotFoundError, AgentProjectNotFoundError } from './errors';
import { UpdateAgentInput } from './types';
import { ensureProjectDefaultExecutorProfile } from '../executors/profiles';
import { stopCliTaskRun } from '../executors/cli-executor';
import { completeTaskRun } from '../tasks/completion';
import { deriveAgentRuntimeState } from '../tasks/runtime-state';

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
  const { name, role, is_controller, session_id, working_directory, command_template, command_type, parent_agent_id } = body;
  if (!name) throw new AgentNameRequiredError();

  const db = getDatabase();
  const project = getProjectOrThrow(db, projectId);

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
  let finalCommandTemplate = typeof command_template === 'string' ? command_template.trim() || null : null;
  let finalCommandType = resolveCommandType(command_type, finalCommandTemplate);
  if (is_controller) {
    const controllerCommandConfig = buildControllerCommandConfig({
      commandTemplate: finalCommandTemplate,
      commandType: command_type,
      fallbackCommandTemplate: project.command_template,
      fallbackCommandType: project.command_type,
    });
    finalCommandTemplate = controllerCommandConfig.commandTemplate;
    finalCommandType = controllerCommandConfig.commandType;
  }

  const defaultExecutorProfile = ensureProjectDefaultExecutorProfile(db, project);
  const constraintsJson = body.constraints_json || safeJson({ paused: false, max_concurrent_tasks: 1 });
  const contextJson = body.context_json || safeJson({
    role: role || '',
    custom_instructions: '',
    collaboration_rules: [],
  });
  const capabilitiesJson = body.capabilities_json || safeJson([]);
  const executorPreferencesJson = body.executor_preferences_json || safeJson({
    default_executor_profile_id: defaultExecutorProfile.id,
  });

  db.prepare(`
    INSERT INTO agents (
      id, project_id, name, role, is_controller, parent_agent_id, session_id, working_directory,
      custom_instructions, constraints_json, context_json, capabilities_json, executor_preferences_json,
      command_template, command_type, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'idle')
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
    finalCommandTemplate,
    finalCommandType
  );

  const createdAgent = getAgentOrThrow(db, id);
  ensureAgentKnowledgeEntry(db, createdAgent);
  logger.info({
    projectId,
    agentId: createdAgent.id,
    isController: Boolean(createdAgent.is_controller),
    parentAgentId: createdAgent.parent_agent_id,
    commandType: createdAgent.command_type,
  }, 'agent.created');
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
  let nextCommandTemplate = hasCommandTemplate
    ? (typeof command_template === 'string' ? command_template.trim() || null : null)
    : existing.command_template;
  let nextCommandType = hasCommandType
    ? resolveCommandType(command_type, nextCommandTemplate)
    : hasCommandTemplate
      ? resolveCommandType(null, nextCommandTemplate)
      : existing.command_type;

  if (existing.is_controller && hasCommandTemplate && nextCommandTemplate) {
    const controllerCommandConfig = buildControllerCommandConfig({
      commandTemplate: nextCommandTemplate,
      commandType: hasCommandType ? command_type : undefined,
    });
    nextCommandTemplate = controllerCommandConfig.commandTemplate;
    nextCommandType = controllerCommandConfig.commandType;
  }

  if (hasCommandTemplate) {
    fields.push('command_template = ?');
    params.push(nextCommandTemplate);
  }

  if (hasCommandType || hasCommandTemplate) {
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
    stopCliTaskRun(activeBeforeDelete);
    completeTaskRun({
      taskRunId: activeBeforeDelete,
      status: 'cancelled',
      exitCode: null,
      failureKind: 'agent_deleted',
      failureMessage: 'Agent deleted',
    });
  }

  db.prepare('UPDATE issues SET assigned_to = NULL WHERE assigned_to = ?').run(agentId);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    activeTaskRunId: activeBeforeDelete,
  }, 'agent.deleted');
  return { success: true };
}
