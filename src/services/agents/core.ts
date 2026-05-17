import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../../db/database';
import { Agent, CreateAgentInput, Project } from '../../types';
import { ensureAgentKnowledgeEntry } from '../knowledge/agent-memory';
import { validateParentAgentAssignment } from './hierarchy';
import { buildControllerCommandConfig, resolveCommandType } from '../command-profiles';
import { isAgentRunning, stopAgentProcess } from '../process-manager';
import logger from '../../logger';
import { AgentInvalidParentAssignmentError, AgentNameRequiredError, AgentNotFoundError, AgentProjectNotFoundError } from './errors';
import { UpdateAgentInput } from './types';

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

export function listProjectAgents(projectId: string): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      id,
      project_id,
      name,
      role,
      is_controller,
      parent_agent_id,
      working_directory,
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
  `).all(projectId);
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

  db.prepare(`
    INSERT INTO agents (id, project_id, name, role, is_controller, parent_agent_id, session_id, working_directory, command_template, command_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')
  `).run(
    id,
    projectId,
    name,
    role || '',
    is_controller ? 1 : 0,
    parentValidation.parentAgent?.id || null,
    session_id || null,
    working_directory || null,
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
  return createdAgent;
}

export function getAgent(agentId: string): Agent {
  return getAgentOrThrow(getDatabase(), agentId);
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

  return getAgentOrThrow(db, agentId);
}

export function deleteAgent(agentId: string): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  const wasRunning = isAgentRunning(agent.id);
  if (wasRunning) {
    stopAgentProcess(agent.id);
  }

  db.prepare('UPDATE issues SET assigned_to = NULL WHERE assigned_to = ?').run(agentId);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  logger.info({
    projectId: agent.project_id,
    agentId: agent.id,
    wasRunning,
  }, 'agent.deleted');
  return { success: true };
}
