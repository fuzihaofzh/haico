import { getCachedJson, setCachedJson } from '../shared/dashboard-storage.js';
import {
  REMOTE_OPTIONS_CACHE_KEY,
  invalidateDashboardProjects,
} from '../shared/dashboard-project-store.js';

const REMOTE_OPTIONS_CACHE_TTL_MS = 60000;

let currentUser = null;
let createProjectReadiness = null;
let createProjectReadinessRequestId = 0;
let createProjectTargetOptions = [];
let createProjectDirectoryRoots = [];
let createProjectDirectoryRootId = '';
let createProjectDirectoryRelativePath = '';

function getCommandProfileManager() {
  return window.HAICOCommandProfiles || null;
}

function getSelectedProfile() {
  const manager = getCommandProfileManager();
  const select = document.getElementById('proj-cmd-profile');
  return manager?.getById(select?.value || '') || null;
}

function getTargetSelect() {
  return document.getElementById('proj-target-instance');
}

function getTargetId() {
  return getTargetSelect()?.value || 'localhost';
}

function getTargetMeta(targetId) {
  const resolvedId = String(targetId || getTargetId() || 'localhost').trim() || 'localhost';
  if (resolvedId === 'localhost') {
    return {
      id: 'localhost',
      label: 'localhost',
      detail: 'This machine',
      isLocal: true,
      instance: null,
    };
  }

  const instance = (createProjectTargetOptions || []).find((item) => item.id === resolvedId) || null;
  return {
    id: resolvedId,
    label: instance?.name || instance?.base_url || 'remote machine',
    detail: instance?.base_url || instance?.name || 'Remote HAICO instance',
    isLocal: false,
    instance,
  };
}

function updateWorkdirControls() {
  const target = getTargetMeta();
  const input = document.getElementById('proj-workdir');
  const browseButton = document.getElementById('proj-workdir-browse');
  const hint = document.getElementById('proj-workdir-hint');

  if (input) {
    input.placeholder = target.isLocal
      ? 'Optional absolute path'
      : 'Optional absolute path on the selected machine';
  }
  if (browseButton) {
    browseButton.disabled = !target.isLocal;
    browseButton.title = target.isLocal
      ? 'Browse local folders'
      : 'Remote folder browsing is not available';
  }
  if (hint) {
    hint.textContent = target.isLocal
      ? 'Optional. If empty, HAICO will use the path inferred from your prompt or leave it unset.'
      : `Optional. Enter an absolute path on ${target.label} manually. Folder browsing only works for localhost.`;
  }

  if (!target.isLocal) {
    closePathPicker();
  }
}

function renderTargetOptions(selectedTargetId) {
  const select = getTargetSelect();
  const hint = document.getElementById('proj-target-instance-hint');
  if (!select) return;

  const remoteOptions = Array.isArray(createProjectTargetOptions) ? createProjectTargetOptions : [];
  const desiredTargetId = String(selectedTargetId || select.value || 'localhost').trim() || 'localhost';

  select.innerHTML = [
    '<option value="localhost">localhost</option>',
    ...remoteOptions.map((instance) => {
      const statusSuffix = !instance.available
        ? ' - setup required'
        : (instance.last_status === 'error' ? ' - connection issue' : '');
      const label = `${instance.name} - ${instance.base_url}${statusSuffix}`;
      return `<option value="${esc(instance.id)}">${esc(label)}</option>`;
    }),
  ].join('');

  const validTargetId = desiredTargetId === 'localhost' || remoteOptions.some((instance) => instance.id === desiredTargetId)
    ? desiredTargetId
    : 'localhost';
  select.value = validTargetId;

  const target = getTargetMeta(validTargetId);
  if (hint) {
    hint.textContent = target.isLocal
      ? 'New projects run on localhost by default.'
      : `HAICO will prepare and create this project on ${target.label}.`;
  }
  updateWorkdirControls();
}

