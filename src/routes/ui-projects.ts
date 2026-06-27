import { FastifyInstance } from 'fastify';
import { getDatabase } from '../db/database';
import { getProjectRequestContext } from '../middleware/request-context';
import { listCommandProfiles } from '../services/command-profiles';
import { generateProjectMetadata, createProject } from '../services/projects';
import {
  loadRemoteInstances,
  serializeRemoteInstanceOption,
  findRemoteInstanceById,
  isLocalTargetInstanceId,
  checkRemoteCommandProfile,
} from '../services/remote-instances';
import { RemoteInstanceNotFoundError, RemoteInstanceDisabledError } from '../services/remote-instances/errors';
import { getAdapterRegistry } from '../services/adapters';
import { RemoteCommandProfileCheckError } from '../services/command-profiles';
import { getDefaultDirectoryRoots, browseDirectories } from '../services/projects/directory-browse';
import type { CommandProfile } from '../types';
import { renderAdminShell } from '../views/shell';
import {
  renderNewProjectPage,
  renderAgentToolSelect,
  renderTargetSelect,
  renderWorkdirControls,
  renderReadinessSection,
  renderPathPickerPanel,
  renderCheckItem,
  type TargetMeta,
  type ReadinessResult,
} from '../views/projects/new';
import { h, renderToString } from '../views/html';

function getCurrentUser(request: any): { display_name?: string; username: string; role: string } | null {
  return request.user
    ? {
        display_name: request.user.display_name,
        username: request.user.username,
        role: request.user.role,
      }
    : null;
}

function buildTargetMeta(targetId: string, instances: any[]): TargetMeta {
  if (targetId === 'localhost' || !targetId) {
    return { id: 'localhost', label: 'localhost', detail: 'This machine', isLocal: true };
  }
  const instance = instances.find((i) => i.id === targetId);
  return {
    id: targetId,
    label: instance?.name || instance?.base_url || 'remote machine',
    detail: instance?.base_url || instance?.name || 'Remote HAICO instance',
    isLocal: false,
  };
}

/**
 * Readiness check logic shared between change-tool, change-target, and check-readiness endpoints.
 */
async function checkReadiness(
  profile: { command: string; type?: string | null },
  targetInstanceId: string,
): Promise<ReadinessResult> {
  try {
    if (!isLocalTargetInstanceId(targetInstanceId)) {
      const db = getDatabase();
      const remoteInstance = findRemoteInstanceById(db, targetInstanceId);
      if (!remoteInstance) throw new RemoteInstanceNotFoundError();
      if (!remoteInstance.enabled) throw new RemoteInstanceDisabledError();

      const result = await checkRemoteCommandProfile(remoteInstance, {
        command: profile.command,
        type: profile.type || null,
      });
      if (!result.ok) {
        return {
          ok: false,
          profile: { id: '', name: '', type: profile.type || '', command: profile.command },
          summary: null,
          error: result.error || 'Failed to check CLI on remote instance',
        };
      }
      return {
        ok: true,
        profile: { id: '', name: '', type: profile.type || '', command: profile.command },
        summary: result.data,
      };
    }

    const adapter = getAdapterRegistry().resolveFromCommand(profile.command, profile.type);
    const summary = await adapter.inspectReadiness(profile.command);
    return {
      ok: true,
      profile: { id: '', name: '', type: profile.type || '', command: profile.command },
      summary,
    };
  } catch (error) {
    return {
      ok: false,
      profile: { id: '', name: '', type: profile.type || '', command: profile.command },
      summary: null,
      error: error instanceof Error ? error.message : 'Failed to check readiness',
    };
  }
}

