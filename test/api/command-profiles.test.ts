import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTask } from '../../src/services/tasks';
import { getAdapterRegistry } from '../../src/services/adapters/registry';
import { getDatabase } from '../../src/db/database';
import { createApiTestHarness, type ApiTestHarness } from './helpers';

describe('Command profiles', () => {
  let ctx: ApiTestHarness;
  let previousDefaultAdmin: string | undefined;

  before(async () => {
    previousDefaultAdmin = process.env.HAICO_DEFAULT_ADMIN;
    process.env.HAICO_DEFAULT_ADMIN = 'true';
    ctx = await createApiTestHarness('command-profiles');
    const login = await ctx.api('/api/auth/default-admin-login', { method: 'POST' });
    assert.equal(login.status, 200, login.raw);
    ctx.setAuthToken?.(login.body.token);
  });

  after(async () => {
    await ctx.close();
    if (previousDefaultAdmin === undefined) delete process.env.HAICO_DEFAULT_ADMIN;
    else process.env.HAICO_DEFAULT_ADMIN = previousDefaultAdmin;
  });

  it('normalizes scenario and config_json through the API', async () => {
    const created = await ctx.api('/api/command-profiles', {
      method: 'POST',
      body: {
        name: 'Claude deep',
        command: 'cld',
        type: 'claude',
        scenario: 'Architecture',
        config_json: { model: 'claude-opus', allowedTools: ['Read', 'Grep'], verbose: true },
      },
    });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.scenario, 'Architecture');
    assert.deepEqual(created.body.config_json, {
      model: 'claude-opus',
      allowedTools: ['Read', 'Grep'],
      verbose: true,
    });

    const updated = await ctx.api(`/api/command-profiles/${created.body.id}`, {
      method: 'PUT',
      body: {
        scenario: '',
        config_json: '{"sandbox":"workspace-write","skipGitRepoCheck":true}',
        type: 'codex',
      },
    });
    assert.equal(updated.status, 200, updated.raw);
    assert.equal(updated.body.scenario, null);
    assert.deepEqual(updated.body.config_json, {
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    });

    const invalid = await ctx.api(`/api/command-profiles/${created.body.id}`, {
      method: 'PUT',
      body: { config_json: '[]' },
    });
    assert.equal(invalid.status, 400, invalid.raw);
    assert.match(invalid.body.error, /JSON object/);
  });

  it('keeps legacy command defaults for empty config and applies structured config when present', () => {
    const registry = getAdapterRegistry();
    const claudeAdapter = registry.resolveFromCommand('cld', 'claude');
    const codexAdapter = registry.resolveFromCommand('codex', 'codex');

    const legacyClaude = claudeAdapter.buildProcessCommand({
      commandTemplate: 'cld',
      sessionId: 'run-1',
      existingSessionId: null,
      commandProfileConfigJson: '{}',
    });
    assert.equal(
      legacyClaude.command,
      'cld -p --output-format stream-json --verbose --session-id run-1 --dangerously-skip-permissions --allowedTools "Bash Edit Read Write Glob Grep NotebookEdit WebFetch WebSearch Agent"'
    );

    const configuredClaude = claudeAdapter.buildProcessCommand({
      commandTemplate: 'cld',
      sessionId: 'run-1',
      existingSessionId: null,
      commandProfileConfigJson: JSON.stringify({ model: 'claude-opus', allowedTools: ['Read', 'Grep'], verbose: true }),
    });
    assert.match(configuredClaude.command, /--model 'claude-opus'/);
    assert.match(configuredClaude.command, /--allowedTools 'Read Grep'/);
    assert.match(configuredClaude.command, /--verbose/);
    assert.doesNotMatch(configuredClaude.command, /NotebookEdit/);

    const configuredCodex = codexAdapter.buildProcessCommand({
      commandTemplate: 'codex',
      sessionId: 'run-1',
      existingSessionId: null,
      commandProfileConfigJson: JSON.stringify({ sandbox: 'workspace-write', skipGitRepoCheck: true, bypassApprovals: true }),
    });
    assert.equal(
      configuredCodex.command,
      "codex exec --json --sandbox 'workspace-write' --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"
    );

    const legacyController = claudeAdapter.buildControllerCommand('cld', '{}');
    assert.equal(legacyController, 'cld --model claude-sonnet-4-6');

    const configuredController = claudeAdapter.buildControllerCommand('cld', { model: 'claude-opus' });
    assert.equal(configuredController, "cld --model 'claude-opus'");
  });

  it('snapshots latest profile config for new tasks without mutating existing task snapshots', async () => {
    const profile = await ctx.api('/api/command-profiles', {
      method: 'POST',
      body: {
        name: 'Codex daily',
        command: 'codex',
        type: 'codex',
        scenario: 'Daily',
        config_json: { sandbox: 'workspace-write', skipGitRepoCheck: true },
      },
    });
    assert.equal(profile.status, 201, profile.raw);

    const project = await ctx.api('/api/projects', {
      method: 'POST',
      body: {
        name: `profile-runtime-${Date.now()}`,
        task_description: 'Profile runtime snapshot test',
        command_profile_id: profile.body.id,
      },
    });
    assert.equal(project.status, 201, project.raw);
    assert.equal(project.body.command_profile_id, profile.body.id);

    const db = getDatabase();
    const assistant = db.prepare(
      'SELECT id FROM agents WHERE project_id = ? AND is_controller = 0 ORDER BY created_at LIMIT 1'
    ).get(project.body.id) as { id: string };

    const firstTask = createAgentTask(assistant.id, {
      prompt: 'first profile snapshot',
      source: 'test',
      reason: 'profile snapshot test',
    });
    const firstSnapshot = JSON.parse(firstTask.executor_snapshot_json);
    assert.equal(firstSnapshot.command_profile_id, profile.body.id);
    assert.equal(firstSnapshot.command_profile_config_json, JSON.stringify({ sandbox: 'workspace-write', skipGitRepoCheck: true }));

    const updated = await ctx.api(`/api/command-profiles/${profile.body.id}`, {
      method: 'PUT',
      body: { config_json: { sandbox: 'danger-full-access', bypassApprovals: true } },
    });
    assert.equal(updated.status, 200, updated.raw);

    const secondTask = createAgentTask(assistant.id, {
      prompt: 'second profile snapshot',
      source: 'test',
      reason: 'profile snapshot test',
    });
    const reloadedFirst = db.prepare('SELECT executor_snapshot_json FROM tasks WHERE id = ?').get(firstTask.id) as any;
    const firstSnapshotAfterUpdate = JSON.parse(reloadedFirst.executor_snapshot_json);
    const secondSnapshot = JSON.parse(secondTask.executor_snapshot_json);

    assert.equal(firstSnapshotAfterUpdate.command_profile_config_json, JSON.stringify({ sandbox: 'workspace-write', skipGitRepoCheck: true }));
    assert.equal(secondSnapshot.command_profile_config_json, JSON.stringify({ sandbox: 'danger-full-access', bypassApprovals: true }));
  });

  it('returns 404 when updating a non-existent command profile', async () => {
    const result = await ctx.api('/api/command-profiles/nonexistent-id', {
      method: 'PUT',
      body: { name: 'test' },
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'Command profile not found');
  });

  it('returns 404 when deleting a non-existent command profile', async () => {
    const result = await ctx.api('/api/command-profiles/nonexistent-id', {
      method: 'DELETE',
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'Command profile not found');
  });

  it('returns 400 when creating without required name', async () => {
    const result = await ctx.api('/api/command-profiles', {
      method: 'POST',
      body: { command: 'cld', type: 'claude' },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'name is required');
  });

  it('returns 400 when creating without required command', async () => {
    const result = await ctx.api('/api/command-profiles', {
      method: 'POST',
      body: { name: 'test', type: 'claude' },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'command is required');
  });

  it('returns 400 when creating with an invalid type', async () => {
    const result = await ctx.api('/api/command-profiles', {
      method: 'POST',
      body: { name: 'test', command: 'foo', type: 'invalid-type' },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /type is required/);
  });

  it('returns 400 when clearing name to empty on update', async () => {
    const created = await ctx.api('/api/command-profiles', {
      method: 'POST',
      body: { name: 'temp-profile', command: 'cld', type: 'claude' },
    });
    assert.equal(created.status, 201);

    const result = await ctx.api(`/api/command-profiles/${created.body.id}`, {
      method: 'PUT',
      body: { name: '' },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'name is required');
  });
});