async function hydrateTargetOptions() {
  const select = getTargetSelect();
  if (!select) return;

  const currentTargetId = select.value || 'localhost';
  select.disabled = true;

  try {
    let instances = getCachedJson(REMOTE_OPTIONS_CACHE_KEY, REMOTE_OPTIONS_CACHE_TTL_MS);

    if (!Array.isArray(instances)) {
      instances = [];
      const optionsRes = await fetch('/api/remote-instance-options', { headers: apiHeaders() });
      if (optionsRes.ok) {
        const data = await optionsRes.json().catch(() => ({}));
        instances = Array.isArray(data.instances) ? data.instances : [];
      } else {
        const remoteProjectsRes = await fetch('/api/remote-projects', { headers: apiHeaders() });
        const remoteProjectsData = remoteProjectsRes.ok ? await remoteProjectsRes.json().catch(() => ({})) : {};
        const remoteInstances = Array.isArray(remoteProjectsData.instances) ? remoteProjectsData.instances : [];
        const byId = new Map();
        for (const instance of remoteInstances) {
          if (!instance || !instance.id) continue;
          byId.set(instance.id, {
            id: instance.id,
            name: instance.name || instance.base_url || instance.id,
            base_url: instance.base_url || '',
            enabled: instance.enabled !== false,
            last_status: instance.last_status || instance.runtime_status || 'unknown',
            last_error: instance.last_error || instance.runtime_error || '',
            available: instance.enabled !== false,
          });
        }
        instances = Array.from(byId.values());
      }
      setCachedJson(REMOTE_OPTIONS_CACHE_KEY, instances);
    }

    createProjectTargetOptions = instances;
  } catch (error) {
    console.error('Failed to load create project machine options', error);
    createProjectTargetOptions = [];
  } finally {
    select.disabled = false;
    renderTargetOptions(currentTargetId);
  }
}

function renderCheck(input) {
  const tone = input.tone || 'warn';
  const detail = input.detail || '';
  const action = input.action || '';
  return `
    <div class="create-project-check create-project-check-${tone}">
      <div class="create-project-check-icon" aria-hidden="true"></div>
      <div class="create-project-check-copy">
        <div class="create-project-check-title">${esc(input.title || '')}</div>
        <div class="create-project-check-detail">${detail}</div>
        ${action ? `<div class="create-project-check-actions">${action}</div>` : ''}
      </div>
    </div>
  `;
}

function getAccountDetail() {
  if (currentUser) {
    const name = currentUser.display_name || currentUser.username || 'Current user';
    return {
      tone: 'ok',
      title: 'Account',
      detail: `Signed in as <strong>${esc(name)}</strong> (${esc(currentUser.role || 'member')}).`,
    };
  }

  return {
    tone: 'warn',
    title: 'Account',
    detail: 'Your session is required to create a project. If HAICO redirects you, sign in again and reopen this page.',
  };
}

function renderReadinessBody(content) {
  const body = document.getElementById('create-project-readiness-body');
  if (body) body.innerHTML = content;
}

function renderMissingProfileState() {
  const target = getTargetMeta();
  renderReadinessBody([
    renderCheck(getAccountDetail()),
    renderCheck({
      tone: 'error',
      title: 'Agent Tool',
      detail: 'No Agent Tool is configured yet. Open <strong>Settings</strong>, add one, then come back here.',
      action: '<a class="btn btn-sm" href="/settings">Open Settings</a>',
    }),
    renderCheck({
      tone: 'warn',
      title: 'First-time setup',
      detail: target.isLocal
        ? 'After adding the Agent Tool, make sure the CLI is installed locally and logged in. HAICO will re-check that here before project creation.'
        : `After adding the Agent Tool, make sure the CLI is installed and logged in on <strong>${esc(target.label)}</strong>. HAICO will re-check that here before project creation.`,
    }),
  ].join(''));
}

