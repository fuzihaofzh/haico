import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { Agent, ExecutorProfile, Project } from '../../types';
import { detectCommandTypeFromCommand, resolveCommandType } from '../command-profiles';
import { ExecutorSnapshot } from './types';

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeExecutorType(commandType: ReturnType<typeof resolveCommandType> | null): ExecutorProfile['executor_type'] {
  return commandType || 'shell';
}

export function defaultSessionPolicy(agent?: Partial<Agent>): ExecutorSnapshot['session_policy'] {
  return {
    resume_timeout: Number(agent?.session_resume_timeout ?? 300),
    max_runs: Number(agent?.session_max_runs ?? 10),
    max_tokens: Number(agent?.session_max_tokens ?? 400000),
    new_session_per_run: Boolean((agent as any)?.new_session_per_run),
  };
}

export function ensureProjectDefaultExecutorProfile(
  db: Database.Database,
  project: Project
): ExecutorProfile {
  const existing = db.prepare(
    "SELECT * FROM executor_profiles WHERE project_id = ? AND name = 'Default CLI' ORDER BY created_at LIMIT 1"
  ).get(project.id) as ExecutorProfile | undefined;
  if (existing) return existing;

  const commandTemplate = project.command_template || config.defaultCommandTemplate;
  const commandType = resolveCommandType(project.command_type || detectCommandTypeFromCommand(commandTemplate), commandTemplate);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO executor_profiles (
      id, project_id, name, executor_type, command_template, command_type,
      working_directory, env_json, session_policy_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
  `).run(
    id,
    project.id,
    'Default CLI',
    normalizeExecutorType(commandType),
    commandTemplate,
    commandType,
    null,
    JSON.stringify(defaultSessionPolicy())
  );

  return db.prepare('SELECT * FROM executor_profiles WHERE id = ?').get(id) as ExecutorProfile;
}

export function syncProjectDefaultExecutorProfile(
  db: Database.Database,
  project: Project,
  commandTemplate: string,
  commandType: string | null | undefined
): ExecutorProfile {
  const resolvedCommandType = resolveCommandType(commandType || detectCommandTypeFromCommand(commandTemplate), commandTemplate);
  const existing = db.prepare(
    "SELECT * FROM executor_profiles WHERE project_id = ? AND name = 'Default CLI' ORDER BY created_at LIMIT 1"
  ).get(project.id) as ExecutorProfile | undefined;

  if (!existing) {
    return ensureProjectDefaultExecutorProfile(db, {
      ...project,
      command_template: commandTemplate,
      command_type: resolvedCommandType,
    });
  }

  db.prepare(`
    UPDATE executor_profiles
    SET executor_type = ?, command_template = ?, command_type = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    normalizeExecutorType(resolvedCommandType),
    commandTemplate,
    resolvedCommandType,
    existing.id
  );

  return db.prepare('SELECT * FROM executor_profiles WHERE id = ?').get(existing.id) as ExecutorProfile;
}

export function resolveExecutorProfile(
  db: Database.Database,
  project: Project,
  agent: Agent
): ExecutorProfile {
  const preferences = safeJsonParse<{ default_executor_profile_id?: string | null }>(
    agent.executor_preferences_json,
    {}
  );
  if (preferences.default_executor_profile_id) {
    const preferred = db.prepare(
      'SELECT * FROM executor_profiles WHERE id = ? AND project_id = ?'
    ).get(preferences.default_executor_profile_id, project.id) as ExecutorProfile | undefined;
    if (preferred) return preferred;
  }

  const fallback = ensureProjectDefaultExecutorProfile(db, project);
  db.prepare(
    "UPDATE agents SET executor_preferences_json = json_set(COALESCE(NULLIF(executor_preferences_json, ''), '{}'), '$.default_executor_profile_id', ?) WHERE id = ?"
  ).run(fallback.id, agent.id);
  return fallback;
}

export function snapshotExecutorConfig(profile: ExecutorProfile, agent: Agent): ExecutorSnapshot {
  const sessionPolicy = {
    ...defaultSessionPolicy(agent),
    ...safeJsonParse<Partial<ExecutorSnapshot['session_policy']>>(profile.session_policy_json, {}),
  };

  return {
    id: profile.id,
    name: profile.name,
    executor_type: profile.executor_type,
    command_template: profile.command_template,
    command_type: profile.command_type,
    working_directory: profile.working_directory || agent.working_directory || null,
    env: safeJsonParse<Record<string, string>>(profile.env_json, {}),
    session_policy: {
      resume_timeout: Number(sessionPolicy.resume_timeout ?? 300),
      max_runs: Number(sessionPolicy.max_runs ?? 10),
      max_tokens: Number(sessionPolicy.max_tokens ?? 400000),
      new_session_per_run: Boolean(sessionPolicy.new_session_per_run),
    },
  };
}
