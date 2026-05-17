import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { Agent, CreateProjectInput, OrchestratorEngine, Project } from '../../types';
import { ensureAgentKnowledgeEntry } from '../knowledge/agent-memory';
import { isLegacyAuthUser } from '../auth/request';
import { buildControllerCommandConfig, resolveCommandType } from '../command-profiles';
import { getProjectPermission, listAccessibleProjects, ProjectPermission, ProjectRequestContext } from '../project-permissions';
import { isAgentRunning, stopAgentProcess } from '../process-manager';
import {
  InvalidProjectOrchestratorEngineError,
  MissingProjectTaskDescriptionError,
  ProjectDeleteBlockedError,
  ProjectDeleteForbiddenError,
  ProjectNotFoundError,
} from './errors';
import { buildSqlPlaceholders } from './utils';

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
  error(payload: unknown, message?: string): void;
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

export function serializeProject(
  db: Database.Database,
  project: Project,
  context: ProjectRequestContext
): SerializedProject {
  const permission = getProjectPermission(db, project.id, context.user, context.localhostBypass);
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
  const projects = listAccessibleProjects(db, context.user, context.localhostBypass).map((project) =>
    serializeProject(db, project, context)
  );

  if (!options.withStats || projects.length === 0) return projects;
  return attachProjectStats(db, projects);
}

function attachProjectStats(db: Database.Database, projects: SerializedProject[]): SerializedProject[] {
  const projectIds = projects.map((project) => project.id);
  const placeholders = buildSqlPlaceholders(projectIds);

  const agentRows = db.prepare(
    `SELECT project_id, COUNT(*) as total,
            SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as error_count
     FROM agents WHERE project_id IN (${placeholders}) GROUP BY project_id`
  ).all(...projectIds) as any[];
  const agentMap = new Map(agentRows.map((row) => [row.project_id, row]));

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
    const agentStats = agentMap.get(project.id);
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

export function getProject(db: Database.Database, projectId: string, context: ProjectRequestContext): SerializedProject {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) throw new ProjectNotFoundError();
  return serializeProject(db, project, context);
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

  const createdProject = db.transaction(() => {
    const id = uuidv4();
    const tmpl = input.command_template || config.defaultCommandTemplate;
    const resolvedCommandType = resolveCommandType(input.command_type, tmpl);
    const ownerId = context.user && !isLegacyAuthUser(context.user) ? context.user.id : null;

    db.prepare(`
      INSERT INTO projects (id, name, description, task_description, command_template, command_type, orchestrator_engine, owner_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id,
      input.name,
      input.description || '',
      input.task_description,
      tmpl,
      resolvedCommandType,
      orchestratorEngine || config.defaultOrchestratorEngine,
      ownerId
    );

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
    });
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, working_directory, command_template, command_type, status)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'idle')
    `).run(
      controllerId,
      id,
      `${input.name || 'project'}-controller`,
      controllerRole,
      input.working_directory || null,
      controllerCommandConfig.commandTemplate,
      controllerCommandConfig.commandType
    );
    ensureAgentKnowledgeEntry(db, {
      id: controllerId,
      project_id: id,
      role: controllerRole,
      working_directory: input.working_directory || null,
      custom_instructions: '',
    });

    const assistantId = uuidv4();
    const assistantRole = 'Assistant to the controller. Handles analysis, code execution, data processing, and research tasks delegated by the controller.';
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, working_directory, status)
      VALUES (?, ?, ?, ?, 0, ?, 'idle')
    `).run(
      assistantId,
      id,
      `${input.name || 'project'}-assistant`,
      assistantRole,
      input.working_directory || null
    );
    ensureAgentKnowledgeEntry(db, {
      id: assistantId,
      project_id: id,
      role: assistantRole,
      working_directory: input.working_directory || null,
      custom_instructions: '',
    });

    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;
  })();

  return serializeProject(db, createdProject, { user: context.user, localhostBypass: false });
}

export interface UpdateProjectInput extends Partial<CreateProjectInput> {
  status?: string;
  color?: string;
}

export function updateProject(
  db: Database.Database,
  projectId: string,
  input: UpdateProjectInput,
  context: ProjectRequestContext
): SerializedProject {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!existing) throw new ProjectNotFoundError();

  const hasCommandTemplate = Object.prototype.hasOwnProperty.call(input || {}, 'command_template');
  const hasCommandType = Object.prototype.hasOwnProperty.call(input || {}, 'command_type');
  const nextCommandTemplate = hasCommandTemplate
    ? (typeof input.command_template === 'string' ? input.command_template.trim() || config.defaultCommandTemplate : config.defaultCommandTemplate)
    : existing.command_template;
  const nextCommandType = hasCommandType || hasCommandTemplate
    ? resolveCommandType(hasCommandType ? input.command_type : existing.command_type, nextCommandTemplate)
    : existing.command_type;

  const orchestratorEngine = normalizeOrchestratorEngine(input.orchestrator_engine);
  if (input.orchestrator_engine !== undefined && orchestratorEngine === null) {
    throw new InvalidProjectOrchestratorEngineError();
  }

  db.prepare(`
    UPDATE projects SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      task_description = COALESCE(?, task_description),
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
    hasCommandTemplate ? nextCommandTemplate : null,
    (hasCommandType || hasCommandTemplate) ? nextCommandType : null,
    orchestratorEngine ?? null,
    input.status ?? null,
    input.color ?? null,
    projectId
  );

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project;
  return serializeProject(db, updated, context);
}

export function deleteProject(
  db: Database.Database,
  projectId: string,
  permission: ProjectPermission,
  logger?: ProjectServiceLogger
): { success: true } {
  if (permission.level === 'editor') {
    throw new ProjectDeleteForbiddenError();
  }

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!existing) throw new ProjectNotFoundError();

  const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(projectId) as Agent[];
  for (const agent of agents) {
    if (isAgentRunning(agent.id)) stopAgentProcess(agent.id);
  }

  try {
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  } catch (err) {
    logger?.error({ err, projectId }, 'Failed to delete project');
    const message = err instanceof Error ? err.message : String(err);
    if (/foreign key|constraint|agents_old|issues_old|projects_old/i.test(message)) {
      throw new ProjectDeleteBlockedError();
    }
    throw err;
  }

  return { success: true };
}