function renderReadiness(profile, readiness) {
  const target = getTargetMeta();
  const profileName = profile?.name || 'Selected profile';
  const commandType = readiness?.command_type || profile?.type || 'unknown';
  const binaryLabel = readiness?.binary || 'selected CLI';
  const binaryStatus = readiness?.binary_found
    ? {
        tone: 'ok',
        title: 'CLI availability',
        detail: `${esc(binaryLabel)} is available on <strong>${esc(target.label)}</strong> at <span class="create-project-inline-code">${esc(readiness.binary_path || '')}</span>.`,
      }
    : {
        tone: 'error',
        title: 'CLI availability',
        detail: `HAICO could not find <span class="create-project-inline-code">${esc(binaryLabel)}</span> on <strong>${esc(target.label)}</strong>. Install it there and make sure the shell can run it.`,
      };
  const authTone = readiness?.auth?.status === 'configured'
    ? 'ok'
    : (readiness?.auth?.status === 'missing' ? 'warn' : 'warn');
  const authDetailParts = [esc(readiness?.auth?.message || 'HAICO cannot verify login state for this tool automatically.')];
  if (readiness?.auth?.action_command) {
    authDetailParts.push(`Suggested command: <span class="create-project-inline-code">${esc(readiness.auth.action_command)}</span>`);
  }

  const issueCards = (readiness?.issues || []).filter((issue) => issue.code !== 'auth_missing').map((issue) => renderCheck({
    tone: issue.severity === 'blocking' ? 'error' : 'warn',
    title: issue.title,
    detail: `${esc(issue.detail)}${issue.action_command ? ` Suggested command: <span class="create-project-inline-code">${esc(issue.action_command)}</span>` : ''}`,
    action: issue.action_label === 'Open Settings'
      ? '<a class="btn btn-sm" href="/settings">Open Settings</a>'
      : '',
  }));

  renderReadinessBody([
    renderCheck(getAccountDetail()),
    renderCheck({
      tone: 'ok',
      title: 'Agent Tool',
      detail: `Using <strong>${esc(profileName)}</strong> on <strong>${esc(target.label)}</strong> (${esc(commandType)}): <span class="create-project-inline-code">${esc(profile?.command || '')}</span>`,
    }),
    renderCheck(binaryStatus),
    renderCheck({
      tone: authTone,
      title: 'CLI login',
      detail: authDetailParts.join(' '),
    }),
    ...issueCards,
  ].join(''));
}

async function refreshReadiness() {
  const profile = getSelectedProfile();
  if (!profile?.command) {
    createProjectReadiness = null;
    renderMissingProfileState();
    return null;
  }

  const requestId = ++createProjectReadinessRequestId;
  const target = getTargetMeta();
  renderReadinessBody(`<div class="create-project-readiness-empty">Checking CLI setup on ${esc(target.label)}...</div>`);

  try {
    const res = await fetch('/api/command-profiles/check', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        command: profile.command,
        type: profile.type,
        target_instance_id: target.id,
      }),
    });
    const readiness = await res.json().catch(() => null);
    if (requestId !== createProjectReadinessRequestId) return null;
    if (!res.ok) {
      createProjectReadiness = null;
      renderReadinessBody(renderCheck({
        tone: 'warn',
        title: 'Setup check unavailable',
        detail: readiness?.error
          ? `HAICO could not inspect the CLI on <strong>${esc(target.label)}</strong>: ${esc(readiness.error)}`
          : `HAICO could not inspect the CLI on <strong>${esc(target.label)}</strong> right now.`,
      }));
      return null;
    }
    createProjectReadiness = readiness;
    renderReadiness(profile, readiness || {});
    return readiness;
  } catch (error) {
    if (requestId !== createProjectReadinessRequestId) return null;
    createProjectReadiness = null;
    renderReadinessBody(renderCheck({
      tone: 'warn',
      title: 'Setup check unavailable',
      detail: `HAICO could not inspect your CLI right now${error?.message ? `: ${esc(error.message)}` : '.'}`,
    }));
    return null;
  }
}

