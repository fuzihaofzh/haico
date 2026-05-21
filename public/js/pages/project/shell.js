var projectId = getProjectIdFromPath();
var isRemoteProjectView = isRemoteProjectId(projectId);
var projectData = null;
var agentsData = [];
var orchestrationRunsData = [];

const CUSTOM_COMMAND_PROFILE_VALUE = '__custom__';
const PROJECT_VIEWS = ['overview', 'agents', 'issues', 'activity', 'git', 'knowledge', 'files', 'workflow'];
const PROJECT_VIEW_LABELS = {
  overview: '',
  agents: 'Agents',
  issues: 'Issues',
  activity: 'Activity',
  git: 'Git',
  knowledge: 'Knowledge',
  files: 'Files',
  workflow: 'Workflow',
};

function getProjectIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const projectsIndex = parts.indexOf('projects');
  return decodeRouteParam(projectsIndex >= 0 ? parts[projectsIndex + 1] : '');
}

function getProjectView() {
  const view = document.body?.dataset?.projectView || 'overview';
  return PROJECT_VIEWS.includes(view) ? view : 'overview';
}

function projectPagePath(view) {
  const targetView = PROJECT_VIEWS.includes(view) ? view : 'overview';
  const base = buildProjectPageHref(projectId);
  return targetView === 'overview' ? base : `${base}/${targetView}`;
}

function projectApiPath(suffix) {
  return buildProjectApiPath(projectId, suffix || '');
}

function agentApiPath(agentId, suffix) {
  return buildAgentApiPath(agentId, suffix || '');
}

function issuePageHref(issue) {
  return buildIssuePageHref({
    issueId: issue && issue.id,
    projectId: issue && issue.project_id ? issue.project_id : projectId,
    issueNumber: issue && issue.number,
  });
}

async function fetchProjectJson(url, fallbackMessage) {
  const res = await fetch(url, { headers: apiHeaders() });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || fallbackMessage || 'Failed to load');
  return data;
}

function getProjectDetail() {
  return fetchProjectJson(projectApiPath(''), 'Failed to load project');
}

function getProjectAgents() {
  return fetchProjectJson(projectApiPath('/agents'), 'Failed to load agents');
}

function getProjectIssueCounts() {
  return fetchProjectJson(projectApiPath('/issues/counts'), 'Failed to load issue counts');
}

function getProjectCostSummary() {
  return fetchProjectJson(projectApiPath('/costs'), 'Failed to load cost summary');
}

async function getProjectActiveIssues() {
  const activeStatuses = ['open', 'in_progress', 'pending'];
  const results = await Promise.all(
    activeStatuses.map((status) =>
      fetch(`${projectApiPath('/issues')}?status=${encodeURIComponent(status)}&per_page=200`, { headers: apiHeaders() })
        .then((res) => (res.ok ? res.json() : { issues: [] }))
    )
  );
  return results.flatMap((result) => result.issues || []);
}

function hideModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

const PROJECT_ACCESS_META = {
  owner: {
    badge: 'OWNER',
    tone: 'owner',
    summary: 'Project Owner',
    detail: 'You can edit the project, manage sharing, and maintain project settings.',
  },
  member: {
    badge: 'SHARED',
    tone: 'shared',
    summary: 'Shared Member',
    detail: 'This is a shared read-only view. You can browse the project and member list, but cannot manage sharing.',
  },
  admin: {
    badge: 'ADMIN VIEW',
    tone: 'admin',
    summary: 'Global Admin',
    detail: 'You are viewing this project as a global admin.',
  },
  editor: {
    badge: 'EDITOR',
    tone: 'success',
    summary: 'Editor',
    detail: 'You can view and manage this project, but cannot change ownership or delete the project.',
  },
  none: {
    badge: 'UNKNOWN',
    tone: 'shared',
    summary: 'Unknown role',
    detail: 'Role info missing.',
  },
};

