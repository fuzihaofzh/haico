import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { Agent, CommandProfile, ExecutorProfile, Project } from '../../types';
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

function resolveLatestCommandProfile(
  db: Database.Database,
  agent: Agent,
  project: Project
): CommandProfile | null {
  const profileId = String(agent.command_profile_id || project.command_profile_id || '').trim();
  if (!profileId) return null;
  const profile = db.prepare('SELECT * FROM command_profiles WHERE id = ?').get(profileId) as CommandProfile | undefined;
  return profile || null;
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
    const profileId = preferences.default_executor_profile_id;

    // Check for real executor_profile
    const preferred = db.prepare(
      'SELECT * FROM executor_profiles WHERE id = ? AND project_id = ?'
    ).get(profileId, project.id) as ExecutorProfile | undefined;
    if (preferred) return preferred;

    // Virtual pi-ai profile: auto-materialize
    if (profileId.startsWith('pi-ai-')) {
      const suffix = profileId.slice(6); // strip 'pi-ai-'
      // Find matching provider|model pair by trying all known providers
      const knownProviders = db.prepare('SELECT id FROM pi_providers').all() as { id: string }[];
      for (const prov of knownProviders) {
        if (suffix.startsWith(prov.id + '-')) {
          const providerId = prov.id;
          const modelId = suffix.slice(providerId.length + 1);
          if (modelId) {
            const piModel = db.prepare(`
              SELECT pm.model_id, pm.display_name, pm.max_tokens,
                     pp.name AS provider_name
              FROM pi_models pm
              JOIN pi_providers pp ON pp.id = pm.provider_id
              WHERE pm.provider_id = ? AND pm.model_id = ?
            `).get(providerId, modelId) as any;
            if (piModel) {
              return ensurePiExecutorProfile(db, providerId, modelId, piModel.display_name, null, piModel.max_tokens);
            }
          }
          break;
        }
      }
    }
  }

  const fallback = ensureProjectDefaultExecutorProfile(db, project);
  db.prepare(
    "UPDATE agents SET executor_preferences_json = json_set(COALESCE(NULLIF(executor_preferences_json, ''), '{}'), '$.default_executor_profile_id', ?) WHERE id = ?"
  ).run(fallback.id, agent.id);
  return fallback;
}

export function listProjectExecutorProfiles(db: Database.Database, projectId: string): any[] {
  const realProfiles = db.prepare(
    'SELECT * FROM executor_profiles WHERE project_id = ? ORDER BY created_at'
  ).all(projectId) as ExecutorProfile[];

  // Inject virtual pi-ai executor profiles from pi_models + pi_providers
  // Only skip if a real executor_profile already exists IN THIS PROJECT
  const existingPiConfigs = db.prepare(`
    SELECT pec.provider_id, pec.model_id
    FROM pi_executor_configs pec
    JOIN executor_profiles ep ON ep.id = pec.executor_profile_id
    WHERE ep.project_id = ?
  `).all(projectId) as { provider_id: string; model_id: string }[];
  const existingKey = new Set(existingPiConfigs.map(c => `${c.provider_id}|${c.model_id}`));

  const piModels = db.prepare(`
    SELECT pm.id, pm.provider_id, pm.model_id, pm.display_name, pm.context_window, pm.max_tokens,
           pp.name AS provider_name
    FROM pi_models pm
    JOIN pi_providers pp ON pp.id = pm.provider_id
    ORDER BY pp.name, pm.model_id
  `).all() as any[];

  const virtualProfiles = piModels
    .filter(m => !existingKey.has(`${m.provider_id}|${m.model_id}`))
    .map(m => ({
    id: `pi-ai-${m.provider_id}-${m.model_id}`,
    project_id: projectId,
    name: `${m.provider_name} / ${m.display_name || m.model_id}`,
    executor_type: 'pi-ai',
    command_template: '',
    command_type: null,
    working_directory: null,
    env_json: '{}',
    session_policy_json: '{}',
    executor_preferences_json: null,
    created_at: '',
    updated_at: '',
    // Extra fields for pi-ai config
    _pi_provider_id: m.provider_id,
    _pi_model_id: m.model_id,
    _pi_virtual: true,
  }));

  return [...realProfiles, ...virtualProfiles];
}