function populateCommandProfileOptions(selectedProfileId) {
  const select = document.getElementById('proj-cmd-profile');
  const hiddenInput = document.getElementById('proj-cmd');
  const preview = document.getElementById('proj-cmd-preview');
  if (!select || !hiddenInput) return;

  const manager = getCommandProfileManager();
  const profiles = manager?.getProfiles() || [];

  if (!profiles.length) {
    select.innerHTML = '<option value="">No Agent Tools configured</option>';
    select.disabled = true;
    hiddenInput.value = '';
    if (preview) preview.innerHTML = 'No Agent Tool is configured yet. Open Settings and add one.';
    return;
  }

  const nextProfileId = selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : profiles[0].id;

  select.disabled = false;
  select.innerHTML = profiles.map((profile) =>
    `<option value="${profile.id}">${esc(profile.name)} (${esc(profile.type)})</option>`
  ).join('');
  select.value = nextProfileId;
  handleCommandProfileChange();
}

async function hydrateCommandProfileControls() {
  const select = document.getElementById('proj-cmd-profile');
  const hiddenInput = document.getElementById('proj-cmd');
  const preview = document.getElementById('proj-cmd-preview');
  if (!select || !hiddenInput) return;

  const manager = getCommandProfileManager();
  if (!manager) {
    select.innerHTML = '<option value="">Agent Tools unavailable</option>';
    select.disabled = true;
    hiddenInput.value = '';
    if (preview) preview.textContent = 'Open Settings and configure an Agent Tool first.';
    return;
  }

  await manager.ensureLoaded();
  const currentProfileId = select.value;
  populateCommandProfileOptions(currentProfileId);
  if (!(manager.getProfiles() || []).length) {
    createProjectReadiness = null;
    renderMissingProfileState();
  }
}

function handleCommandProfileChange() {
  const select = document.getElementById('proj-cmd-profile');
  const hiddenInput = document.getElementById('proj-cmd');
  const preview = document.getElementById('proj-cmd-preview');
  if (!select || !hiddenInput) return;

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  hiddenInput.value = selectedProfile?.command || '';
  if (preview) {
    preview.textContent = selectedProfile
      ? `Command: ${selectedProfile.command} (${selectedProfile.type})`
      : 'No Agent Tool is configured yet. Open Settings and add one first.';
  }
  refreshReadiness().catch((error) => {
    console.error('Failed to refresh create project readiness', error);
  });
}

function handleTargetChange() {
  renderTargetOptions(getTargetId());
  refreshReadiness().catch((error) => {
    console.error('Failed to refresh create project readiness after machine change', error);
  });
}

function clearWorkdir() {
  const input = document.getElementById('proj-workdir');
  if (input) input.value = '';
}