function displayProjectUser(user) {
  if (!user) return 'Not set';
  return user.display_name || user.username || 'Not set';
}

function getProjectAccessLevel(project) {
  if (project?.owner?.id && _currentUser?.id && project.owner.id === _currentUser.id) {
    return 'owner';
  }
  return project?.permission_level || 'none';
}

function getProjectAccessMeta(project) {
  return PROJECT_ACCESS_META[getProjectAccessLevel(project)] || PROJECT_ACCESS_META.none;
}

function canManageProject() {
  return !!projectData?.can_manage;
}

function canDeleteProject() {
  const level = getProjectAccessLevel(projectData);
  return canManageProject() && level !== 'editor';
}

function requireProjectManageAccess(message) {
  if (canManageProject()) return true;
  showToast(message || 'Insufficient permission', 'error');
  return false;
}

function renderPermissionBadge(meta) {
  return `<span class="permission-badge permission-${meta.tone}" title="${esc(meta.summary)}">${meta.badge}</span>`;
}

function projectHasOperationsConsole(project) {
  if (!project) return false;
  if (project.id === 'project-atlas') return true;
  const haystack = `${project.name || ''} ${project.task_description || ''}`.toLowerCase();
  return haystack.includes('atlas freight command')
    || haystack.includes('route planners')
    || haystack.includes('dispatchers')
    || haystack.includes('customer updates');
}

function refreshOperationsConsoleEntry() {
  const entry = document.getElementById('btn-open-ops-console');
  if (!entry) return;

  if (isRemoteProjectView || !projectHasOperationsConsole(projectData)) {
    entry.style.display = 'none';
    entry.removeAttribute('href');
    return;
  }

  entry.href = `${buildProjectPageHref(projectId)}/operations-console`;
  entry.style.display = '';
}

function applyProjectNavigationState() {
  const currentView = getProjectView();
  document.querySelectorAll('[data-project-section-link]').forEach((link) => {
    const view = link.getAttribute('data-project-section-link');
    link.href = projectPagePath(view);
    link.classList.toggle('active', view === currentView);
    if (view === 'files') link.style.display = isRemoteProjectView ? 'none' : '';
  });

  const projectNameLink = document.getElementById('project-name');
  if (projectNameLink) projectNameLink.href = projectPagePath('overview');

  const section = PROJECT_VIEW_LABELS[currentView] || '';
  const sectionEl = document.getElementById('breadcrumb-section');
  if (sectionEl) sectionEl.textContent = section ? ` / ${section}` : '';
}

function applyProjectManageState() {
  if (!projectData) return;

  const canManage = canManageProject();
  const meta = getProjectAccessMeta(projectData);
  document.querySelectorAll('[data-project-requires-manage]').forEach((el) => {
    el.style.display = canManage ? '' : 'none';
  });
  document.querySelectorAll('[data-project-requires-delete]').forEach((el) => {
    el.style.display = canDeleteProject() ? '' : 'none';
  });

  const manageIds = ['btn-toggle', 'btn-trigger', 'btn-share-project', 'btn-save-overview', 'btn-new-agent', 'btn-new-issue', 'btn-new-knowledge'];
  manageIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = canManage ? '' : 'none';
  });
  const deleteButton = document.getElementById('btn-delete-project');
  if (deleteButton) deleteButton.style.display = canDeleteProject() ? '' : 'none';

  const headerActions = document.getElementById('project-manage-actions');
  if (headerActions) headerActions.style.display = canManage ? 'flex' : 'none';

  const readonlyBanner = document.getElementById('project-readonly-banner');
  if (readonlyBanner) {
    readonlyBanner.style.display = canManage ? 'none' : '';
    readonlyBanner.textContent = canManage ? '' : meta.detail;
  }

  document.querySelectorAll('[data-project-disable-when-readonly]').forEach((el) => {
    el.disabled = !canManage;
  });
}