export function registerProjectNewUIRoutes(fastify: FastifyInstance): void {
  // ── Shell scope: full SSR page ──
  fastify.get('/projects/new', async (request, reply) => {
    const db = getDatabase();
    const profiles: CommandProfile[] = listCommandProfiles(db) as CommandProfile[];
    const instances = loadRemoteInstances(db).filter((i) => i.enabled).map(serializeRemoteInstanceOption);
    const directoryRoots = getDefaultDirectoryRoots();
    const currentUser = getCurrentUser(request);

    const body = renderNewProjectPage(profiles, instances, directoryRoots, currentUser);
    return reply
      .type('text/html')
      .send(renderToString(renderAdminShell({
        title: 'New Project - HAICO',
        body,
      })));
  });

  // ── Fragment scope: htmx fragments ──
  fastify.register(async (fragmentScope) => {
    fragmentScope.setErrorHandler((error, request, reply) => {
      request.log.error({ err: error }, 'Project new UI fragment error');
      const message = process.env.NODE_ENV === 'production'
        ? 'An error occurred'
        : (error instanceof Error ? error.message : 'Internal error');
      return reply.code(500).type('text/html').send(
        renderToString(h`<div class="create-project-readiness-body">${message}</div>`)
      );
    });

    // ── Change tool ──
    fragmentScope.post('/projects/new/change-tool', async (request) => {
      const db = getDatabase();
      const body = request.body as { profile_id?: string } | undefined;
      const profileId = String(body?.profile_id || '').trim();

      const profiles: CommandProfile[] = listCommandProfiles(db) as CommandProfile[];
      const selectedProfile = profileId ? profiles.find((p) => p.id === profileId) : null;
      const currentUser = getCurrentUser(request);

      // Compute readiness
      const readinessResult = selectedProfile
        ? await checkReadiness(
            { command: selectedProfile.command, type: selectedProfile.type },
            'localhost',
          )
        : { ok: false, profile: null, summary: null };

      // OOB: return updated readiness body, and the agent tool section OOB
      const toolSelectHtml = renderToString(renderAgentToolSelect(profiles, profileId));
      const readinessHtml = renderToString(renderReadinessSection(currentUser, readinessResult));

      // htmx swaps the primary target (#create-project-readiness-body), 
      // and the OOB swap handles #agent-tool-section
      return readinessHtml;
    });

    // ── Change target ──
    fragmentScope.post('/projects/new/change-target', async (request) => {
      const db = getDatabase();
      const body = request.body as { target_id?: string } | undefined;
      const targetId = String(body?.target_id || 'localhost').trim();
      const instances = loadRemoteInstances(db).filter((i) => i.enabled).map(serializeRemoteInstanceOption);
      const target = buildTargetMeta(targetId, instances);
      const currentUser = getCurrentUser(request);

      // Get readiness for the default profile
      const profiles: CommandProfile[] = listCommandProfiles(db) as CommandProfile[];
      const defaultProfile = profiles.length ? profiles[0] : null;
      const readinessResult = defaultProfile
        ? await checkReadiness({ command: defaultProfile.command, type: defaultProfile.type }, targetId)
        : { ok: false, profile: null, summary: null };

      const targetSelectHtml = renderToString(renderTargetSelect(instances, targetId));
      const workdirHtml = renderToString(renderWorkdirControls(target, ''));
      const readinessHtml = renderToString(renderReadinessSection(currentUser, readinessResult));

      return readinessHtml;
    });

    // ── Path picker: open / navigate within root ──
    fragmentScope.post('/projects/new/path-picker/navigate', async (request) => {
      const body = request.body as { root_id?: string; path?: string } | undefined;
      const rootId = String(body?.root_id || 'home').trim();
      const relativePath = String(body?.path || '').trim();

      const roots = getDefaultDirectoryRoots();
      const root = roots.find((r) => r.id === rootId) || roots[0];
      const result = await browseDirectories(root.path, relativePath);
      return renderToString(renderPathPickerPanel(roots, rootId, result.entries, result.absolute_path));
    });

    // ── Path picker: go up ──
    fragmentScope.post('/projects/new/path-picker/up', async (request) => {
      const body = request.body as { root_id?: string; current_path?: string } | undefined;
      const rootId = String(body?.root_id || 'home').trim();
      const currentPath = String(body?.current_path || '').trim();

      const roots = getDefaultDirectoryRoots();
      const root = roots.find((r) => r.id === rootId) || roots[0];

      // Navigate up: remove last segment
      const parentPath = currentPath ? currentPath.split('/').filter(Boolean).slice(0, -1).join('/') : '';

      const result = await browseDirectories(root.path, parentPath);
      return renderToString(renderPathPickerPanel(roots, rootId, result.entries, result.absolute_path));
    });

    // ── Path picker: use selected folder ──
    fragmentScope.post('/projects/new/path-picker/use', async (request, reply) => {
      const body = request.body as { root_id?: string; path?: string } | undefined;
      const rootId = String(body?.root_id || 'home').trim();
      const relativePath = String(body?.path || '').trim();

      const roots = getDefaultDirectoryRoots();
      const root = roots.find((r) => r.id === rootId) || roots[0];
      const resolvedPath = require('path').resolve(root.path, relativePath);

      // Send back a script that fills the workdir and closes the picker
      return renderToString(h`
        <script>
          document.getElementById('proj-workdir').value = '${resolvedPath}';
          document.getElementById('path-picker-panel').hidden = true;
        </script>`);
    });

    // ── Check readiness (explicit refresh) ──
    fragmentScope.post('/projects/new/check-readiness', async (request) => {
      const db = getDatabase();
      const body = request.body as { profile_id?: string; target_id?: string } | undefined;
      const profileId = String(body?.profile_id || '').trim();
      const targetId = String(body?.target_id || 'localhost').trim();
      const currentUser = getCurrentUser(request);

      const profiles: CommandProfile[] = listCommandProfiles(db) as CommandProfile[];
      const selectedProfile = profileId ? profiles.find((p) => p.id === profileId) : (profiles[0] || null);

      const readinessResult = selectedProfile
        ? await checkReadiness({ command: selectedProfile.command, type: selectedProfile.type }, targetId)
        : { ok: false, profile: null, summary: null };

      return renderToString(renderReadinessSection(currentUser, readinessResult));
    });

    // ── Submit: create project ──
    fragmentScope.post('/projects/new/submit', async (request, reply) => {
      const db = getDatabase();
      const body = (request.body || {}) as Record<string, unknown>;

      const task = String(body.task || '').trim();
      const profileId = String(body.profile_id || '').trim();
      const command = String(body.command || '').trim();
      const commandType = String(body.command_type || '').trim() || null;
      const targetId = String(body.target_id || 'localhost').trim();
      const workdir = String(body.workdir || '').trim() || null;

      const currentUser = getCurrentUser(request);
      const profiles: CommandProfile[] = listCommandProfiles(db) as CommandProfile[];
      const instances = loadRemoteInstances(db).filter((i) => i.enabled).map(serializeRemoteInstanceOption);
      const directoryRoots = getDefaultDirectoryRoots();

      // Validate
      if (!task) {
        const page = renderNewProjectPage(profiles, instances, directoryRoots, currentUser);
        return renderToString(renderAdminShell({ title: 'New Project - HAICO', body: page }));
      }

      const selectedProfile = profileId ? profiles.find((p) => p.id === profileId) : null;
      if (!selectedProfile || !command) {
        const page = renderNewProjectPage(profiles, instances, directoryRoots, currentUser);
        return renderToString(renderAdminShell({ title: 'New Project - HAICO', body: page }));
      }

      // Check readiness
      const readinessResult = await checkReadiness(
        { command: selectedProfile.command, type: selectedProfile.type },
        targetId,
      );
      if (!readinessResult.ok || !readinessResult.summary?.ready) {
        // Return page with readiness errors
        const errorPage = h`
          <section class="project-new-header">
            <div>
              <div class="settings-page-eyebrow">Projects</div>
              <h2>Create New Project</h2>
              <p>Describe the work, choose where HAICO should run it, and verify the selected agent tool before launch.</p>
            </div>
          </section>
          <section class="project-new-layout">
            <form id="new-project-form" class="card project-new-form"
              hx-post="/ui/projects/new/submit"
              hx-target="#main-content"
              hx-swap="innerHTML">
              <div class="form-group">
                <label for="proj-task">What do you want to do?</label>
                <textarea id="proj-task" name="task" rows="6">${task}</textarea>
              </div>
              <div class="project-new-grid">
                <div class="form-group">${renderAgentToolSelect(profiles, profileId)}</div>
                <div class="form-group">${renderTargetSelect(instances, targetId)}</div>
              </div>
              <div class="form-group">
                ${renderWorkdirControls(buildTargetMeta(targetId, instances), workdir || '')}
              </div>
              <div class="create-project-readiness" id="create-project-readiness">
                <div class="create-project-readiness-head">
                  <div><strong>Before you create</strong><div class="create-project-readiness-subtitle">HAICO checks whether the selected CLI is ready on this machine.</div></div>
                  <a class="btn btn-sm" href="/settings/agent-tools">Open Settings</a>
                </div>
                ${renderReadinessSection(currentUser, readinessResult)}
              </div>
              <div class="modal-actions project-new-actions">
                <a class="btn" href="/projects">Cancel</a>
                <button class="btn btn-primary" type="submit" id="new-project-submit">Create</button>
              </div>
            </form>
          </section>`;
        return renderToString(renderAdminShell({ title: 'New Project - HAICO', body: errorPage }));
      }

      // Generate metadata
      let name: string;
      let description: string;
      let taskDesc: string;
      let controllerRole: string | null;

      try {
        const gen = await generateProjectMetadata({
          description: task,
          tool_path: command,
          command_type: commandType,
        });
        name = gen.name || 'project';
        description = gen.description || task.slice(0, 100);
        taskDesc = gen.task_description || task;
        controllerRole = gen.controller_role || null;
      } catch {
        name = task.slice(0, 30).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'project';
        description = task.slice(0, 100);
        taskDesc = task;
        controllerRole = null;
      }

      // Create project
      const project = createProject(db, {
        name,
        description,
        task_description: taskDesc,
        command_profile_id: selectedProfile.id,
        command_template: command,
        command_type: selectedProfile.type,
        working_directory: workdir,
        controller_role: controllerRole,
        target_instance_id: targetId === 'localhost' ? null : targetId,
      }, getProjectRequestContext(request));

      reply.header('HX-Redirect', `/project/${project.id}`);
      return '';
    });

  }, { prefix: '/ui' });
}
