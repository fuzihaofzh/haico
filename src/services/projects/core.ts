import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { Agent, CommandProfile, CreateProjectInput, OrchestratorEngine, Project } from '../../types';
import { buildControllerCommandConfig, resolveCommandType } from '../command-profiles';
import { getProjectPermission, listAccessibleProjects, ProjectPermission, ProjectRequestContext } from '../project-access';
import logger, { AppLogger } from '../../logger';
import {
  InvalidProjectOrchestratorEngineError,
  MissingProjectTaskDescriptionError,
  ProjectDeleteBlockedError,
  ProjectDeleteForbiddenError,
  ProjectCommandProfileNotFoundError,
  ProjectNotFoundError,
} from './errors';
import { buildSqlPlaceholders } from './utils';
import { ensureProjectDefaultExecutorProfile, syncProjectDefaultExecutorProfile } from '../executors/profiles';
import { cancelActiveTaskForAgent, summarizeAgentRuntimeStates } from '../tasks';
import { eventBus } from '../../events';

export interface ProjectOwnerSummary {
  id: string;
  username: string;
  display_name: string;
  role: string;
}

export interface SerializedProject extends Project {
  permission_level: string;
  can_manage: boolean;
  owner: ProjectOwnerSummary | null;
  member_count: number;
  stats?: {
    agents: number;
    running: number;
    agentError: number;
    issues: number;
    openIssues: number;
    userIssues: any[];
    controllerAgentId: string | null;
  };
}

export interface ProjectServiceLogger {
  error: AppLogger['error'];
}

export function normalizeOrchestratorEngine(value: unknown): OrchestratorEngine | null {
  if (value === undefined) return null;
  const engine = String(value).toLowerCase();
  if (engine === 'native' || engine === 'langgraph') return engine as OrchestratorEngine;
  return null;
}

export function assertProjectTaskDescription(input: Pick<CreateProjectInput, 'task_description'> | null | undefined): void {
  if (!input?.task_description) {
    throw new MissingProjectTaskDescriptionError();
  }
}

function getProjectOwnerSummary(db: Database.Database, projectId: string): ProjectOwnerSummary | null {
  return db.prepare(
    `SELECT u.id, u.username, u.display_name, u.role
     FROM projects p
     LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.id = ?`
  ).get(projectId) as ProjectOwnerSummary | null;
}