async function ensureDirectoryRootsLoaded() {
  if (createProjectDirectoryRoots.length > 0) return createProjectDirectoryRoots;
  const res = await fetch('/api/projects/directory-roots', { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load directory roots');
  createProjectDirectoryRoots = Array.isArray(data.roots) ? data.roots : [];
  return createProjectDirectoryRoots;
}

function renderPathPicker(entries, currentPath) {
  const list = document.getElementById('path-picker-list');
  const current = document.getElementById('path-picker-current');
  if (current) current.textContent = currentPath || '/';
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div class="create-project-readiness-empty">No subdirectories here.</div>';
    return;
  }
  list.innerHTML = entries.map((entry) => `
    <button type="button" class="path-picker-entry" data-path="${esc(entry.relative_path || '')}">
      <div>
        <div class="path-picker-entry-name">${esc(entry.name)}</div>
        <div class="path-picker-entry-path">${esc(entry.absolute_path || '')}</div>
      </div>
      <div class="create-project-inline-code">dir</div>
    </button>
  `).join('');
}

async function loadPathPicker(pathValue) {
  const rootSelect = document.getElementById('path-picker-root');
  if (!rootSelect) return;
  const roots = await ensureDirectoryRootsLoaded();
  if (!roots.length) throw new Error('No browse roots available');

  const workdirValue = String(pathValue || document.getElementById('proj-workdir')?.value || '').trim();
  const matchedRoot = roots.find((root) => workdirValue && (workdirValue === root.path || workdirValue.startsWith(`${root.path}/`))) || roots[0];
  if (!createProjectDirectoryRootId || !roots.some((root) => root.id === createProjectDirectoryRootId)) {
    createProjectDirectoryRootId = matchedRoot.id;
  }
  if (workdirValue && matchedRoot.id === createProjectDirectoryRootId) {
    createProjectDirectoryRelativePath = workdirValue === matchedRoot.path
      ? ''
      : workdirValue.slice(matchedRoot.path.length).replace(/^\/+/, '');
  }

  rootSelect.innerHTML = roots.map((root) =>
    `<option value="${esc(root.id)}">${esc(root.label)} - ${esc(root.path)}</option>`
  ).join('');
  rootSelect.value = createProjectDirectoryRootId;

  const params = new URLSearchParams({
    root_id: createProjectDirectoryRootId,
    path: createProjectDirectoryRelativePath || '',
  });
  const res = await fetch(`/api/projects/browse-directories?${params.toString()}`, { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to browse directories');
  createProjectDirectoryRelativePath = data.relative_path || '';
  renderPathPicker(Array.isArray(data.entries) ? data.entries : [], data.absolute_path || '');
}

function setPathPickerLoading(message) {
  const list = document.getElementById('path-picker-list');
  if (list) list.innerHTML = `<div class="create-project-readiness-empty">${esc(message)}</div>`;
}

function openPathPicker() {
  if (!getTargetMeta().isLocal) {
    showToast('Remote folder browsing is not available yet. Enter the path manually.', 'error');
    return;
  }
  const panel = document.getElementById('path-picker-panel');
  if (panel) panel.hidden = false;
  setPathPickerLoading('Loading directories...');
  loadPathPicker().catch((error) => {
    setPathPickerLoading(error.message || 'Failed to load directories');
  });
}

function closePathPicker() {
  const panel = document.getElementById('path-picker-panel');
  if (panel) panel.hidden = true;
}

function handlePathPickerRootChange() {
  createProjectDirectoryRootId = document.getElementById('path-picker-root')?.value || '';
  createProjectDirectoryRelativePath = '';
  setPathPickerLoading('Loading directories...');
  loadPathPicker().catch((error) => {
    setPathPickerLoading(error.message || 'Failed to load directories');
  });
}

function navigatePathPicker(relativePath) {
  createProjectDirectoryRelativePath = relativePath || '';
  setPathPickerLoading('Loading directories...');
  loadPathPicker().catch((error) => {
    setPathPickerLoading(error.message || 'Failed to load directories');
  });
}

function navigatePathPickerUp() {
  if (!createProjectDirectoryRelativePath) return;
  const parts = createProjectDirectoryRelativePath.split('/').filter(Boolean);
  parts.pop();
  navigatePathPicker(parts.join('/'));
}

async function confirmPathPickerSelection() {
  const params = new URLSearchParams({
    root_id: createProjectDirectoryRootId,
    path: createProjectDirectoryRelativePath || '',
  });
  const res = await fetch(`/api/projects/browse-directories?${params.toString()}`, { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Failed to use this folder', 'error');
    return;
  }
  const input = document.getElementById('proj-workdir');
  if (input) input.value = data.absolute_path || '';
  closePathPicker();
}

async function submitProject(event) {
  event.preventDefault();
  const btn = document.getElementById('new-project-submit');
  await withLoading(btn, async () => {
    const task = document.getElementById('proj-task').value.trim();
    const selectedProfile = getSelectedProfile();
    const target = getTargetMeta();
    const toolPath = selectedProfile?.command || document.getElementById('proj-cmd').value.trim();
    const explicitWorkdir = document.getElementById('proj-workdir')?.value.trim() || '';
    if (!task) {
      showToast('Please describe the task to execute', 'error');
      return;
    }
    if (!selectedProfile || !toolPath) {
      renderMissingProfileState();
      showToast('Please choose an Agent Tool configured in Settings first', 'error');
      return;
    }

    const readiness = await refreshReadiness();
    if (readiness && readiness.ready === false) {
      showToast('Finish the setup items before creating the project', 'error');
      return;
    }

    btn.textContent = 'Generating...';
    const genRes = await fetch('/api/generate-project', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        description: task,
        tool_path: toolPath,
        command_type: selectedProfile.type,
        target_instance_id: target.id,
      }),
    });

    let name;
    let description;
    let taskDesc;
    let workDir;
    let ctrlRole;
    if (genRes.ok) {
      const gen = await genRes.json();
      name = gen.name || 'project';
      description = gen.description || task.slice(0, 100);
      taskDesc = gen.task_description || task;
      workDir = explicitWorkdir || gen.working_directory || null;
      ctrlRole = gen.controller_role || null;
    } else {
      const err = await genRes.json().catch(() => ({}));
      if (err.readiness) {
        createProjectReadiness = err.readiness;
        renderReadiness(selectedProfile, err.readiness);
      }
      if (err.error_code === 'missing_cli' || err.error_code === 'auth_required') {
        showToast(err.error || 'The selected CLI needs setup before project creation', 'error');
        return;
      }
      if (!target.isLocal) {
        showToast(err.error || `Failed to prepare the project on ${target.label}`, 'error');
        return;
      }
      name = task.slice(0, 30).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'project';
      description = task.slice(0, 100);
      taskDesc = task;
      workDir = explicitWorkdir || null;
    }

    btn.textContent = 'Creating...';
    const body = {
      name,
      description,
      task_description: taskDesc,
      command_template: toolPath,
      command_type: selectedProfile.type,
      working_directory: workDir,
      controller_role: ctrlRole,
      target_instance_id: target.id,
    };

    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const project = await res.json();
      invalidateDashboardProjects({ invalidateRemoteOptions: true });
      window.location.href = buildProjectPageHref(project.id);
      return;
    }

    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to create project', 'error');
  });
}