export function snapshotExecutorConfig(
  db: Database.Database,
  profile: ExecutorProfile,
  agent: Agent,
  project: Project
): ExecutorSnapshot {
  const sessionPolicy = {
    ...defaultSessionPolicy(agent),
    ...safeJsonParse<Partial<ExecutorSnapshot['session_policy']>>(profile.session_policy_json, {}),
  };
  const latestCommandProfile = resolveLatestCommandProfile(db, agent, project);
  const commandTemplate = latestCommandProfile?.command || profile.command_template;
  const commandType = latestCommandProfile
    ? resolveCommandType(latestCommandProfile.type, commandTemplate)
    : profile.command_type;

  return {
    id: profile.id,
    name: profile.name,
    executor_type: profile.executor_type === 'pi-ai'
      ? 'pi-ai'
      : normalizeExecutorType(commandType),
    command_template: commandTemplate,
    command_type: commandType,
    command_profile_id: latestCommandProfile?.id || null,
    command_profile_name: latestCommandProfile?.name || null,
    command_profile_config_json: latestCommandProfile?.config_json || '{}',
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

/**
 * Auto-create or update an executor_profile for a pi-ai provider|model combination.
 * The profile name = "{provider_name} / {model_name}".
 * Also creates/updates the pi_executor_configs row.
 */
export function ensurePiExecutorProfile(
  db: Database.Database,
  providerId: string,
  modelId: string,
  displayName?: string | null,
  contextWindow?: number | null,
  maxTokens?: number | null,
): ExecutorProfile {
  // Look up provider name
  const provider = db.prepare('SELECT name FROM pi_providers WHERE id = ?').get(providerId) as { name: string } | undefined;
  const providerName = provider?.name || providerId;
  const profileName = `${providerName} / ${displayName || modelId}`;

  // Find or create executor_profile
  let profile = db.prepare(
    "SELECT ep.* FROM executor_profiles ep JOIN pi_executor_configs pec ON pec.executor_profile_id = ep.id WHERE pec.provider_id = ? AND pec.model_id = ?"
  ).get(providerId, modelId) as ExecutorProfile | undefined;

  if (!profile) {
    const id = uuidv4();
    // Find or create a project to attach the profile to
    let projectId = (db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get() as { id: string } | undefined)?.id;
    if (!projectId) {
      projectId = uuidv4();
      db.prepare(`
        INSERT INTO projects (id, name, description, task_description, command_template, orchestrator_engine, status, owner_id)
        VALUES (?, 'Pi-AI Executors', 'Auto-created for pi-ai executor profiles', 'Pi-AI execution', '', 'native', 'active', NULL)
      `).run(projectId);
    }

    db.prepare(`
      INSERT INTO executor_profiles (id, project_id, name, executor_type, command_template, command_type, working_directory, env_json, session_policy_json)
      VALUES (?, ?, ?, 'pi-ai', '', NULL, NULL, '{}', '{}')
    `).run(id, projectId, profileName);

    db.prepare(`
      INSERT INTO pi_executor_configs (id, executor_profile_id, provider_id, model_id, temperature, max_tokens, system_prompt, reasoning_effort, extra_params_json)
      VALUES (?, ?, ?, ?, 0.7, ?, '', NULL, '{}')
    `).run(uuidv4(), id, providerId, modelId, maxTokens ?? 4096);

    profile = db.prepare('SELECT * FROM executor_profiles WHERE id = ?').get(id) as ExecutorProfile;
  } else {
    // Update name if display name changed
    db.prepare("UPDATE executor_profiles SET name = ?, updated_at = datetime('now') WHERE id = ?")
      .run(profileName, profile.id);
    if (maxTokens) {
      db.prepare("UPDATE pi_executor_configs SET max_tokens = ?, updated_at = datetime('now') WHERE executor_profile_id = ?")
        .run(maxTokens, profile.id);
    }
  }

  return profile;
}

/**
 * Remove the executor_profile + pi_executor_configs for a pi-ai provider|model combination.
 */
export function removePiExecutorProfile(
  db: Database.Database,
  providerId: string,
  modelId: string,
): void {
  const config = db.prepare(
    'SELECT executor_profile_id FROM pi_executor_configs WHERE provider_id = ? AND model_id = ?'
  ).get(providerId, modelId) as { executor_profile_id: string } | undefined;
  if (!config) return;

  db.prepare('DELETE FROM executor_profiles WHERE id = ?').run(config.executor_profile_id);
  // pi_executor_configs is CASCADE deleted
}