function getProjectMemberCount(db: Database.Database, projectId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count
     FROM (
       SELECT owner_id as user_id
       FROM projects
       WHERE id = ? AND owner_id IS NOT NULL
       UNION
       SELECT user_id
       FROM project_members
       WHERE project_id = ?
     ) members`
  ).get(projectId, projectId) as { count: number } | undefined;
  return row?.count || 0;
}

function resolveCommandProfile(db: Database.Database, profileId: string | null | undefined): CommandProfile | null {
  const normalized = String(profileId || '').trim();
  if (!normalized) return null;
  const profile = db.prepare('SELECT * FROM command_profiles WHERE id = ?').get(normalized) as CommandProfile | undefined;
  if (!profile) throw new ProjectCommandProfileNotFoundError();
  return profile;
}

export function serializeProject(
  db: Database.Database,
  project: Project,
  context: ProjectRequestContext
): SerializedProject {
  const permission = getProjectPermission(db, project.id, context.user);
  return serializeProjectWithPermission(db, project, permission);
}

function serializeProjectWithPermission(
  db: Database.Database,
  project: Project,
  permission: ProjectPermission
): SerializedProject {
  return {
    ...project,
    permission_level: permission.level,
    can_manage: permission.canManage,
    owner: getProjectOwnerSummary(db, project.id),
    member_count: getProjectMemberCount(db, project.id),
  };
}

export function listProjects(
  db: Database.Database,
  context: ProjectRequestContext,
  options: { withStats?: boolean } = {}
): SerializedProject[] {
  const projects = listAccessibleProjects(db, context.user).map((project) =>
    serializeProject(db, project, context)
  );

  if (!options.withStats || projects.length === 0) return projects;
  return attachProjectStats(db, projects);
}

function attachProjectStats(db: Database.Database, projects: SerializedProject[]): SerializedProject[] {
  const projectIds = projects.map((project) => project.id);
  const placeholders = buildSqlPlaceholders(projectIds);

  const agentRows = db.prepare(
    `SELECT project_id, id, paused, constraints_json
     FROM agents
     WHERE project_id IN (${placeholders})`
  ).all(...projectIds) as Array<{
    project_id: string;
    id: string;
    paused: number | boolean | null;
    constraints_json?: string | null;
  }>;
  const agentRowsByProject = new Map<string, typeof agentRows>();
  for (const row of agentRows) {
    const rows = agentRowsByProject.get(row.project_id) || [];
    rows.push(row);
    agentRowsByProject.set(row.project_id, rows);
  }

  const issueRows = db.prepare(
    `SELECT project_id, COUNT(*) as total,
            SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) as open_count
     FROM issues WHERE project_id IN (${placeholders}) GROUP BY project_id`
  ).all(...projectIds) as any[];
  const issueMap = new Map(issueRows.map((row) => [row.project_id, row]));

  const userIssueRows = db.prepare(
    `SELECT project_id, number, title, priority FROM issues
     WHERE project_id IN (${placeholders}) AND assigned_to = 'user' AND status IN ('open','in_progress')
     ORDER BY priority DESC`
  ).all(...projectIds) as any[];
  const userIssueMap = new Map<string, any[]>();
  for (const row of userIssueRows) {
    const existing = userIssueMap.get(row.project_id);
    if (existing) {
      if (existing.length < 10) existing.push(row);
    } else {
      userIssueMap.set(row.project_id, [row]);
    }
  }

  const controllerRows = db.prepare(
    `SELECT project_id, id FROM agents WHERE project_id IN (${placeholders}) AND is_controller = 1`
  ).all(...projectIds) as any[];
  const controllerMap = new Map(controllerRows.map((row) => [row.project_id, row.id]));

  return projects.map((project) => {
    const agentStats = summarizeAgentRuntimeStates(db, agentRowsByProject.get(project.id) || []);
    const issueStats = issueMap.get(project.id);
    return {
      ...project,
      stats: {
        agents: agentStats?.total || 0,
        running: agentStats?.running || 0,
        agentError: agentStats?.error_count || 0,
        issues: issueStats?.total || 0,
        openIssues: issueStats?.open_count || 0,
        userIssues: userIssueMap.get(project.id) || [],
        controllerAgentId: controllerMap.get(project.id) || null,
      },
    };
  });
}

export function getProject(db: Database.Database, projectId: string, permission: ProjectPermission): SerializedProject {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) throw new ProjectNotFoundError();
  return serializeProjectWithPermission(db, project, permission);
}

export function createProject(
  db: Database.Database,
  input: CreateProjectInput,
  context: ProjectRequestContext
): SerializedProject {
  assertProjectTaskDescription(input);

  const orchestratorEngine = normalizeOrchestratorEngine(input.orchestrator_engine);
  if (input.orchestrator_engine !== undefined && orchestratorEngine === null) {
    throw new InvalidProjectOrchestratorEngineError();
  }

  const result = db.transaction(() => {
    const id = uuidv4();
    const commandProfile = resolveCommandProfile(db, input.command_profile_id);
    const commandProfileId = commandProfile?.id || null;
    const tmpl = commandProfile?.command || input.command_template || config.defaultCommandTemplate;
    const resolvedCommandType = commandProfile
      ? resolveCommandType(commandProfile.type, tmpl)
      : resolveCommandType(input.command_type, tmpl);
    const resolvedEngine = orchestratorEngine || config.defaultOrchestratorEngine;
    const ownerId = context.user ? context.user.id : null;

    db.prepare(`
      INSERT INTO projects (id, name, description, task_description, command_profile_id, command_template, command_type, orchestrator_engine, owner_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id,
      input.name,
      input.description || '',
      input.task_description,
      commandProfileId,
      tmpl,
      resolvedCommandType,
      resolvedEngine,
      ownerId
    );

    const projectForExecutor = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;
    const defaultExecutorProfile = ensureProjectDefaultExecutorProfile(db, projectForExecutor);
    const baseConstraints = JSON.stringify({ paused: false, max_concurrent_tasks: 1 });
    const controllerContext = JSON.stringify({
      role: input.controller_role || 'Main controller agent that manages and coordinates other agents',
      custom_instructions: '',
      collaboration_rules: [],
    });
    const executorPreferences = JSON.stringify({ default_executor_profile_id: defaultExecutorProfile.id });

    if (ownerId) {
      db.prepare(`
        INSERT INTO project_members (id, project_id, user_id, role)
        VALUES (?, ?, ?, 'owner')
        ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'owner'
      `).run(uuidv4(), id, ownerId);
    }

    const controllerId = uuidv4();
    const controllerRole = input.controller_role || 'Main controller agent that manages and coordinates other agents';
    const controllerCommandConfig = buildControllerCommandConfig({
      commandTemplate: tmpl,
      commandType: resolvedCommandType,
      commandProfileConfigJson: commandProfile?.config_json,
    });
    db.prepare(`
      INSERT INTO agents (
        id, project_id, name, role, is_controller, working_directory,
        constraints_json, context_json, capabilities_json, executor_preferences_json,
        command_profile_id, command_template, command_type, status
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')
    `).run(
      controllerId,
      id,
      `${input.name || 'project'}-controller`,
      controllerRole,
      input.working_directory || null,
      baseConstraints,
      controllerContext,
      JSON.stringify(['coordination']),
      executorPreferences,
      commandProfileId,
      controllerCommandConfig.commandTemplate,
      controllerCommandConfig.commandType
    );

    const assistantId = uuidv4();
    const assistantRole = 'Assistant to the controller. Handles analysis, code execution, data processing, and research tasks delegated by the controller.';
    const assistantContext = JSON.stringify({
      role: assistantRole,
      custom_instructions: '',
      collaboration_rules: [],
    });
    db.prepare(`
      INSERT INTO agents (
        id, project_id, name, role, is_controller, parent_agent_id, working_directory,
        constraints_json, context_json, capabilities_json, executor_preferences_json, status
      )
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'idle')
    `).run(
      assistantId,
      id,
      `${input.name || 'project'}-assistant`,
      assistantRole,
      controllerId,
      input.working_directory || null
      ,
      baseConstraints,
      assistantContext,
      JSON.stringify(['analysis', 'research', 'execution']),
      executorPreferences
    );

    return {
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project,
      controllerId,
      assistantId,
      ownerId,
      commandType: resolvedCommandType,
      orchestratorEngine: resolvedEngine,
    };
  })();

  logger.info({
    projectId: result.project.id,
    ownerId: result.ownerId,
    orchestratorEngine: result.orchestratorEngine,
    commandType: result.commandType,
    controllerAgentId: result.controllerId,
    assistantAgentId: result.assistantId,
  }, 'project.created');

  eventBus.publish('agent.created', {
    type: 'agent.created',
    projectId: result.project.id,
    payload: { agentId: result.controllerId, agentName: `${input.name || 'project'}-controller`, projectId: result.project.id, isController: true },
    meta: { correlationId: result.controllerId, timestamp: Date.now(), source: 'projects/core.createProject' },
  });
  eventBus.publish('agent.created', {
    type: 'agent.created',
    projectId: result.project.id,
    payload: { agentId: result.assistantId, agentName: `${input.name || 'project'}-assistant`, projectId: result.project.id, isController: false },
    meta: { correlationId: result.assistantId, timestamp: Date.now(), source: 'projects/core.createProject' },
  });

  return serializeProject(db, result.project, { user: context.user });
}