function renderProjectAccessSummary() {
  if (!projectData) return;

  const meta = getProjectAccessMeta(projectData);
  const memberCount = Number.isFinite(projectData.member_count) ? projectData.member_count : 0;
  const ownerName = displayProjectUser(projectData.owner);
  const ownerRole = projectData.owner?.role === 'admin' ? 'Global Admin' : 'Project Member';

  const accessBadge = document.getElementById('project-access-badge');
  if (accessBadge) accessBadge.innerHTML = renderPermissionBadge(meta);

  const accessSummary = document.getElementById('project-access-summary');
  if (accessSummary) accessSummary.innerHTML = `<span class="meta-chip-label">Access</span><span>${esc(meta.summary)}</span>`;

  const ownerSummary = document.getElementById('project-owner-summary');
  if (ownerSummary) ownerSummary.innerHTML = `<span class="meta-chip-label">Owner</span><span>${esc(ownerName)}</span><span class="meta-chip-secondary">${esc(ownerRole)}</span>`;

  const remoteSummary = document.getElementById('project-remote-summary');
  if (remoteSummary) {
    const remoteAddress = String(projectData.remote_base_url || '').trim();
    const remoteName = String(projectData.remote_instance_name || '').trim();
    const isRemote = Boolean(projectData.is_remote && remoteAddress);
    remoteSummary.style.display = isRemote ? '' : 'none';
    if (isRemote) {
      remoteSummary.title = remoteName ? `${remoteName} · ${remoteAddress}` : remoteAddress;
      remoteSummary.innerHTML = `<span class="meta-chip-label">Remote</span><span>${esc(remoteAddress)}</span>${remoteName ? `<span class="meta-chip-secondary">${esc(remoteName)}</span>` : ''}`;
    } else {
      remoteSummary.innerHTML = '';
      remoteSummary.removeAttribute('title');
    }
  }

  const membersButton = document.getElementById('btn-view-members');
  if (membersButton) membersButton.textContent = `Members (${memberCount})`;
}

async function loadProjectShell() {
  try {
    projectData = await getProjectDetail();
  } catch (error) {
    showToast(error?.message || 'Failed to load project', 'error');
    throw error;
  }

  const nameEl = document.getElementById('project-name');
  const titleEl = document.getElementById('project-title');
  const statusEl = document.getElementById('project-status');
  if (nameEl) nameEl.textContent = projectData.name;
  if (titleEl) titleEl.textContent = projectData.name;
  if (statusEl) {
    statusEl.textContent = projectData.status;
    statusEl.className = `status-badge status-${projectData.status}`;
  }
  document.title = `HAICO - ${projectData.name}`;

  const toggleButton = document.getElementById('btn-toggle');
  if (toggleButton) {
    toggleButton.innerHTML = projectData.status === 'active' ? 'Pause' : 'Resume';
    toggleButton.title = projectData.status === 'active' ? 'Pause' : 'Resume';
  }
  const triggerButton = document.getElementById('btn-trigger');
  if (triggerButton) triggerButton.style.display = projectData.can_manage && projectData.status === 'active' ? '' : 'none';

  renderProjectAccessSummary();
  refreshOperationsConsoleEntry();
  applyProjectNavigationState();
  applyProjectManageState();
  window.dispatchEvent(new CustomEvent('haico:project-ready', { detail: projectData }));
  return projectData;
}

async function toggleProjectStatus() {
  if (!projectData) return;
  if (!projectData.can_manage) { showToast('Insufficient permission to update project status', 'error'); return; }
  const newStatus = projectData.status === 'active' ? 'paused' : 'active';
  const res = await fetch(projectApiPath(''), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: newStatus }) });
  if (res.ok) showToast('Status updated', 'success');
  else showToast('Failed to update status', 'error');
  await loadProjectShell();
}