function bindEvents() {
  document.getElementById('new-project-form')?.addEventListener('submit', submitProject);
  document.getElementById('proj-cmd-profile')?.addEventListener('change', handleCommandProfileChange);
  document.getElementById('proj-target-instance')?.addEventListener('change', handleTargetChange);
  document.getElementById('proj-workdir-browse')?.addEventListener('click', openPathPicker);
  document.getElementById('proj-workdir-clear')?.addEventListener('click', clearWorkdir);
  document.getElementById('path-picker-root')?.addEventListener('change', handlePathPickerRootChange);
  document.getElementById('path-picker-up')?.addEventListener('click', navigatePathPickerUp);
  document.getElementById('path-picker-use')?.addEventListener('click', confirmPathPickerSelection);
  document.getElementById('path-picker-close')?.addEventListener('click', closePathPicker);
  document.getElementById('path-picker-list')?.addEventListener('click', (event) => {
    const entry = event.target.closest('.path-picker-entry');
    if (!entry) return;
    navigatePathPicker(entry.dataset.path || '');
  });
}

async function initProjectNewPage() {
  bindEvents();
  renderReadinessBody('<div class="create-project-readiness-empty">Loading setup checks...</div>');
  await hydrateTargetOptions();
  await hydrateCommandProfileControls();
}

window.addEventListener('haico:user-ready', (event) => {
  currentUser = event.detail || null;
  const profile = getSelectedProfile();
  if (profile && createProjectReadiness) renderReadiness(profile, createProjectReadiness);
  else if (profile) refreshReadiness().catch(() => {});
  else renderMissingProfileState();
});

window.addEventListener('haico:command-profiles-changed', () => {
  hydrateCommandProfileControls().catch((error) => {
    console.error('Failed to reload command profiles for project creation', error);
  });
});

initProjectNewPage().catch((error) => {
  console.error('Failed to initialize new project page', error);
  renderReadinessBody(renderCheck({
    tone: 'error',
    title: 'Initialization failed',
    detail: esc(error?.message || 'Failed to initialize project creation.'),
  }));
});