export interface UpdateProjectInput extends Partial<CreateProjectInput> {
  status?: string;
  color?: string;
}

export function updateProject(
  db: Database.Database,
  projectId: string,
  input: UpdateProjectInput,
  permission: ProjectPermission
): SerializedProject {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!existing) throw new ProjectNotFoundError();

  const hasCommandProfileId = Object.prototype.hasOwnProperty.call(input || {}, 'command_profile_id');
  const nextCommandProfile = hasCommandProfileId
    ? resolveCommandProfile(db, input.command_profile_id)
    : null;
  const hasCommandTemplate = Object.prototype.hasOwnProperty.call(input || {}, 'command_template');
  const hasCommandType = Object.prototype.hasOwnProperty.call(input || {}, 'command_type');
  const nextCommandProfileId = hasCommandProfileId
    ? nextCommandProfile?.id || null
    : existing.command_profile_id || null;
  const nextCommandTemplate = nextCommandProfile
    ? nextCommandProfile.command
    : hasCommandTemplate
    ? (typeof input.command_template === 'string' ? input.command_template.trim() || config.defaultCommandTemplate : config.defaultCommandTemplate)
    : existing.command_template;
  const nextCommandType = nextCommandProfile
    ? resolveCommandType(nextCommandProfile.type, nextCommandTemplate)
    : hasCommandType || hasCommandTemplate
    ? resolveCommandType(hasCommandType ? input.command_type : existing.command_type, nextCommandTemplate)
    : existing.command_type;

  const orchestratorEngine = normalizeOrchestratorEngine(input.orchestrator_engine);
  if (input.orchestrator_engine !== undefined && orchestratorEngine === null) {
    throw new InvalidProjectOrchestratorEngineError();
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (input.status !== undefined && input.status !== existing.status) {
    changes.status = { from: existing.status, to: input.status };
  }
  if (orchestratorEngine !== null && orchestratorEngine !== existing.orchestrator_engine) {
    changes.orchestratorEngine = { from: existing.orchestrator_engine, to: orchestratorEngine };
  }
  if ((hasCommandProfileId || hasCommandType || hasCommandTemplate) && nextCommandType !== existing.command_type) {
    changes.commandType = { from: existing.command_type, to: nextCommandType };
  }
  if (hasCommandProfileId && nextCommandProfileId !== existing.command_profile_id) {
    changes.commandProfileId = { from: existing.command_profile_id, to: nextCommandProfileId };
  }

  db.prepare(`
    UPDATE projects SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      task_description = COALESCE(?, task_description),
      command_profile_id = ?,
      command_template = COALESCE(?, command_template),
      command_type = COALESCE(?, command_type),
      orchestrator_engine = COALESCE(?, orchestrator_engine),
      status = COALESCE(?, status),
      color = COALESCE(?, color),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    input.name ?? null,
    input.description ?? null,
    input.task_description ?? null,
    nextCommandProfileId,
    (hasCommandProfileId || hasCommandTemplate) ? nextCommandTemplate : null,
    (hasCommandProfileId || hasCommandType || hasCommandTemplate) ? nextCommandType : null,
    orchestratorEngine ?? null,
    input.status ?? null,
    input.color ?? null,
    projectId
  );

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project;
  if (hasCommandProfileId || hasCommandTemplate || hasCommandType) {
    syncProjectDefaultExecutorProfile(db, updated, updated.command_template, updated.command_type);
  }
  if (Object.keys(changes).length > 0) {
    logger.info({ projectId, changes }, 'project.updated');
  }
  return serializeProjectWithPermission(db, updated, permission);
}

export function deleteProject(
  db: Database.Database,
  projectId: string,
  permission: ProjectPermission,
  requestLogger?: ProjectServiceLogger
): { success: true } {
  if (permission.level === 'editor') {
    throw new ProjectDeleteForbiddenError();
  }

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!existing) throw new ProjectNotFoundError();

  const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(projectId) as Agent[];
  const stoppedAgentIds: string[] = [];
  for (const agent of agents) {
    cancelActiveTaskForAgent(agent.id);
    stoppedAgentIds.push(agent.id);
  }
  if (stoppedAgentIds.length > 0) {
    logger.warn({ projectId, stoppedAgentIds }, 'project.delete.stopped_agents');
  }

  try {
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  } catch (err) {
    (requestLogger || logger).error({ err, projectId }, 'project.delete.failed');
    const message = err instanceof Error ? err.message : String(err);
    if (/foreign key|constraint|agents_old|issues_old|projects_old/i.test(message)) {
      throw new ProjectDeleteBlockedError();
    }
    throw err;
  }

  eventBus.publish('project.deleted', {
    type: 'project.deleted',
    projectId,
    payload: { agentIds: stoppedAgentIds },
    meta: { correlationId: projectId, timestamp: Date.now(), source: 'projects/core.deleteProject' },
  });

  logger.info({ projectId, agentCount: agents.length, permission: permission.level }, 'project.deleted');
  return { success: true };
}