async function triggerController() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to trigger Controller', 'error'); return; }
  const btn = event ? event.target : null;
  const run = async () => {
    if (!agentsData.length) agentsData = await getProjectAgents();
    const controller = agentsData.find(a => a.is_controller);
    if (!controller) { showToast('No controller agent found', 'error'); return; }
    if (controller.status === 'running') { showToast('Controller is already running', 'error'); return; }
    const res = await fetch(agentApiPath(controller.id, '/start'), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) {
      agentsData = await getProjectAgents().catch(() => agentsData);
      window.dispatchEvent(new CustomEvent('haico:project-agents-changed'));
      showToast('Controller started', 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to start', 'error');
    }
  };
  if (btn) await withLoading(btn, run); else await run();
}

async function deleteProject() {
  if (!canDeleteProject()) { showToast('Only project owners or admins can delete projects', 'error'); return; }
  if (!await showConfirm('Delete this project and all agents/issues?', {
    title: 'Delete project?',
    confirmLabel: 'Delete project',
    tone: 'danger',
  })) return;
  const res = await fetch(projectApiPath(''), { method: 'DELETE' });
  if (res.ok) { showToast('Project deleted', 'success'); window.location.href = '/projects'; }
  else {
    const data = await res.json().catch(() => ({}));
    showToast(data.error || 'Failed to delete', 'error');
  }
}

function getCommandProfileManager() {
  return window.HAICOCommandProfiles || null;
}

async function populateCommandProfileSelect(select, options) {
  if (!select) return [];
  const manager = getCommandProfileManager();
  if (!manager) {
    select.innerHTML = `
      <option value="">Use project default</option>
      <option value="${CUSTOM_COMMAND_PROFILE_VALUE}">Custom command</option>
    `;
    return [];
  }

  await manager.ensureLoaded();
  manager.populateSelect(select, options || {});
  return manager.getProfiles();
}

function setCommandProfileSelection(select, commandTemplate, commandType) {
  if (!select) return;

  const manager = getCommandProfileManager();
  const normalizedCommand = String(commandTemplate || '').trim();
  if (!normalizedCommand) {
    select.value = '';
    return;
  }

  const matchedProfile = manager?.findMatch(normalizedCommand, commandType) || null;
  if (matchedProfile) {
    select.value = matchedProfile.id;
    return;
  }

  const option = select.querySelector(`option[value="${CUSTOM_COMMAND_PROFILE_VALUE}"]`) || document.createElement('option');
  option.value = CUSTOM_COMMAND_PROFILE_VALUE;
  option.textContent = `Legacy/custom: ${normalizedCommand}${commandType ? ` (${commandType})` : ''}`;
  if (!option.parentElement) select.appendChild(option);
  select.value = CUSTOM_COMMAND_PROFILE_VALUE;
}

function updateCommandPreview(previewId, commandTemplate, commandType, fallbackText) {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  const command = String(commandTemplate || '').trim();
  preview.textContent = command
    ? `Command: ${command}${commandType ? ` (${commandType})` : ''}`
    : fallbackText;
}

function buildSelectedCommandConfig(selectId, inputId, emptyValue) {
  const select = document.getElementById(selectId);
  const input = document.getElementById(inputId);
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select?.value || '') || null;
  const commandTemplate = String(input?.value || '').trim();

  if (selectedProfile) {
    return {
      command_template: selectedProfile.command,
      command_type: selectedProfile.type,
    };
  }

  if (!commandTemplate && emptyValue === null) {
    return { command_template: null, command_type: null };
  }

  return {
    command_template: commandTemplate,
    command_type: input?.dataset.commandType || undefined,
  };
}

function handleLegacyHashRoute() {
  const hash = window.location.hash.replace('#', '');
  if (!hash) return;
  const hashTab = hash.split('?')[0];
  if (!PROJECT_VIEWS.includes(hashTab)) return;

  const query = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
  const target = projectPagePath(hashTab) + query;
  window.location.replace(target);
}

window.addEventListener('haico:user-ready', () => {
  renderProjectAccessSummary();
});

handleLegacyHashRoute();
applyProjectNavigationState();
