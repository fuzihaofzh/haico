import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import {
  COMMAND_PROFILE_TYPES,
  normalizeCommandProfileType,
  resolveCommandType,
} from '../../services/command-profiles';
import {
  checkRemoteCommandProfile,
  findRemoteInstanceById,
  isLocalTargetInstanceId,
} from '../../services/remote-instances';
import { RemoteInstanceNotFoundError, RemoteInstanceDisabledError } from '../../services/remote-instances/errors';
import { inspectToolReadiness } from '../../services/tool-readiness';

function normalizeProfileName(value: unknown): string {
  return String(value || '').trim();
}

function normalizeProfileCommand(value: unknown): string {
  return String(value || '').trim();
}

function normalizeScenario(value: unknown): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeConfigJsonForStorage(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: '{}' };
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, error: 'config_json must be a JSON object' };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'config_json must be a JSON object' };
  }
  return { ok: true, value: JSON.stringify(parsed) };
}

function serializeCommandProfile(row: any): any {
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

const COMMAND_PROFILE_TYPE_ERROR = `type is required and must be one of: ${COMMAND_PROFILE_TYPES.join(', ')}`;

export function registerCommandProfileRoutes(fastify: FastifyInstance): void {
  fastify.register((profileRoutes, _opts, done) => {
    const defaultJsonParser = profileRoutes.getDefaultJsonParser('error', 'error');

    profileRoutes.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, parserDone) => {
      const bodyText = typeof body === 'string' ? body : body.toString();
      if (bodyText.length === 0) {
        parserDone(null, undefined);
        return;
      }

      defaultJsonParser(request, bodyText, parserDone);
    });

    profileRoutes.get('/command-profiles', async () => {
      const db = getDatabase();
      const profiles = db.prepare(
        `SELECT id, name, command, type, scenario, config_json, created_at, updated_at
         FROM command_profiles
         ORDER BY lower(name), created_at`
      ).all();
      return { profiles: profiles.map(serializeCommandProfile) };
    });

    profileRoutes.post<{
      Body: { command?: string; type?: string | null; target_instance_id?: string | null };
    }>('/command-profiles/check', async (request, reply) => {
      const command = normalizeProfileCommand(request.body?.command);
      const type = resolveCommandType(request.body?.type, command);
      const targetInstanceId = String(request.body?.target_instance_id || '').trim();

      if (!isLocalTargetInstanceId(targetInstanceId)) {
        const db = getDatabase();
        const remoteInstance = findRemoteInstanceById(db, targetInstanceId);
        if (!remoteInstance) {
          throw new RemoteInstanceNotFoundError();
        }
        if (!remoteInstance.enabled) {
          throw new RemoteInstanceDisabledError();
        }

        const result = await checkRemoteCommandProfile(remoteInstance, { command, type });
        if (!result.ok) {
          return reply.code(result.status || 502).send(
            result.data || { error: result.error || 'Failed to inspect CLI on remote instance' }
          );
        }
        return result.data;
      }

      return inspectToolReadiness({
        commandTemplate: command,
        commandType: type,
      });
    });

    profileRoutes.post<{
      Body: { name?: string; command?: string; type?: string | null; scenario?: string | null; config_json?: unknown };
    }>('/command-profiles', async (request, reply) => {
      const db = getDatabase();
      const name = normalizeProfileName(request.body?.name);
      const command = normalizeProfileCommand(request.body?.command);
      const type = resolveCommandType(request.body?.type, command);
      const scenario = normalizeScenario(request.body?.scenario);
      const configJson = normalizeConfigJsonForStorage(request.body?.config_json);

      if (!name) return reply.code(400).send({ error: 'name is required' });
      if (!command) return reply.code(400).send({ error: 'command is required' });
      if (!type) return reply.code(400).send({ error: COMMAND_PROFILE_TYPE_ERROR });
      if (!configJson.ok) return reply.code(400).send({ error: configJson.error });

      const result = db.prepare(
        `INSERT INTO command_profiles (name, command, type, scenario, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(name, command, type, scenario, configJson.value);

      return reply.code(201).send(
        serializeCommandProfile(
          db.prepare('SELECT id, name, command, type, scenario, config_json, created_at, updated_at FROM command_profiles WHERE rowid = ?').get(result.lastInsertRowid)
        )
      );
    });

    profileRoutes.put<{
      Params: { id: string };
      Body: { name?: string; command?: string; type?: string | null; scenario?: string | null; config_json?: unknown };
    }>('/command-profiles/:id', async (request, reply) => {
      const db = getDatabase();
      const existing = db.prepare('SELECT * FROM command_profiles WHERE id = ?').get(request.params.id) as
        | { id: string; name: string; command: string; type: string; scenario: string | null; config_json: string }
        | undefined;
      if (!existing) return reply.code(404).send({ error: 'Command profile not found' });

      const hasName = Object.prototype.hasOwnProperty.call(request.body || {}, 'name');
      const hasCommand = Object.prototype.hasOwnProperty.call(request.body || {}, 'command');
      const hasType = Object.prototype.hasOwnProperty.call(request.body || {}, 'type');
      const hasScenario = Object.prototype.hasOwnProperty.call(request.body || {}, 'scenario');
      const hasConfigJson = Object.prototype.hasOwnProperty.call(request.body || {}, 'config_json');

      const name = hasName ? normalizeProfileName(request.body?.name) : existing.name;
      const command = hasCommand ? normalizeProfileCommand(request.body?.command) : existing.command;
      const type = hasType || hasCommand
        ? resolveCommandType(
            hasType ? request.body?.type : existing.type,
            command
          )
        : normalizeCommandProfileType(existing.type);
      const scenario = hasScenario ? normalizeScenario(request.body?.scenario) : existing.scenario;
      const configJson = hasConfigJson
        ? normalizeConfigJsonForStorage(request.body?.config_json)
        : { ok: true as const, value: existing.config_json || '{}' };

      if (!name) return reply.code(400).send({ error: 'name is required' });
      if (!command) return reply.code(400).send({ error: 'command is required' });
      if (!type) return reply.code(400).send({ error: COMMAND_PROFILE_TYPE_ERROR });
      if (!configJson.ok) return reply.code(400).send({ error: configJson.error });

      db.prepare(
        `UPDATE command_profiles
         SET name = ?, command = ?, type = ?, scenario = ?, config_json = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(name, command, type, scenario, configJson.value, request.params.id);

      return serializeCommandProfile(
        db.prepare(
          'SELECT id, name, command, type, scenario, config_json, created_at, updated_at FROM command_profiles WHERE id = ?'
        ).get(request.params.id)
      );
    });

    profileRoutes.delete<{ Params: { id: string } }>('/command-profiles/:id', async (request, reply) => {
      const db = getDatabase();
      const result = db.prepare('DELETE FROM command_profiles WHERE id = ?').run(request.params.id);
      if (result.changes === 0) return reply.code(404).send({ error: 'Command profile not found' });
      return { success: true };
    });

    done();
  });
}
