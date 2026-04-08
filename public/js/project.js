const projectId = window.location.pathname.split('/').pop();
let projectData = null;
let agentsData = [];
let orchestrationRunsData = [];
let agentOutputPollTimer = null;
let agentOutputPollingAgentId = null;
let agentOutputRefreshInFlight = false;
let projectMembersData = [];
let projectFilesAgentId = '';
let projectFilesPanel = null;
const AGENT_OUTPUT_POLL_MS = 2000;
const CUSTOM_COMMAND_PROFILE_VALUE = '__custom__';
const DASHBOARD_NAV_VIEWS = new Set(['inbox', 'projects', 'usage', 'settings']);
const PROJECT_RESOURCE_CACHE_TTL_MS = 1500;
const _projectResourceCache = new Map();

function navigateProjectSidebar(view) {
  const nextView = DASHBOARD_NAV_VIEWS.has(view) ? view : 'projects';
  window.location.href = `/?view=${encodeURIComponent(nextView)}`;
}

if (typeof window !== 'undefined') {
  window.navigateProjectSidebar = navigateProjectSidebar;
}

function invalidateProjectResources(keys) {
  (keys || []).forEach((key) => _projectResourceCache.delete(key));
}

async function fetchProjectResource(key, loader, options) {
  const opts = options || {};
  const force = opts.force === true;
  const ttl = typeof opts.ttl === 'number' ? opts.ttl : PROJECT_RESOURCE_CACHE_TTL_MS;
  const cached = _projectResourceCache.get(key);

  if (cached?.promise) return cached.promise;
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((data) => {
      _projectResourceCache.set(key, { data, expiresAt: Date.now() + ttl, promise: null });
      return data;
    })
    .catch((error) => {
      if (cached && Object.prototype.hasOwnProperty.call(cached, 'data')) {
        _projectResourceCache.set(key, { data: cached.data, expiresAt: cached.expiresAt || 0, promise: null });
      } else {
        _projectResourceCache.delete(key);
      }
      throw error;
    });

  _projectResourceCache.set(key, {
    data: cached?.data,
    expiresAt: cached?.expiresAt || 0,
    promise,
  });

  return promise;
}

async function fetchProjectJson(cacheKey, url, options) {
  return fetchProjectResource(cacheKey, async () => {
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`Failed to load ${cacheKey}`);
    return res.json();
  }, options);
}

function getProjectDetail(options) {
  return fetchProjectJson('project', `/api/projects/${projectId}`, options);
}

function getProjectAgents(options) {
  return fetchProjectJson('agents', `/api/projects/${projectId}/agents`, options);
}

function getProjectIssueCounts(options) {
  return fetchProjectJson('issueCounts', `/api/projects/${projectId}/issues/counts`, options);
}

function getProjectCostSummary(options) {
  return fetchProjectJson('costSummary', `/api/projects/${projectId}/costs`, options);
}

async function getProjectActiveIssues(options) {
  return fetchProjectResource('activeIssues', async () => {
    const activeStatuses = ['open', 'in_progress', 'pending'];
    const results = await Promise.all(
      activeStatuses.map((status) =>
        fetch(`/api/projects/${projectId}/issues?status=${status}&per_page=200`, { headers: apiHeaders() })
          .then((res) => (res.ok ? res.json() : { issues: [] }))
      )
    );
    return results.flatMap((result) => result.issues || []);
  }, options);
}

function updateProjectCostSummary(cost) {
  const costContainer = document.getElementById('project-cost');
  const costValue = document.getElementById('project-cost-value');
  if (!costContainer || !costValue) return;

  if (cost && (cost.total_cost_usd > 0 || cost.total_input_tokens > 0 || cost.total_output_tokens > 0)) {
    costContainer.style.display = '';
    const costText = cost.total_cost_usd > 0 ? `$${cost.total_cost_usd.toFixed(4)}` : 'Cost unavailable';
    costValue.textContent = `${costText} (${cost.total_input_tokens} in / ${cost.total_output_tokens} out)`;
    return;
  }

  costContainer.style.display = 'none';
  costValue.textContent = '';
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
  bypass: {
    badge: 'DEBUG',
    tone: 'debug',
    summary: 'Debug mode',
    detail: 'legacy / localhost bypass, for debugging only and not a normal user role.',
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

function requireProjectManageAccess(message) {
  if (canManageProject()) return true;
  showToast(message || 'Insufficient permission', 'error');
  return false;
}

function getControllerAgent() {
  return agentsData.find((agent) => agent.is_controller);
}

function getAgentMap() {
  return new Map((agentsData || []).map((agent) => [agent.id, agent]));
}

function getDirectChildAgents(agentId) {
  return (agentsData || []).filter((agent) => agent.parent_agent_id === agentId);
}

function getDescendantAgentIds(agentId) {
  const descendants = new Set();
  const queue = getDirectChildAgents(agentId).map((agent) => agent.id);

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || descendants.has(currentId)) continue;
    descendants.add(currentId);
    getDirectChildAgents(currentId).forEach((child) => {
      if (!descendants.has(child.id)) queue.push(child.id);
    });
  }

  return descendants;
}

function buildParentAgentOptions(currentAgentId, selectedParentId) {
  const excludedIds = new Set();
  if (currentAgentId) {
    excludedIds.add(currentAgentId);
    getDescendantAgentIds(currentAgentId).forEach((id) => excludedIds.add(id));
  }

  const options = ['<option value="">No parent (top-level agent)</option>'];
  agentsData.forEach((agent) => {
    if (excludedIds.has(agent.id)) return;
    const suffix = agent.is_controller ? ' [controller]' : '';
    const selected = selectedParentId && selectedParentId === agent.id ? ' selected' : '';
    options.push(`<option value="${agent.id}"${selected}>${esc(agent.name)}${suffix}</option>`);
  });
  return options.join('');
}

function syncParentAgentSelect(selectId, currentAgentId, selectedParentId, disabled) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = buildParentAgentOptions(currentAgentId, selectedParentId);
  select.disabled = !!disabled;
  select.value = selectedParentId || '';
}

function getCommandProfileManager() {
  return window.AgentopiaCommandProfiles || null;
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

function syncCommandProfileSelection(select, input) {
  if (!select || !input) return;
  const manager = getCommandProfileManager();
  const normalizedCommand = String(input.value || '').trim();
  const selectedProfile = manager?.getById(select.value) || null;

  if (!normalizedCommand) {
    select.value = '';
    return;
  }

  if (selectedProfile && String(selectedProfile.command || '').trim() === normalizedCommand) {
    return;
  }

  if (select.value === '') {
    select.value = CUSTOM_COMMAND_PROFILE_VALUE;
  } else if (selectedProfile) {
    select.value = CUSTOM_COMMAND_PROFILE_VALUE;
  }
}

async function hydrateCreateAgentCommandProfileControls(commandTemplate, commandType) {
  const select = document.getElementById('agent-command-profile');
  const input = document.getElementById('agent-cmdtpl');
  if (!select || !input) return;

  await populateCommandProfileSelect(select, {
    includeProjectDefault: true,
    projectDefaultLabel: 'Use project default',
    includeCustom: false,
  });
  setCommandProfileSelection(select, commandTemplate, commandType);
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  input.value = selectedProfile?.command || String(commandTemplate || '').trim();
  input.dataset.commandType = selectedProfile?.type || commandType || '';
  updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
}

function handleCreateAgentCommandProfileChange() {
  const select = document.getElementById('agent-command-profile');
  const input = document.getElementById('agent-cmdtpl');
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  if (selectedProfile) {
    input.value = selectedProfile.command || '';
    input.dataset.commandType = selectedProfile.type || '';
    updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
    return;
  }

  if (select.value === '') {
    input.value = '';
    input.dataset.commandType = '';
    updateCommandPreview('agent-cmdtpl-preview', '', '', 'Using project-level Tool Path setting.');
    return;
  }

  updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Select a tool configured in Settings.');
}

function handleCreateAgentCommandInputChange() {
  syncCommandProfileSelection(
    document.getElementById('agent-command-profile'),
    document.getElementById('agent-cmdtpl')
  );
}

async function hydrateAgentCommandProfileControls(agentId, agent) {
  const select = document.getElementById(`ad-cmdprof-${agentId}`);
  const input = document.getElementById(`ad-cmdtpl-${agentId}`);
  if (!select || !input) return;

  await populateCommandProfileSelect(select, {
    includeProjectDefault: true,
    projectDefaultLabel: 'Use project default',
    includeCustom: false,
  });
  setCommandProfileSelection(select, agent?.command_template, agent?.command_type);
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  input.value = selectedProfile?.command || String(agent?.command_template || '').trim();
  input.dataset.commandType = selectedProfile?.type || agent?.command_type || '';
  updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
}

function handleAgentCommandProfileChange(agentId) {
  const select = document.getElementById(`ad-cmdprof-${agentId}`);
  const input = document.getElementById(`ad-cmdtpl-${agentId}`);
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  if (selectedProfile) {
    input.value = selectedProfile.command || '';
    input.dataset.commandType = selectedProfile.type || '';
    updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
    return;
  }

  if (select.value === '') {
    input.value = '';
    input.dataset.commandType = '';
    updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, '', '', 'Using project-level Tool Path setting.');
    return;
  }

  updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Select a tool configured in Settings.');
}

function handleAgentCommandInputChange(agentId) {
  syncCommandProfileSelection(
    document.getElementById(`ad-cmdprof-${agentId}`),
    document.getElementById(`ad-cmdtpl-${agentId}`)
  );
}

function buildAgentCommandConfigPayload(selectId, inputId) {
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

  if (!commandTemplate) {
    return { command_template: null, command_type: null };
  }

  return {
    command_template: commandTemplate,
    command_type: input?.dataset.commandType || undefined,
  };
}

async function hydrateProjectCommandProfileControls(commandTemplate, commandType) {
  const select = document.getElementById('project-cmd-profile');
  const input = document.getElementById('project-cmd');
  if (!select || !input) return;

  const profiles = await populateCommandProfileSelect(select, {
    includeProjectDefault: false,
    includeCustom: false,
    emptyLabel: 'No command profiles configured - open Settings first',
  });
  setCommandProfileSelection(select, commandTemplate, commandType);

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  input.value = selectedProfile?.command || String(commandTemplate || '').trim();
  input.dataset.commandType = selectedProfile?.type || commandType || '';
  select.disabled = !canManageProject() || (profiles.length === 0 && !input.value);
  updateCommandPreview('project-cmd-preview', input.value, input.dataset.commandType, 'Choose a tool configured in Settings.');
}

function handleProjectCommandProfileChange() {
  const select = document.getElementById('project-cmd-profile');
  const input = document.getElementById('project-cmd');
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  if (selectedProfile) {
    input.value = selectedProfile.command || '';
    input.dataset.commandType = selectedProfile.type || '';
  }
  updateCommandPreview('project-cmd-preview', input.value, input.dataset.commandType, 'Choose a tool configured in Settings.');
}

function buildProjectCommandConfigPayload() {
  const select = document.getElementById('project-cmd-profile');
  const input = document.getElementById('project-cmd');
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select?.value || '') || null;
  const commandTemplate = String(input?.value || '').trim();

  if (selectedProfile) {
    return {
      command_template: selectedProfile.command,
      command_type: selectedProfile.type,
    };
  }

  return {
    command_template: commandTemplate,
    command_type: input?.dataset.commandType || undefined,
  };
}

async function refreshCreateAgentCommandProfileControls() {
  const select = document.getElementById('agent-command-profile');
  const input = document.getElementById('agent-cmdtpl');
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const commandTemplate = String(input.value || '').trim();
  const selectedType = input.dataset.commandType || manager?.getById(select.value)?.type || null;
  await populateCommandProfileSelect(select, {
    includeProjectDefault: true,
    projectDefaultLabel: 'Use project default',
    includeCustom: false,
  });
  setCommandProfileSelection(select, commandTemplate, selectedType);
  const selectedProfile = manager?.getById(select.value) || null;
  input.value = selectedProfile?.command || commandTemplate;
  input.dataset.commandType = selectedProfile?.type || selectedType || '';
  updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
}

async function refreshProjectCommandProfileControls() {
  if (!projectData) return;
  const input = document.getElementById('project-cmd');
  const commandTemplate = input?.value || projectData.command_template;
  const commandType = input?.dataset.commandType || projectData.command_type || null;
  await hydrateProjectCommandProfileControls(commandTemplate, commandType);
}

async function refreshVisibleAgentCommandProfileControls() {
  const selects = Array.from(document.querySelectorAll('[id^="ad-cmdprof-"]'));
  if (!selects.length) return;

  const manager = getCommandProfileManager();
  for (const select of selects) {
    const agentId = select.id.slice('ad-cmdprof-'.length);
    const input = document.getElementById(`ad-cmdtpl-${agentId}`);
    if (!input) continue;

    const existingAgent = agentsData.find((agent) => agent.id === agentId);
    const commandTemplate = String(input.value || '').trim();
    const selectedType = input.dataset.commandType || manager?.getById(select.value)?.type || existingAgent?.command_type || null;
    await populateCommandProfileSelect(select, {
      includeProjectDefault: true,
      projectDefaultLabel: 'Use project default',
      includeCustom: false,
    });
    setCommandProfileSelection(select, commandTemplate, selectedType);
    const selectedProfile = manager?.getById(select.value) || null;
    input.value = selectedProfile?.command || commandTemplate;
    input.dataset.commandType = selectedProfile?.type || selectedType || '';
    updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
  }
}

window.addEventListener('agentopia:command-profiles-changed', () => {
  refreshProjectCommandProfileControls().catch((error) => {
    console.error('Failed to refresh project command profile controls', error);
  });
  refreshCreateAgentCommandProfileControls().catch((error) => {
    console.error('Failed to refresh create-agent command profile controls', error);
  });
  refreshVisibleAgentCommandProfileControls().catch((error) => {
    console.error('Failed to refresh agent command profile controls', error);
  });
});

function getDisplayParentAgent(agent) {
  if (!agent?.parent_agent_id) return null;
  return getAgentMap().get(agent.parent_agent_id) || null;
}

function getGraphParentId(agent) {
  if (!agent) return null;
  const byId = getAgentMap();
  if (agent.parent_agent_id && byId.has(agent.parent_agent_id)) return agent.parent_agent_id;
  const controller = getControllerAgent();
  if (controller && !agent.is_controller && controller.id !== agent.id) {
    return controller.id;
  }
  return null;
}


function renderPermissionBadge(meta) {
  return `<span class="permission-badge permission-${meta.tone}" title="${esc(meta.summary)}">${meta.badge}</span>`;
}

function applyProjectManageState() {
  if (!projectData) return;

  const canManage = canManageProject();
  const meta = getProjectAccessMeta(projectData);
  const manageIds = ['btn-toggle', 'btn-trigger', 'btn-delete-project', 'btn-share-project', 'btn-save-overview', 'btn-new-agent', 'btn-new-issue', 'btn-new-knowledge'];
  manageIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = canManage ? '' : 'none';
  });

  const overviewIds = ['project-name-edit', 'project-desc-edit', 'project-task', 'project-cmd', 'project-cmd-profile'];
  overviewIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !canManage;
  });

  const headerActions = document.getElementById('project-manage-actions');
  if (headerActions) headerActions.style.display = canManage ? 'flex' : 'none';

  const readonlyBanner = document.getElementById('project-readonly-banner');
  if (readonlyBanner) {
    readonlyBanner.style.display = canManage ? 'none' : '';
    readonlyBanner.textContent = canManage ? '' : meta.detail;
  }

  const overviewReadonlyHint = document.getElementById('project-overview-readonly-hint');
  if (overviewReadonlyHint) {
    overviewReadonlyHint.style.display = canManage ? 'none' : '';
    overviewReadonlyHint.textContent = canManage ? '' : 'Shared members can view the project overview, but project settings and sharing are read-only.';
  }

  if (projectFilesPanel) {
    projectFilesPanel.setWriteEnabled(canManage);
  }
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

  const membersButton = document.getElementById('btn-view-members');
  if (membersButton) membersButton.textContent = `Members (${memberCount})`;

  const debugNote = document.getElementById('project-debug-note');
  if (debugNote) {
    debugNote.style.display = meta.tone === 'debug' ? '' : 'none';
    debugNote.textContent = meta.tone === 'debug' ? meta.detail : '';
  }
}

function mergeOwnerIntoMembers(members) {
  const normalized = Array.isArray(members) ? [...members] : [];
  if (projectData?.owner?.id && !normalized.some((member) => member.user_id === projectData.owner.id)) {
    normalized.unshift({
      id: `owner-${projectData.owner.id}`,
      user_id: projectData.owner.id,
      username: projectData.owner.username,
      display_name: projectData.owner.display_name,
      user_role: projectData.owner.role,
      role: 'owner',
    });
  }
  return normalized.sort((a, b) => {
    if (a.role === 'owner' && b.role !== 'owner') return -1;
    if (a.role !== 'owner' && b.role === 'owner') return 1;
    return displayProjectUser(a).localeCompare(displayProjectUser(b), 'zh-Hans-CN');
  });
}

function renderProjectMembers() {
  const list = document.getElementById('project-members-list');
  if (!list) return;

  const members = mergeOwnerIntoMembers(projectMembersData);
  if (!members.length) {
    list.innerHTML = '<div class="empty-state">No member information</div>';
    return;
  }

  const canManage = !!projectData?.can_manage;
  const isProjectOwner = (uid) => projectData?.owner?.id === uid;

  list.innerHTML = members.map((member) => {
    const ownerFlag = isProjectOwner(member.user_id);
    const displayName = displayProjectUser(member);
    const encodedDisplayName = encodeURIComponent(displayName);
    const username = member.username ? `@${member.username}` : member.user_id;
    const accountRole = member.user_role === 'admin' ? 'Global Admin' : 'Member';

    const roleBadgeMap = {
      owner: { badge: 'OWNER', tone: 'owner' },
      editor: { badge: 'EDITOR', tone: 'success' },
      member: { badge: 'READ ONLY', tone: 'shared' },
    };
    const rb = roleBadgeMap[member.role] || roleBadgeMap.member;

    // Role selector (only for non-project-owner members, when current user canManage)
    let roleControl;
    if (ownerFlag) {
      roleControl = '<span class="project-member-static">Project Owner</span>';
    } else if (canManage) {
      roleControl = `<select class="member-role-select" onchange="updateMemberRole('${member.user_id}', this.value)" style="padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:12px;">
        <option value="member"${member.role === 'member' ? ' selected' : ''}>Read Only</option>
        <option value="editor"${member.role === 'editor' ? ' selected' : ''}>Editor</option>
        <option value="owner"${member.role === 'owner' ? ' selected' : ''}>Owner</option>
      </select>`;
    } else {
      roleControl = `<span class="project-member-static">${rb.badge}</span>`;
    }

    const removeButton = ownerFlag
      ? ''
      : canManage
        ? `<button class="btn btn-sm" onclick="removeProjectMember('${member.user_id}', '${encodedDisplayName}')" style="color:var(--error)">Remove</button>`
        : '';

    return `
      <div class="project-member-item">
        <div class="project-member-main">
          <div class="project-member-name-row">
            <strong>${esc(displayName)}</strong>
            ${renderPermissionBadge({ badge: rb.badge, tone: rb.tone, summary: rb.badge })}
          </div>
          <div class="project-member-meta">${esc(username)} · ${esc(accountRole)}</div>
        </div>
        <div class="project-member-actions" style="display:flex;align-items:center;gap:8px;">
          ${roleControl}
          ${removeButton}
        </div>
      </div>
    `;
  }).join('');
}

async function loadProjectMembers() {
  if (!projectData) return;

  const list = document.getElementById('project-members-list');
  if (list) list.innerHTML = renderLoading('Loading members...');

  try {
    const res = await fetch(`/api/projects/${projectId}/members`, { headers: apiHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load members');
    }
    const data = await res.json();
    projectMembersData = Array.isArray(data.members) ? data.members : [];
    renderProjectMembers();
  } catch (e) {
    if (list) list.innerHTML = renderError(e, 'loadProjectMembers()');
  }
}

async function openProjectMembersModal(focusShare) {
  if (!projectData) return;

  const meta = getProjectAccessMeta(projectData);
  const canManage = !!projectData.can_manage;
  document.getElementById('projectMembersModal').classList.add('active');

  const subtitle = document.getElementById('project-members-subtitle');
  if (subtitle) subtitle.textContent = `Access: ${meta.summary} · Members ${Number.isFinite(projectData.member_count) ? projectData.member_count : 0}`;

  const readonlyNote = document.getElementById('project-members-readonly-note');
  if (readonlyNote) {
    readonlyNote.style.display = canManage ? 'none' : '';
    readonlyNote.textContent = canManage ? '' : 'You are a shared member. You can view the member list, but cannot add or remove members.';
  }

  const debugHint = document.getElementById('project-members-debug-hint');
  if (debugHint) {
    debugHint.style.display = meta.tone === 'debug' ? '' : 'none';
    debugHint.textContent = meta.tone === 'debug' ? meta.detail : '';
  }

  const managePanel = document.getElementById('project-members-manage-panel');
  if (managePanel) managePanel.style.display = canManage ? '' : 'none';

  await loadProjectMembers();

  if (focusShare && canManage) {
    const input = document.getElementById('project-share-username');
    if (input) input.focus();
  }
}

function statusBadge(s) {
  const map = {
    'open':        '<span class="status-badge status-active">open</span>',
    'in_progress': '<span class="status-badge status-running">in progress</span>',
    'pending':     '<span class="status-badge status-warning">pending</span>',
    'done':        '<span class="status-badge status-completed">done</span>',
    'closed':      '<span class="status-badge status-idle">closed</span>',
  };
  return map[s] || s;
}

// ─── Project ───

async function loadProject(options) {
  let cost = null;
  try {
    projectData = await getProjectDetail(options);
    cost = await getProjectCostSummary(options).catch(() => null);
  } catch (e) {
    showToast('Failed to load project', 'error');
    return;
  }

  document.getElementById('project-name').textContent = projectData.name;
  document.getElementById('project-title').textContent = projectData.name;
  document.getElementById('project-status').textContent = projectData.status;
  document.getElementById('project-status').className = `status-badge status-${projectData.status}`;
  document.title = `Agentopia - ${projectData.name}`;
  renderProjectAccessSummary();
  applyProjectManageState();

  // Editable fields (only set on first load to avoid overwriting user edits)
  if (!window._overviewLoaded) {
    window._overviewLoaded = true;
    document.getElementById('project-name-edit').value = projectData.name;
    document.getElementById('project-desc-edit').value = projectData.description || '';
    document.getElementById('project-task').value = projectData.task_description || '';
    document.getElementById('project-cmd').value = projectData.command_template || '';
    document.getElementById('project-cmd').dataset.commandType = projectData.command_type || '';
    hydrateProjectCommandProfileControls(projectData.command_template, projectData.command_type).catch((error) => {
      console.error('Failed to hydrate project command profile controls', error);
    });
    // Render color picker
    const colorPicker = document.getElementById('project-color-picker');
    const colorInput = document.getElementById('project-color');
    if (colorPicker && colorInput) {
      const currentColor = projectData.color || '#4A90E2';
      colorInput.value = currentColor;
      colorPicker.innerHTML = PROJECT_COLORS.map(c =>
        `<span class="color-swatch${c === currentColor ? ' selected' : ''}" data-color="${c}" style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${c === currentColor ? 'var(--fg)' : 'transparent'};display:inline-block" onclick="selectProjectColor('${c}')"></span>`
      ).join('');
    }
  }
  document.getElementById('project-created').textContent = formatLocalDateTime(projectData.created_at);

  document.getElementById('btn-toggle').innerHTML = projectData.status === 'active' ? '⏸' : '▶';
  document.getElementById('btn-toggle').title = projectData.status === 'active' ? 'Pause' : 'Resume';
  const triggerButton = document.getElementById('btn-trigger');
  if (triggerButton) triggerButton.style.display = projectData.can_manage && projectData.status === 'active' ? '' : 'none';

  updateProjectCostSummary(cost);
}

async function toggleProjectStatus() {
  if (!projectData) return;
  if (!projectData.can_manage) { showToast('Insufficient permission to update project status', 'error'); return; }
  const newStatus = projectData.status === 'active' ? 'paused' : 'active';
  const res = await fetch(`/api/projects/${projectId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: newStatus }) });
  if (res.ok) showToast('Status updated', 'success');
  else showToast('Failed to update status', 'error');
  invalidateProjectResources(['project']);
  loadProject({ force: true });
}

async function triggerController() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to trigger Controller', 'error'); return; }
  const btn = event ? event.target : null;
  const run = async () => {
    const controller = agentsData.find(a => a.is_controller);
    if (!controller) { showToast('No controller agent found', 'error'); return; }
    if (controller.status === 'running') { showToast('Controller is already running', 'error'); return; }
    const res = await fetch(`/api/agents/${controller.id}/start`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) { invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Controller started', 'success'); } else { const err = await res.json().catch(() => ({})); showToast(err.error || 'Failed to start', 'error'); }
  };
  if (btn) await withLoading(btn, run); else await run();
}

function selectProjectColor(color) {
  const colorInput = document.getElementById('project-color');
  if (colorInput) colorInput.value = color;
  document.querySelectorAll('#project-color-picker .color-swatch').forEach(el => {
    el.style.border = el.dataset.color === color ? '3px solid var(--fg)' : '3px solid transparent';
    el.classList.toggle('selected', el.dataset.color === color);
  });
}

async function saveOverview() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to update project settings', 'error'); return; }
  const commandConfig = buildProjectCommandConfigPayload();
  const body = {
    name: document.getElementById('project-name-edit').value.trim(),
    description: document.getElementById('project-desc-edit').value.trim(),
    task_description: document.getElementById('project-task').value.trim(),
    ...commandConfig,
    color: document.getElementById('project-color')?.value || '#4A90E2',
  };
  if (!body.name) { showToast('Name cannot be empty', 'error'); return; }
  if (!body.task_description) { showToast('Task description cannot be empty', 'error'); return; }
  if (!body.command_template) { showToast('Select a command profile in Settings before saving', 'error'); return; }
  const btn = document.querySelector('button[onclick="saveOverview()"]');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/projects/${projectId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) {
      window._overviewLoaded = false;
      invalidateProjectResources(['project', 'costSummary']);
      loadProject({ force: true });
      showToast('Saved', 'success');
    }
    else showToast('Failed to save', 'error');
  });
}

async function deleteProject() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to delete project', 'error'); return; }
  if (!await showConfirm('Delete this project and all agents/issues?')) return;
  const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
  if (res.ok) { showToast('Project deleted', 'success'); window.location.href = '/'; }
  else { showToast('Failed to delete', 'error'); }
}

async function addProjectMember() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to manage sharing', 'error'); return; }

  const input = document.getElementById('project-share-username');
  const roleSelect = document.getElementById('project-share-role');
  const username = input?.value?.trim();
  if (!username) {
    showToast('Please enter a username', 'error');
    return;
  }
  const role = roleSelect?.value || 'member';

  const button = document.getElementById('btn-add-member');
  await withLoading(button, async () => {
    const res = await fetch(`/api/projects/${projectId}/members`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ username, role }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to add member', 'error');
      return;
    }

    if (input) input.value = '';
    showToast('Member added', 'success');
    invalidateProjectResources(['project']);
    await loadProject({ force: true });
    await loadProjectMembers();
  });
}

async function updateMemberRole(userId, newRole) {
  if (!requireProjectManageAccess('Insufficient permission to manage sharing')) return;
  try {
    const res = await fetch(`/api/projects/${projectId}/members/${userId}`, {
      method: 'PATCH',
      headers: apiHeaders(),
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to update role', 'error');
      await loadProjectMembers();
      return;
    }
    const roleLabels = { member: 'Read Only', editor: 'Editor', owner: 'Owner' };
    showToast(`Role updated to ${roleLabels[newRole] || newRole}`, 'success');
    await loadProjectMembers();
  } catch (e) {
    showToast('Failed to update role', 'error');
    await loadProjectMembers();
  }
}

async function removeProjectMember(userId, encodedDisplayName) {
  if (!requireProjectManageAccess('Insufficient permission to manage sharing')) return;
  if (projectData?.owner?.id === userId) {
    showToast('Project owner cannot be removed', 'error');
    return;
  }

  const displayName = decodeURIComponent(encodedDisplayName || '');

  const confirmed = await showConfirm(`Remove ${displayName} from this project?\n\nThey will no longer see this project after removal.`);
  if (!confirmed) return;

  const res = await fetch(`/api/projects/${projectId}/members/${userId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to remove member', 'error');
    return;
  }

  showToast('Member removed', 'success');
  invalidateProjectResources(['project']);
  await loadProject({ force: true });
  await loadProjectMembers();
}

// ─── Agents ───

async function loadAgents(options) {
  const opts = options || {};
  let activeIssues = [];

  try {
    agentsData = await getProjectAgents(opts);
    activeIssues = Array.isArray(opts.activeIssues) ? opts.activeIssues : await getProjectActiveIssues(opts);
  } catch (e) {
    console.error('Failed to load agents', e);
    return;
  }

  syncParentAgentSelect('agent-parent', null, document.getElementById('agent-parent')?.value || '', !canManageProject());
  const list = document.getElementById('agent-list');
  const canManage = canManageProject();

  // Update tab count
  updateTabCounts();

  if (!agentsData.length) { list.innerHTML = '<li class="empty-state">No agents yet.</li>'; return; }

  // Update issue assign dropdown (preserve current selection, default to controller)
  const assignSel = document.getElementById('issue-assign');
  if (assignSel) {
    const prev = assignSel.value;
    const controllerId = agentsData.find(a => a.is_controller)?.id || '';
    assignSel.innerHTML = '<option value="">Select a recipient</option><option value="all">All (broadcast)</option><option value="user">User (me)</option>';
    agentsData.forEach(a => { assignSel.innerHTML += `<option value="${a.id}">${esc(a.name)}${a.is_controller ? ' [controller]' : ''}</option>`; });
    if (prev) assignSel.value = prev;
    else if (controllerId) assignSel.value = controllerId;
  }

  // Fetch active issues (open/in_progress/pending) per agent
  const agentIssues = {};
  for (const iss of activeIssues) {
    if (iss.assigned_to) {
      if (!agentIssues[iss.assigned_to]) agentIssues[iss.assigned_to] = [];
      agentIssues[iss.assigned_to].push(iss);
    }
  }
  window._dashboardIssues = activeIssues;

  // Fetch errors
  const errorLogs = {};
  await Promise.all(agentsData.filter(a => a.status === 'error').map(async (a) => {
    try {
      const r = await fetch(`/api/agents/${a.id}/logs?limit=5`, { headers: apiHeaders() });
      if (r.ok) {
        // Use status API for last_error instead of raw logs
        const sr = await fetch(`/api/agents/${a.id}/status`, { headers: apiHeaders() });
        if (sr.ok) { const st = await sr.json(); errorLogs[a.id] = st.last_error || ''; }
      }
    } catch (e) { console.error('Failed to fetch error logs for agent', a.id, e); }
  }));

  // Error banner for agents in error state
  const errorAgents = agentsData.filter(a => a.status === 'error');
  const bannerEl = document.getElementById('agent-error-banner');
  if (bannerEl) {
    if (errorAgents.length > 0) {
      bannerEl.style.display = '';
      bannerEl.innerHTML = errorAgents.map(a => {
        const errMsg = errorLogs[a.id] ? esc(errorLogs[a.id].slice(0, 300)) : 'Unknown error';
        const retryAction = canManage
          ? `<button class="btn btn-sm" onclick="retryAgent('${a.id}')" style="margin-left:8px;color:var(--warning);padding:2px 8px">Retry</button>`
          : '';
        return `<div style="margin-bottom:4px"><strong>${esc(a.name)}</strong> failed: <span style="font-family:monospace;font-size:11px">${errMsg}</span>${retryAction}</div>`;
      }).join('');
    } else {
      bannerEl.style.display = 'none';
      bannerEl.innerHTML = '';
    }
  }

  // Browser notification for newly errored agents
  if ('Notification' in window && Notification.permission === 'granted') {
    for (const a of errorAgents) {
      if (!window._notifiedErrors) window._notifiedErrors = new Set();
      const key = a.id + ':' + (a.finished_at || '');
      if (!window._notifiedErrors.has(key)) {
        window._notifiedErrors.add(key);
        new Notification('Agentopia: Agent Error', { body: `${a.name} failed. ${(errorLogs[a.id] || '').slice(0, 100)}`, tag: 'agentopia-error-' + a.id });
      }
    }
  }

  // Render a single agent list item
  function renderAgentItem(a, depth) {
    const indent = depth * 20;
    const tag = a.is_controller ? ' <span style="color:var(--accent);font-size:11px">[controller]</span>' : '';
    const parentAgent = getDisplayParentAgent(a);
    const childAgents = getDirectChildAgents(a.id);
    const hierarchyMeta = depth > 0 ? '' : [
      parentAgent ? `Parent ${esc(parentAgent.name)}` : null,
      childAgents.length > 0 ? `${childAgents.length} direct reports` : null,
    ].filter(Boolean).join(' · ');
    const errBox = a.status === 'error' && errorLogs[a.id]
      ? `<div style="margin-top:4px;padding:6px 8px;background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.3);border-radius:4px;font-size:11px;color:var(--error);font-family:monospace;max-height:60px;overflow:auto;white-space:pre-wrap">${esc(errorLogs[a.id].slice(0, 500))}</div>` : '';
    const spinner = a.status === 'running' ? '<span class="thinking-spinner">✦</span> ' : '';
    const deleteBtn = canManage && !a.is_controller && a.status !== 'running'
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();deleteAgent('${a.id}')" style="color:var(--error);padding:3px 6px" title="Delete">✕</button>` : '';
    const retryBtn = canManage && a.status === 'error' && a.has_last_prompt && !a.paused
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();retryAgent('${a.id}')" style="color:var(--warning);padding:3px 6px" title="Retry last prompt">Retry</button>` : '';
    const pauseBtn = canManage && !a.paused
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();pauseAgent('${a.id}')" style="color:var(--warning);padding:3px 6px" title="Pause agent">⏸</button>`
      : canManage
        ? `<button class="btn btn-sm" onclick="event.stopPropagation();unpauseAgent('${a.id}')" style="color:var(--success);padding:3px 6px" title="Resume agent">▶</button>`
        : '';
    const chatBtn = canManage
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();openTerminal('${a.id}')" style="padding:3px 6px" title="Open terminal chat">Chat</button>`
      : '';
    let actions;
    if (!canManage) {
      actions = '';
    } else if (a.paused) {
      actions = `${chatBtn}${pauseBtn}${deleteBtn}`;
    } else if (a.status === 'running') {
      actions = `${chatBtn}${pauseBtn}<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();stopAgentById('${a.id}')">Stop</button>`;
    } else {
      actions = `${chatBtn}${pauseBtn}${retryBtn}<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();quickStartAgent('${a.id}')">Start</button>${deleteBtn}`;
    }
    const selected = currentAgentId === a.id ? 'background:var(--selected-bg);' : '';
    const pausedStyle = a.paused ? 'opacity:0.55;' : '';
    return `
    <li class="agent-item" style="cursor:pointer;padding-left:${indent}px;${selected}${pausedStyle}" onclick="viewAgent('${a.id}')">
      <div style="flex-shrink:0;margin-right:8px">${roleAvatarHtml(a.name, 32, projectData?.color)}</div>
      <div class="agent-info">
        <div class="agent-name">${spinner}${esc(a.name)}${tag}</div>
        <div class="agent-role">${esc(a.role)}</div>
        ${hierarchyMeta ? `<div style="margin-top:3px;font-size:10px;color:var(--text-secondary)">${hierarchyMeta}</div>` : ''}
        ${(agentIssues[a.id] || []).length > 0
          ? `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px">${(agentIssues[a.id] || []).map(iss => {
              const isActive = iss.status === 'in_progress';
              const bg = isActive ? 'rgba(63,185,80,0.15)' : 'rgba(88,166,255,0.1)';
              const border = isActive ? 'rgba(63,185,80,0.4)' : 'rgba(88,166,255,0.3)';
              const color = isActive ? 'var(--success, #3fb950)' : 'var(--accent)';
              const dot = isActive ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--success, #3fb950);margin-right:3px;animation:pulse 1.5s infinite"></span>' : '';
              return `<a href="/issues/${iss.id}" onclick="event.stopPropagation()" style="display:inline-flex;align-items:center;padding:2px 6px;background:${bg};border:1px solid ${border};border-radius:3px;font-size:10px;color:${color};text-decoration:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="#${iss.number} ${esc(iss.title)} [${iss.status}]">${dot}#${iss.number} ${esc(iss.title)}</a>`;
            }).join('')}</div>`
          : (a.status !== 'error' ? '<div style="margin-top:2px;font-size:10px;color:var(--text-secondary);opacity:0.5">Idle - no active tasks</div>' : '')}
        ${errBox}
      </div>
      <div class="flex" style="gap:8px">
        <span class="status-badge status-${a.paused ? 'paused' : a.status}">${a.paused ? 'paused' : a.status}</span>
        ${actions}
      </div>
    </li>`;
  }

  // Tree rendering: recursively render agents by parent-child hierarchy
  const rendered = new Set();
  function renderAgentTree(parentId, depth) {
    let html = '';
    const children = agentsData.filter(a => (a.parent_agent_id || null) === parentId);
    for (const a of children) {
      if (rendered.has(a.id)) continue;
      rendered.add(a.id);
      html += renderAgentItem(a, depth);
      html += renderAgentTree(a.id, depth + 1);
    }
    return html;
  }
  let treeHtml = renderAgentTree(null, 0);
  // Render any orphaned agents (parent_agent_id points to non-existent agent)
  for (const a of agentsData) {
    if (!rendered.has(a.id)) {
      rendered.add(a.id);
      treeHtml += renderAgentItem(a, 0);
    }
  }
  list.innerHTML = treeHtml;

  renderAgentGraph();
  syncProjectFilesAgents();
  loadOrchestrationRuns();
}

let currentAgentId = null;

function startAgentOutputPolling(agentId) {
  stopAgentOutputPolling();
  if (!agentId) return;
  agentOutputPollingAgentId = agentId;
  agentOutputPollTimer = setInterval(() => {
    const agentsTab = document.getElementById('tab-agents');
    if (!currentAgentId || currentAgentId !== agentId || !agentsTab || agentsTab.style.display === 'none') return;
    loadAgentOutput(agentId, { silent: true });
  }, AGENT_OUTPUT_POLL_MS);
}

function stopAgentOutputPolling() {
  if (agentOutputPollTimer) clearInterval(agentOutputPollTimer);
  agentOutputPollTimer = null;
  agentOutputPollingAgentId = null;
  agentOutputRefreshInFlight = false;
}

async function viewAgent(agentId) {
  currentAgentId = agentId;
  // Highlight selected in list
  document.querySelectorAll('#agent-list .agent-item').forEach(li => li.style.background = '');
  event?.target?.closest?.('.agent-item')?.style && (event.target.closest('.agent-item').style.background = 'var(--selected-bg)');

  const el = document.getElementById('agent-detail');
  el.style.display = '';
  el.innerHTML = '<div class="card">' + renderLoading('Loading agent details...') + '</div>';

  try {
    const agentRes = await fetch(`/api/agents/${agentId}`, { headers: apiHeaders() });
    const agent = agentRes.ok ? await agentRes.json() : agentsData.find(a => a.id === agentId);
    const canManage = canManageProject();
    const parentAgent = getDisplayParentAgent(agent);
    const childAgents = getDirectChildAgents(agentId);
    const readOnlyAttr = canManage ? '' : 'disabled';
    const readonlyNote = canManage
      ? ''
      : `<div class="project-readonly-banner" style="display:block;margin-bottom:16px">This is a shared read-only view. You cannot start, pause, retry, delete, chat with, or edit this agent.</div>`;
    const detailActions = canManage
      ? `
              <button class="btn btn-sm" onclick="openTerminal('${agentId}')" title="Open terminal chat">Chat</button>
              ${agent.status === 'error' && agent.last_prompt ? `<button class="btn btn-sm" onclick="retryAgent('${agentId}')" style="color:var(--warning)">Retry</button>` : ''}
      `
      : '';
    const saveSettingsButton = canManage
      ? '<button class="btn btn-primary" onclick="saveAllAgentFields(\'' + agentId + '\')">Save Settings</button>'
      : '';

    const L = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:4px';
    const B = 'padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px';

    // Step 1: Render config immediately (no logs yet)
    el.innerHTML = `
      <div class="card" style="padding:0">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
          <div class="flex-between">
            <h3 style="display:flex;align-items:center;gap:8px">${roleAvatarHtml(agent.name, 28, projectData?.color)} ${esc(agent.name)} ${agent.is_controller ? '<span style="color:var(--accent);font-size:12px">[controller]</span>' : ''}</h3>
            <div class="flex" style="gap:6px">
              ${detailActions}
              <span class="status-badge status-${agent.status}">${agent.status}${agent.pid ? ' (PID:' + agent.pid + ')' : ''}</span>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${esc(agent.role)}</div>
        </div>

        <div id="agent-detail-scroll" style="padding:16px 20px">
          ${readonlyNote}
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(120px, 1fr));gap:8px 16px;font-size:12px;color:var(--text-secondary);margin-bottom:16px">
            <div>Started: <span style="color:var(--fg)">${formatLocalDateTime(agent.started_at)}</span></div>
            <div>Finished: <span style="color:var(--fg)">${formatLocalDateTime(agent.finished_at)}</span></div>
            <div>Session: <code style="color:var(--fg);font-size:10px">${agent.session_id ? agent.session_id.slice(0, 8) + '...' : 'none'}</code></div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:12px;margin-bottom:16px">
            <div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
              <div style="${L}">Direct Parent</div>
              <div style="font-size:13px;color:var(--fg)">${parentAgent ? esc(parentAgent.name) : 'None'}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${parentAgent ? 'Messages are limited to this parent and direct reports.' : 'Without a parent, this agent is not restricted by hierarchy messaging rules.'}</div>
            </div>
            <div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
              <div style="${L}">Direct Reports</div>
              <div style="font-size:13px;color:var(--fg)">${childAgents.length > 0 ? childAgents.map((child) => esc(child.name)).join(', ') : 'None'}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${childAgents.length > 0 ? `${childAgents.length} direct reports total.` : 'This agent has no direct reports.'}</div>
            </div>
          </div>

          <div id="agent-git-status-${agentId}" style="margin-bottom:16px"></div>

          <div id="agent-cost-${agentId}" style="margin-bottom:16px"></div>

          <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="${L}">Working Directory</div>
              <input type="text" id="ad-workdir-${agentId}" value="${esc(agent.working_directory || '')}" placeholder="(default)" ${readOnlyAttr} style="${B};width:100%;font-size:12px;font-family:monospace;color:var(--fg)">
            </div>
            <div style="flex:1;min-width:200px">
              <div style="${L}">Tool Path</div>
              <select id="ad-cmdprof-${agentId}" onchange="handleAgentCommandProfileChange('${agentId}')" ${readOnlyAttr} style="${B};width:100%;font-size:12px;color:var(--fg)">
                <option value="">Loading...</option>
              </select>
              <input type="hidden" id="ad-cmdtpl-${agentId}" value="${esc(agent.command_template || '')}">
              <div id="ad-cmdtpl-preview-${agentId}" style="font-size:10px;color:var(--text-secondary);opacity:0.6;margin-top:2px">Saved profiles populate both command and command type.</div>
            </div>
            <div style="width:140px">
              <div style="${L}">Max Cache Tokens</div>
              <input type="number" id="ad-maxtokens-${agentId}" value="${agent.session_max_tokens ?? 200000}" min="0" ${readOnlyAttr} style="${B};width:80px;font-size:12px;color:var(--fg);text-align:center">
              <div style="font-size:10px;color:var(--text-secondary);opacity:0.6;margin-top:2px">0 = run-count mode</div>
            </div>
            <div style="width:120px">
              <div style="${L}">Max Runs/Session</div>
              <input type="number" id="ad-maxruns-${agentId}" value="${agent.session_max_runs ?? 10}" min="1" ${readOnlyAttr} style="${B};width:60px;font-size:12px;color:var(--fg);text-align:center">
            </div>
            <div style="width:140px">
              <div style="${L}">Resume Timeout(s)</div>
              <input type="number" id="ad-resumetimeout-${agentId}" value="${agent.session_resume_timeout ?? 300}" min="0" ${readOnlyAttr} style="${B};width:80px;font-size:12px;color:var(--fg);text-align:center">
              <div style="font-size:10px;color:var(--text-secondary);opacity:0.6;margin-top:2px">0 = unlimited</div>
            </div>
            <div style="min-width:220px;flex:1">
              <div style="${L}">Parent Agent</div>
              <select id="ad-parent-${agentId}" ${!canManage || agent.is_controller ? 'disabled' : ''} style="${B};width:100%;font-size:12px;color:var(--fg)">
                ${buildParentAgentOptions(agentId, agent.parent_agent_id)}
              </select>
              <div style="font-size:10px;color:var(--text-secondary);opacity:0.6;margin-top:2px">${agent.is_controller ? 'The controller stays at the root by default.' : 'You cannot choose this agent or its descendants as the parent.'}</div>
            </div>
          </div>

          <div style="margin-bottom:16px">
            <div style="${L}">Custom Instructions</div>
            <textarea id="ad-instructions-${agentId}" rows="3" ${readOnlyAttr} style="${B};width:100%;font-size:12px;font-family:inherit;color:var(--fg);resize:vertical" placeholder="Extra instructions appended to system prompt...">${esc(agent.custom_instructions || '')}</textarea>
          </div>

          <div style="margin-bottom:16px;text-align:right">
            ${saveSettingsButton}
          </div>

          <div style="margin-bottom:16px">
            <div style="${L};cursor:pointer;user-select:none" onclick="toggleAgentSystemPrompt('${agentId}')">
              <span id="agent-sysprompt-arrow-${agentId}">▶</span> System Prompt (auto-generated)
            </div>
            <pre id="agent-sysprompt-${agentId}" style="display:none;${B};font-size:11px;max-height:400px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary);margin:0"></pre>
          </div>

          <div style="margin-bottom:16px">
            <div style="${L};cursor:pointer;user-select:none" onclick="toggleRunHistory('${agentId}')">
              <span id="agent-runs-arrow-${agentId}">▶</span> Run History
            </div>
            <div id="agent-runs-${agentId}" style="display:none"></div>
          </div>

          <div>
            <div style="${L}">History</div>
            <div id="agent-output-${agentId}" style="color:var(--text-secondary);font-size:12px">Loading output...</div>
          </div>
        </div>
      </div>
    `;

    // Step 2: Load cost, git status, and logs async (doesn't block config display)
    loadAgentCost(agentId);
    loadAgentGitStatus(agentId);
    loadAgentOutput(agentId);
    startAgentOutputPolling(agentId);
    hydrateAgentCommandProfileControls(agentId, agent);

  } catch (e) {
    stopAgentOutputPolling();
    el.innerHTML = '<div class="card">' + renderError(e, 'viewAgent(\'' + agentId + '\')') + '</div>';
  }
}

async function loadAgentCost(agentId) {
  const container = document.getElementById('agent-cost-' + agentId);
  if (!container) return;
  try {
    const res = await fetch(`/api/agents/${agentId}/costs`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    if (data.total_runs === 0) { container.innerHTML = ''; return; }

    const fmtCostAgent = v => v > 0 ? (v < 0.01 ? '<$0.01' : '$' + v.toFixed(2)) : 'N/A';
    const fmtTokens = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;
    const avgCost = data.total_runs > 0 ? data.total_cost_usd / data.total_runs : 0;

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:12px">
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Total Cost</div>
          <div style="font-size:16px;font-weight:600;color:var(--accent)">${fmtCostAgent(data.total_cost_usd)}</div>
        </div>
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Avg/Run</div>
          <div style="font-size:16px;font-weight:600">${fmtCostAgent(avgCost)}</div>
        </div>
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Runs</div>
          <div style="font-size:16px;font-weight:600">${data.total_runs}</div>
        </div>
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Tokens</div>
          <div style="font-size:14px;font-weight:600">${fmtTokens(data.total_input_tokens)}↑ ${fmtTokens(data.total_output_tokens)}↓</div>
        </div>
      </div>`;
  } catch {
    container.innerHTML = '';
  }
}

async function loadAgentGitStatus(agentId) {
  const container = document.getElementById('agent-git-status-' + agentId);
  if (!container) return;
  try {
    const res = await fetch(`/api/agents/${agentId}/git-status`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    if (!data.branch) { container.innerHTML = ''; return; }

    const lastCommit = data.recent_commits && data.recent_commits[0]
      ? `<code style="color:var(--accent)">${esc(data.recent_commits[0].hash)}</code> ${esc(data.recent_commits[0].message.slice(0, 50))} <span style="color:var(--text-secondary)">${timeAgo(data.recent_commits[0].date)}</span>`
      : '<span style="color:var(--text-secondary)">no commits</span>';
    const uncommitted = data.has_uncommitted
      ? `<span style="color:var(--warning)"> | ${(data.uncommitted_files || []).length} uncommitted files</span>` : '';

    container.innerHTML = `
      <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;word-break:break-word;overflow-wrap:break-word">
        <span style="font-family:monospace;background:var(--card);padding:2px 8px;border-radius:10px;border:1px solid var(--border)">${esc(data.branch)}</span>
        <span style="margin-left:8px">Last commit: ${lastCommit}</span>${uncommitted}
      </div>`;
  } catch {
    container.innerHTML = '';
  }
}

async function loadAgentOutput(agentId, options) {
  const opts = options || {};
  const container = document.getElementById('agent-output-' + agentId);
  if (!container) return;
  if (opts.silent && agentOutputRefreshInFlight) return;
  agentOutputRefreshInFlight = true;
  try {
    const logsRes = await fetch(`/api/agents/${agentId}/logs?limit=100`, { headers: apiHeaders() });
    const logs = logsRes.ok ? await logsRes.json() : [];
    logs.reverse();

    // Group by run, only show last 3 runs
    const runs = [];
    let curRun = null;
    for (const l of logs) {
      if (l.run_id !== curRun) { curRun = l.run_id; runs.push({ id: l.run_id, logs: [] }); }
      runs[runs.length - 1].logs.push(l);
    }
    // Show last 5 runs, oldest first (newest at bottom)
    const recentRuns = runs.slice(-5);

    const html = recentRuns.map((run, idx) => {
      const filtered = run.logs.filter(l =>
        l.stream !== 'cost' && !l.content.includes('proxychains') &&
        !l.content.includes('Executing through proxy') && !l.content.includes('Port 7897')
      );
      if (!filtered.length) return '';
      const content = filtered.map(l => {
        const ts = l.created_at ? `<span style="color:var(--text-secondary);opacity:0.7;cursor:default" title="${esc(formatLocalDateTime(l.created_at))}">[${esc(formatLocalTime(l.created_at))}]</span> ` : '';
        if (l.stream === 'stdin') {
          const inputHtml = renderCollapsibleText(l.content, { previewChars: 240, style: 'display:flex;width:100%;margin-top:4px' });
          return `<div style="background:var(--accent-bg, rgba(59,130,246,0.08));border-left:3px solid var(--accent);padding:4px 8px;margin:4px 0;border-radius:0 4px 4px 0">${ts}<span style="color:var(--accent);font-weight:600">▶ INPUT</span><div>${inputHtml}</div></div>`;
        }
        const text = l.content.length > 1500 ? l.content.slice(0, 1500) + '\n... (truncated)' : l.content;
        const msg = l.stream === 'stderr' ? `<span style="color:var(--error)">${esc(text)}</span>` : esc(text);
        return ts + msg;
      }).join('');
      const label = idx === recentRuns.length - 1 ? 'Latest Run' : `${recentRuns.length - idx} runs ago`;
      return `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:600;color:var(--text-secondary);margin-bottom:2px">${label}</div><div>${content}</div></div>`;
    }).filter(Boolean).join('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');

    const nextHtml = html
      ? `<div style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-word;margin:0;line-height:1.5;overflow-x:hidden;max-height:400px;overflow-y:auto">${html}</div>`
      : '<span style="color:var(--text-secondary)">No history yet.</span>';

    const prevScroller = container.firstElementChild;
    const prevScrollTop = prevScroller ? prevScroller.scrollTop : 0;
    const wasNearBottom = prevScroller
      ? (prevScroller.scrollHeight - prevScroller.clientHeight - prevScroller.scrollTop) < 24
      : true;

    if (container.innerHTML !== nextHtml) {
      container.innerHTML = nextHtml;
      const scroller = container.firstElementChild;
      if (scroller) {
        if (wasNearBottom || !opts.silent) scroller.scrollTop = scroller.scrollHeight;
        else scroller.scrollTop = prevScrollTop;
      }
    }
  } catch {
    if (!opts.silent) {
      container.innerHTML = renderError(null, 'loadAgentOutput(\'' + agentId + '\')');
    }
  } finally {
    agentOutputRefreshInFlight = false;
  }
}

async function saveAllAgentFields(agentId) {
  if (!requireProjectManageAccess('Insufficient permission to update agent settings')) return;
  const btn = document.querySelector(`button[onclick="saveAllAgentFields('${agentId}')"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    const instructionsVal = document.getElementById('ad-instructions-' + agentId).value;
    const maxTokensRaw = parseInt(document.getElementById('ad-maxtokens-' + agentId).value, 10);
    const maxRunsRaw = parseInt(document.getElementById('ad-maxruns-' + agentId).value, 10);
    const resumeTimeoutRaw = parseInt(document.getElementById('ad-resumetimeout-' + agentId).value, 10);
    const parentAgentId = document.getElementById('ad-parent-' + agentId)?.value || null;
    const commandConfig = buildAgentCommandConfigPayload('ad-cmdprof-' + agentId, 'ad-cmdtpl-' + agentId);
    const body = {
      working_directory: document.getElementById('ad-workdir-' + agentId).value || null,
      ...commandConfig,
      parent_agent_id: parentAgentId,
      session_max_tokens: Number.isNaN(maxTokensRaw) ? 200000 : Math.max(0, maxTokensRaw),
      session_max_runs: Number.isNaN(maxRunsRaw) ? 10 : Math.max(1, maxRunsRaw),
      session_resume_timeout: Number.isNaN(resumeTimeoutRaw) ? 0 : Math.max(0, resumeTimeoutRaw),
      custom_instructions: instructionsVal.trim() === '' ? null : instructionsVal
    };
    const res = await fetch(`/api/agents/${agentId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) {
      invalidateProjectResources(['agents']);
      await loadAgents({ force: true });
      await viewAgent(agentId);
      showToast('Saved', 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to save', 'error');
    }
  } catch (e) {
    console.error('Failed to save agent fields', e);
    showToast('Failed to save: network error', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Settings'; }
  }
}

async function toggleAgentSystemPrompt(agentId) {
  const el = document.getElementById('agent-sysprompt-' + agentId);
  const arrow = document.getElementById('agent-sysprompt-arrow-' + agentId);
  if (!el) return;
  if (el.style.display !== 'none') {
    el.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
    return;
  }
  el.style.display = '';
  if (arrow) arrow.textContent = '▼';
  if (el.textContent) return;
  el.innerHTML = renderLoading('', true);
  try {
    const res = await fetch(`/api/agents/${agentId}/system-prompt`, { headers: apiHeaders() });
    if (res.ok) { const data = await res.json(); el.textContent = data.prompt; }
    else { el.innerHTML = renderError({ status: res.status }); }
  } catch (e) { el.innerHTML = renderError(e); }
}

async function toggleRunHistory(agentId) {
  const el = document.getElementById('agent-runs-' + agentId);
  const arrow = document.getElementById('agent-runs-arrow-' + agentId);
  if (!el) return;
  if (el.style.display !== 'none') {
    el.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
    return;
  }
  el.style.display = '';
  if (arrow) arrow.textContent = '▼';
  if (el.innerHTML) return;
  el.innerHTML = renderLoading('Loading runs...', true);
  await loadRunHistory(agentId);
}

async function loadRunHistory(agentId) {
  const container = document.getElementById('agent-runs-' + agentId);
  if (!container) return;
  try {
    const res = await fetch(`/api/agents/${agentId}/runs?limit=10`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = renderError({ status: res.status }, 'loadRunHistory(\'' + agentId + '\')'); return; }
    const data = await res.json();
    const runs = data.runs || [];
    if (!runs.length) { container.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">No runs yet.</span>'; return; }

    const fmtCost = v => v > 0 ? (v < 0.01 ? '<$0.01' : '$' + v.toFixed(2)) : '';
    const fmtTokens = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;
    const fmtDur = ms => {
      if (!ms) return '-';
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    };

    container.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">${runs.map((r, idx) => {
      const statusColor = r.status === 'error' ? 'var(--error)' : 'var(--success)';
      const statusIcon = r.status === 'error' ? '✕' : '✓';
      const costLabel = r.cost_usd > 0 ? fmtCost(r.cost_usd) : (r.input_tokens > 0 || r.output_tokens > 0 ? fmtTokens(r.input_tokens) + '↑' + fmtTokens(r.output_tokens) + '↓' : '-');
      return `<div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer" onclick="viewRunReport('${agentId}','${r.run_id}')">
        <div style="display:flex;align-items:center;gap:10px;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:${statusColor};font-weight:600">${statusIcon}</span>
            <span style="color:var(--text-secondary)">${timeAgo(r.started_at)}</span>
          </div>
          <div style="display:flex;gap:12px;color:var(--text-secondary);font-size:11px">
            <span title="Tools">\u{1F527} ${r.tool_call_count}</span>
            <span title="${r.cost_usd > 0 ? 'Cost' : 'Tokens'}">${costLabel}</span>
            <span title="Duration">${fmtDur(r.duration_ms)}</span>
          </div>
        </div>
        ${r.result_snippet ? `<div style="margin-top:4px;color:var(--fg);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.result_snippet.slice(0, 120))}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  } catch {
    container.innerHTML = renderError(null, 'loadRunHistory(\'' + agentId + '\')');
  }
}

async function viewRunReport(agentId, runId) {
  const container = document.getElementById('agent-runs-' + agentId);
  if (!container) return;
  container.innerHTML = renderLoading('Loading report...', true);
  try {
    const res = await fetch(`/api/agents/${agentId}/runs/${runId}/report`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = renderError({ status: res.status }, 'viewRunReport(\'' + agentId + '\',\'' + runId + '\')'); return; }
    const r = await res.json();

    const fmtCost = v => v > 0 ? (v < 0.01 ? '<$0.01' : '$' + v.toFixed(4)) : 'N/A';
    const fmtTokens = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);
    const fmtDur = ms => {
      if (!ms) return '-';
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    };
    const statusColor = r.status === 'error' ? 'var(--error)' : 'var(--success)';

    // Tool frequency
    const toolFreqHtml = Object.entries(r.summary.tool_frequency || {})
      .sort((a, b) => (b[1]) - (a[1]))
      .map(([name, count]) => `<span style="padding:2px 8px;background:rgba(88,166,255,0.1);border:1px solid rgba(88,166,255,0.3);border-radius:12px;font-size:10px">${esc(name)} ×${count}</span>`)
      .join(' ');

    // File changes
    const filesHtml = (r.summary.files_changed || []).map(f =>
      `<div style="font-family:monospace;font-size:11px;padding:2px 0">${esc(f)}</div>`
    ).join('') || '<span style="color:var(--text-secondary)">None</span>';

    // Tool call timeline
    const toolsHtml = (r.tool_calls || []).map((tc, i) => {
      const inputHtml = renderCollapsibleText(tc.input, { previewChars: 100, style: 'width:100%' });
      return `<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:11px">
        <div style="display:flex;gap:6px;align-items:flex-start">
          <span style="color:var(--accent);font-weight:600;min-width:20px">${i + 1}.</span>
          <span style="color:var(--accent);font-weight:500">${esc(tc.name)}</span>
          <div style="min-width:0;flex:1;color:var(--text-secondary);font-family:monospace">${inputHtml}</div>
        </div>
        ${tc.result ? `<div style="margin-left:26px;color:var(--text-secondary);font-family:monospace;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px">${esc(tc.result.slice(0, 150))}</div>` : ''}
      </div>`;
    }).join('');

    container.innerHTML = `
      <div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <button class="btn btn-sm" onclick="loadRunHistory('${agentId}')" style="font-size:11px">← Back to runs</button>
          <span style="color:${statusColor};font-weight:600">${r.status === 'error' ? 'Failed' : 'Success'}</span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Duration</div>
            <div style="font-size:14px;font-weight:600">${fmtDur(r.cost?.duration_ms)}</div>
          </div>
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Cost</div>
            <div style="font-size:14px;font-weight:600;color:var(--accent)">${r.cost ? fmtCost(r.cost.total_usd) : '-'}</div>
          </div>
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Tools</div>
            <div style="font-size:14px;font-weight:600">${r.summary.total_tool_calls}</div>
          </div>
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Tokens</div>
            <div style="font-size:14px;font-weight:600">${r.cost ? fmtTokens(r.cost.input_tokens) + '↑ ' + fmtTokens(r.cost.output_tokens) + '↓' : '-'}</div>
          </div>
        </div>

        ${r.error_message ? `<div style="margin-bottom:12px;padding:8px;background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.3);border-radius:4px;font-size:11px;color:var(--error);font-family:monospace;white-space:pre-wrap">${esc(r.error_message.slice(0, 500))}</div>` : ''}

        ${toolFreqHtml ? `<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Tool Usage</div><div style="display:flex;gap:6px;flex-wrap:wrap">${toolFreqHtml}</div></div>` : ''}

        ${r.summary.files_changed.length > 0 ? `<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Files Changed (${r.summary.files_changed.length})</div>${filesHtml}</div>` : ''}

        ${r.final_result ? `<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Final Result</div><pre style="padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0;max-height:200px;overflow-y:auto">${esc(r.final_result.slice(0, 1000))}</pre></div>` : ''}

        ${toolsHtml ? `<div><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Tool Call Timeline (${r.tool_calls.length})</div><div style="max-height:300px;overflow-y:auto">${toolsHtml}</div></div>` : ''}
      </div>`;
  } catch (e) {
    container.innerHTML = renderError(e, 'viewRunReport(\'' + agentId + '\',\'' + runId + '\')');
  }
}

function closeAgentDetail() {
  console.log('closeAgentDetail called');
  stopAgentOutputPolling();
  currentAgentId = null;
  const el = document.getElementById('agent-detail');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  document.querySelectorAll('#agent-list .agent-item').forEach(li => li.style.background = '');
}

async function deleteAgent(id) {
  if (!requireProjectManageAccess('Insufficient permission to delete agent')) return;
  const agent = agentsData.find(a => a.id === id);
  if (!await showConfirm(`Delete agent "${agent?.name || id}"?`)) return;
  const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
  if (res.ok) {
    if (currentAgentId === id) closeAgentDetail();
    invalidateProjectResources(['agents']);
    loadAgents({ force: true }); showToast('Agent deleted', 'success');
  } else { showToast('Failed to delete', 'error'); }
}

async function retryAgent(id) {
  if (!requireProjectManageAccess('Insufficient permission to retry agent')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/retry`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) { invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent retried', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to retry', 'error'); }
  });
}

function openTerminal(agentId) {
  if (!requireProjectManageAccess('Insufficient permission to open the agent terminal')) return;
  window.location.href = `/terminal?agentId=${agentId}&newSession=true`;
}

async function quickStartAgent(id) {
  if (!requireProjectManageAccess('Insufficient permission to start agent')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/start`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) { invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent started', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to start', 'error'); }
  });
}
async function pauseAgent(id) {
  if (!requireProjectManageAccess('Insufficient permission to pause agent')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/pause`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent paused', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to pause', 'error'); }
  });
}

async function unpauseAgent(id) {
  if (!requireProjectManageAccess('Insufficient permission to resume agent')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/unpause`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent resumed', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to resume', 'error'); }
  });
}

async function stopAgentById(id) {
  if (!requireProjectManageAccess('Insufficient permission to stop agent')) return;
  if (!await showConfirm('Stop this agent?')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/stop`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { showToast('Agent stopped', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to stop', 'error'); }
    invalidateProjectResources(['agents']);
    loadAgents({ force: true });
  });
}

function showCreateAgentModal() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to create agent', 'error'); return; }
  document.getElementById('agent-name').value = '';
  document.getElementById('agent-role').value = '';
  document.getElementById('agent-workdir').value = '';
  const controller = getControllerAgent();
  syncParentAgentSelect('agent-parent', null, controller ? controller.id : '', false);
  document.getElementById('agent-cmdtpl').value = '';
  hydrateCreateAgentCommandProfileControls('', null);
  document.getElementById('createAgentModal').classList.add('active');
}
function hideModal(id) { document.getElementById(id).classList.remove('active'); }

async function createAgent() {
  if (!requireProjectManageAccess('Insufficient permission to create agent')) return;
  const btn = document.querySelector('#createAgentModal button[onclick="createAgent()"]');
  await withLoading(btn, async () => {
    const commandConfig = buildAgentCommandConfigPayload('agent-command-profile', 'agent-cmdtpl');
    const body = {
      name: document.getElementById('agent-name').value,
      role: document.getElementById('agent-role').value,
      working_directory: document.getElementById('agent-workdir').value || undefined,
      parent_agent_id: document.getElementById('agent-parent').value || null,
      ...commandConfig,
    };
    if (!body.name) { showToast('Name is required', 'error'); return; }
    const res = await fetch(`/api/projects/${projectId}/agents`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) { hideModal('createAgentModal'); invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent created', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to create', 'error'); }
  });
}

// ─── Issues ───

let currentIssueFilter = 'open';
let currentIssuePage = 1;

// Restore filter/search state from URL params
(function restoreIssueFilterState() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('status')) currentIssueFilter = params.get('status');
  if (params.has('page')) currentIssuePage = parseInt(params.get('page')) || 1;
  if (params.has('q')) {
    setTimeout(() => {
      const el = document.getElementById('issue-search');
      if (el) el.value = params.get('q');
    }, 0);
  }
})();

function updateIssueUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const q = document.getElementById('issue-search')?.value?.trim() || '';
  if (currentIssueFilter) params.set('status', currentIssueFilter); else params.delete('status');
  if (q) params.set('q', q); else params.delete('q');
  if (currentIssuePage > 1) params.set('page', currentIssuePage); else params.delete('page');
  const newUrl = params.toString() ? `${window.location.pathname}?${params}${window.location.hash}` : `${window.location.pathname}${window.location.hash}`;
  history.replaceState(null, '', newUrl);
}

function renderActiveFilters() {
  const el = document.getElementById('issue-active-filters');
  if (!el) return;
  const q = document.getElementById('issue-search')?.value?.trim() || '';
  const chips = [];
  if (currentIssueFilter) {
    chips.push(`<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--selected-bg);border-radius:4px;font-size:11px">Status: ${currentIssueFilter} <span onclick="clearIssueFilter()" style="cursor:pointer;opacity:0.6;font-weight:bold" title="Clear">&times;</span></span>`);
  }
  if (q) {
    chips.push(`<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--selected-bg);border-radius:4px;font-size:11px">Search: "${esc(q)}" <span onclick="clearIssueSearch()" style="cursor:pointer;opacity:0.6;font-weight:bold" title="Clear">&times;</span></span>`);
  }
  if (chips.length > 1) {
    chips.push(`<span onclick="clearAllIssueFilters()" style="cursor:pointer;color:var(--accent);font-size:11px;text-decoration:underline">Clear all filters</span>`);
  }
  el.style.display = chips.length ? 'flex' : 'none';
  el.innerHTML = chips.join('');
}

function clearIssueFilter() { currentIssueFilter = ''; currentIssuePage = 1; loadIssues(); }
function clearIssueSearch() {
  const el = document.getElementById('issue-search');
  if (el) el.value = '';
  currentIssuePage = 1;
  loadIssues();
}
function clearAllIssueFilters() {
  currentIssueFilter = '';
  const el = document.getElementById('issue-search');
  if (el) el.value = '';
  currentIssuePage = 1;
  loadIssues();
}

const LABEL_COLORS = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#b5bd68','#cc6666','#8abeb7'];
function issueLabelHtml(text) {
  const h = hashCode(text.trim());
  const bg = LABEL_COLORS[h % LABEL_COLORS.length];
  return `<span style="font-size:10px;padding:1px 6px;border-radius:12px;background:${bg}22;color:${bg};border:1px solid ${bg}44">${esc(text.trim())}</span>`;
}

async function loadIssues() {
  const sort = document.getElementById('issue-sort')?.value || 'priority';
  const q = document.getElementById('issue-search')?.value?.trim() || '';

  // Fetch counts via lightweight endpoint
  const countsRes = await fetch(`/api/projects/${projectId}/issues/counts`, { headers: apiHeaders() });
  const counts = await countsRes.json();
  issueCount = counts.total || 0;
  updateTabCounts();

  // Filter tabs
  const tabs = document.getElementById('issue-filter-tabs');
  if (tabs) {
    const filters = [
      { key: 'open', label: 'Open', count: counts.open, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#3fb950" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#3fb950"/>' },
      { key: 'in_progress', label: 'In Progress', count: counts.in_progress, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#d29922"/>' },
      { key: 'pending', label: 'Pending', count: counts.pending, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2" stroke-dasharray="4 2"/><circle cx="8" cy="8" r="2" fill="#d29922"/>' },
      { key: 'done', label: 'Done', count: counts.done, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
      { key: 'closed', label: 'Closed', count: counts.closed, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="gray" stroke-width="2"/><line x1="5" y1="5" x2="11" y2="11" stroke="gray" stroke-width="1.5"/><line x1="11" y1="5" x2="5" y2="11" stroke="gray" stroke-width="1.5"/>' },
      { key: '', label: 'All', count: counts.total || 0 },
    ];
    tabs.innerHTML = filters.map(f =>
      `<span onclick="setIssueFilter('${f.key}')" style="cursor:pointer;padding:4px 10px;border-radius:6px;${currentIssueFilter===f.key?'background:var(--selected-bg);font-weight:600':'color:var(--text-secondary)'}">
        ${f.icon ? `<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px">${f.icon}</svg>` : ''}
        ${f.count} ${f.label}
      </span>`
    ).join('');
  }

  // Fetch filtered + sorted + paginated
  let url = `/api/projects/${projectId}/issues?sort=${sort}&page=${currentIssuePage}&per_page=30`;
  if (currentIssueFilter) url += `&status=${currentIssueFilter}`;
  if (q) url += `&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: apiHeaders() });
  const data = await res.json();
  const issues = data.issues || [];

  const container = document.getElementById('issue-list');
  if (!issues.length) { container.innerHTML = '<div class="card"><div class="empty-state">No issues.</div></div>'; renderPagination(0, 0); return; }

  container.innerHTML = `<div class="card" style="padding:0">${issues.map(i => {
    const labels = i.labels ? i.labels.split(',').filter(l=>l.trim()).map(l => issueLabelHtml(l)).join(' ') : '';
    const icon = i.status === 'pending'
      ? '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2" stroke-dasharray="4 2"/><circle cx="8" cy="8" r="2" fill="#d29922"/></svg>'
      : (i.status === 'open' || i.status === 'in_progress')
        ? `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="${i.status==='in_progress'?'#d29922':'#3fb950'}" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="${i.status==='in_progress'?'#d29922':'#3fb950'}"/></svg>`
        : '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `<a href="/projects/${projectId}/issues/${i.number}" class="issue-list-item" style="text-decoration:none;color:inherit">
      <div style="flex-shrink:0;margin-top:2px">${icon}</div>
      <div class="issue-main">
        <div class="issue-title-row"><span class="issue-title">${esc(i.title)}</span> ${labels}</div>
        <div class="issue-meta">#${i.number} by ${nameOf(i.created_by)} · ${i.assigned_to ? nameOf(i.assigned_to) : 'unassigned'} · ${timeAgo(i.created_at)}</div>
      </div>
      ${i.comment_count ? `<div style="flex-shrink:0;display:flex;align-items:center;gap:4px;color:var(--text-secondary);font-size:12px" title="${i.comment_count} comments"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.749.749 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>${i.comment_count}</div>` : ''}
      ${i.assigned_to ? `<div style="flex-shrink:0">${(() => { const _ag = agentsData.find(_a => _a.id === i.assigned_to); return _ag ? roleAvatarHtml(_ag.name, 22, projectData?.color) : avatarSvg(nameOf(i.assigned_to), 22); })()}</div>` : ''}
    </a>`;
  }).join('')}</div>`;

  renderPagination(data.total_pages || 1, data.page || 1);
  renderActiveFilters();
  updateIssueUrlParams();
}

function renderPagination(totalPages, currentPage) {
  const el = document.getElementById('issue-pagination');
  if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }
  const btnStyle = 'padding:4px 8px;min-width:28px;';
  const activeStyle = 'background:var(--accent);color:#fff;';
  const disabledStyle = 'opacity:0.4;pointer-events:none;';
  const pageBtn = (p, label) => `<button onclick="goToIssuePage(${p})" class="btn btn-sm" style="${btnStyle}${p===currentPage?activeStyle:''}">${label||p}</button>`;
  let html = '';
  // First + Prev
  html += `<button onclick="goToIssuePage(1)" class="btn btn-sm" style="${btnStyle}${currentPage===1?disabledStyle:''}" title="First page">«</button>`;
  html += `<button onclick="goToIssuePage(${currentPage-1})" class="btn btn-sm" style="${btnStyle}${currentPage===1?disabledStyle:''}" title="Previous page">‹</button>`;
  // Page numbers with ellipsis
  const pages = [];
  if (totalPages <= 9) {
    for (let p = 1; p <= totalPages; p++) pages.push(p);
  } else {
    pages.push(1);
    let start = Math.max(2, currentPage - 2);
    let end = Math.min(totalPages - 1, currentPage + 2);
    if (currentPage <= 4) end = Math.min(6, totalPages - 1);
    if (currentPage >= totalPages - 3) start = Math.max(2, totalPages - 5);
    if (start > 2) pages.push('...');
    for (let p = start; p <= end; p++) pages.push(p);
    if (end < totalPages - 1) pages.push('...');
    pages.push(totalPages);
  }
  for (const p of pages) {
    if (p === '...') { html += `<span style="padding:4px 2px;opacity:0.5">…</span>`; }
    else html += pageBtn(p);
  }
  // Next + Last
  html += `<button onclick="goToIssuePage(${currentPage+1})" class="btn btn-sm" style="${btnStyle}${currentPage===totalPages?disabledStyle:''}" title="Next page">›</button>`;
  html += `<button onclick="goToIssuePage(${totalPages})" class="btn btn-sm" style="${btnStyle}${currentPage===totalPages?disabledStyle:''}" title="Last page">»</button>`;
  // Page info
  html += `<span style="margin-left:8px;font-size:11px;color:var(--text-secondary)">Page ${currentPage} of ${totalPages}</span>`;
  el.innerHTML = html;
}

function goToIssuePage(p) { currentIssuePage = p; loadIssues(); }
function setIssueFilter(f) { currentIssueFilter = f; currentIssuePage = 1; loadIssues(); }
function searchIssues() {
  const q = document.getElementById('issue-search')?.value?.trim() || '';
  if (q) currentIssueFilter = '';  // Clear the status filter while searching to avoid conflicting constraints.
  currentIssuePage = 1;
  loadIssues();
}



const ISSUE_TEMPLATES = {
  bug: { labels: 'bug', body: `## Problem Description\n\n## Steps to Reproduce\n1. \n2. \n\n## Expected Behavior\n\n## Actual Behavior\n` },
  feature: { labels: 'feature', body: `## Background and Motivation\n\n## Requested Feature\n\n## Acceptance Criteria\n` },
};

function applyIssueTemplate(tpl) {
  const t = ISSUE_TEMPLATES[tpl];
  const bodyEl = document.getElementById('issue-body');
  const labelsEl = document.getElementById('issue-labels');
  if (t) {
    bodyEl.value = t.body;
    if (labelsEl && !labelsEl.value) labelsEl.value = t.labels;
  } else {
    bodyEl.value = '';
  }
}

function showCreateIssueModal() {
  if (!requireProjectManageAccess('Insufficient permission to create issue')) return;
  document.getElementById('issue-title').value = '';
  document.getElementById('issue-body').value = '';
  document.getElementById('issue-labels').value = '';
  const projectSel = document.getElementById('issue-project');
  if (projectSel && projectData) {
    projectSel.innerHTML = `<option value="${esc(projectId)}">${esc(projectData.name)}</option>`;
    projectSel.value = projectId;
  }
  const tplSel = document.getElementById('issue-template');
  if (tplSel) tplSel.value = '';
  const sel = document.getElementById('issue-assign');
  if (sel) {
    const controllerId = agentsData.find(a => a.is_controller)?.id || '';
    sel.value = controllerId || '';
  }
  document.getElementById('createIssueModal').classList.add('active');
  const issueBodyTextarea = document.getElementById('issue-body');
  if (issueBodyTextarea) setupMentionAutocomplete(issueBodyTextarea, agentsData);
  document.getElementById('issue-title')?.focus();
}

async function createIssue() {
  if (!requireProjectManageAccess('Insufficient permission to create issue')) return;
  const btn = document.querySelector('#createIssueModal button[onclick="createIssue()"]');
  await withLoading(btn, async () => {
    const assignedTo = document.getElementById('issue-assign').value.trim();
    const body = {
      title: document.getElementById('issue-title').value.trim(),
      body: document.getElementById('issue-body').value.trim(),
      created_by: 'user',
      assigned_to: assignedTo,
      labels: document.getElementById('issue-labels').value.trim() || undefined,
    };
    if (!assignedTo) { showToast('To is required', 'error'); document.getElementById('issue-assign').focus(); return; }
    if (!body.title) { showToast('Subject is required', 'error'); return; }
    const res = await fetch(`/api/projects/${projectId}/issues`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) { hideModal('createIssueModal'); loadIssues(); showToast('Issue created', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to create', 'error'); }
  });
}

// ─── Tabs ───

let issueCount = 0;
async function updateTabCounts() {
  const tabs = document.querySelectorAll('.tab-bar .tab');
  tabs.forEach(t => {
    const text = t.textContent.replace(/\s*\(\d+\)/, '').trim().toLowerCase();
    if (text === 'agents') t.textContent = `Agents (${agentsData.length})`;
    else if (text === 'issues') t.textContent = `Issues (${issueCount})`;
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-bar .tab').forEach(t => {
    if (t.textContent.replace(/\s*\(\d+\)/, '').trim().toLowerCase() === tab) t.classList.add('active');
  });
  document.getElementById('tab-overview').style.display = tab === 'overview' ? '' : 'none';
  document.getElementById('tab-agents').style.display = tab === 'agents' ? '' : 'none';
  document.getElementById('tab-issues').style.display = tab === 'issues' ? '' : 'none';
  document.getElementById('tab-activity').style.display = tab === 'activity' ? '' : 'none';
  document.getElementById('tab-git').style.display = tab === 'git' ? '' : 'none';
  document.getElementById('tab-knowledge').style.display = tab === 'knowledge' ? '' : 'none';
  document.getElementById('tab-files').style.display = tab === 'files' ? '' : 'none';
  document.getElementById('tab-workflow').style.display = tab === 'workflow' ? '' : 'none';
  // Update breadcrumb section
  const sectionNames = { overview: '', agents: 'Agents', issues: 'Issues', activity: 'Activity', git: 'Git', knowledge: 'Knowledge', files: 'Files', workflow: 'Workflow' };
  const sectionEl = document.getElementById('breadcrumb-section');
  if (sectionEl) {
    sectionEl.textContent = sectionNames[tab] ? ' / ' + sectionNames[tab] : '';
  }
  // Update URL hash
  window.location.hash = tab === 'overview' ? '' : tab;
  if (tab === 'agents' && currentAgentId) startAgentOutputPolling(currentAgentId);
  else stopAgentOutputPolling();
  if (tab === 'issues') loadIssues();
  if (tab === 'activity') loadActivity();
  if (tab === 'git') loadGitTab();
  if (tab === 'knowledge') loadKnowledge();
  if (tab === 'files') loadProjectFilesTab();
  if (tab === 'workflow') loadWorkflowTab();
}

function ensureProjectFilesPanel() {
  if (projectFilesPanel || !window.AgentopiaFilesPanel) return;
  projectFilesPanel = window.AgentopiaFilesPanel.create({
    publicApiName: 'ProjectFiles',
    shellId: 'project-files-shell',
    treeId: 'project-file-tree',
    rootLabelId: 'project-files-root-label',
    noteId: 'project-files-note',
    currentPathId: 'project-file-current-path',
    saveButtonId: 'project-file-save-btn',
    bannerId: 'project-file-editor-banner',
    statusId: 'project-file-editor-status',
    editorId: 'project-file-editor',
    showHiddenId: 'project-file-show-hidden',
    canWrite: canManageProject(),
    isVisible: () => {
      const tab = document.getElementById('tab-files');
      return !!tab && tab.style.display !== 'none';
    },
  });
  window.ProjectFiles = projectFilesPanel;
}

function getProjectFilesAgent() {
  return agentsData.find((agent) => agent.id === projectFilesAgentId) || null;
}

function normalizeProjectFilesAgentId(agentId) {
  if (!agentId) return '';
  if (!agentsData.length || agentsData.some((agent) => agent.id === agentId)) return agentId;
  return getControllerAgent()?.id || '';
}

function syncProjectFilesAgents() {
  ensureProjectFilesPanel();
  const select = document.getElementById('project-files-agent');
  if (!select) return;

  if (!agentsData.length) {
    select.innerHTML = '<option value="">No agents available</option>';
    select.disabled = true;
    projectFilesAgentId = '';
    if (projectFilesPanel) projectFilesPanel.setAgent(null);
    return;
  }

  const previousAgentId = projectFilesAgentId;
  const options = agentsData.map((agent) => {
    const suffix = agent.is_controller ? ' [controller]' : '';
    return `<option value="${agent.id}">${esc(agent.name)}${suffix}</option>`;
  }).join('');

  select.innerHTML = `<option value="">Select an agent</option>${options}`;
  select.disabled = false;

  let nextAgentId = normalizeProjectFilesAgentId(previousAgentId);
  if (!nextAgentId) {
    const preferredAgent = agentsData.find((agent) => agent.id === currentAgentId)
      || getControllerAgent()
      || agentsData.find((agent) => !!agent.working_directory)
      || agentsData[0];
    nextAgentId = preferredAgent?.id || '';
  }

  projectFilesAgentId = nextAgentId;
  select.value = nextAgentId || '';
  if (projectFilesPanel) {
    projectFilesPanel.setWriteEnabled(canManageProject());
    projectFilesPanel.setAgent(getProjectFilesAgent());
  }
}

function handleProjectFilesAgentChange(agentId) {
  projectFilesAgentId = normalizeProjectFilesAgentId(agentId);
  if (projectFilesPanel) {
    projectFilesPanel.setAgent(getProjectFilesAgent());
    projectFilesPanel.activate();
  }
}

function loadProjectFilesTab() {
  ensureProjectFilesPanel();
  syncProjectFilesAgents();
  if (projectFilesPanel) {
    projectFilesPanel.setWriteEnabled(canManageProject());
    projectFilesPanel.activate();
  }
}

window.handleProjectFilesAgentChange = handleProjectFilesAgentChange;

async function loadActivity() {
  const container = document.getElementById('activity-list');
  try {
    const res = await fetch(`/api/projects/${projectId}/activity?limit=200`, { headers: apiHeaders() });
    if (!res.ok) return;
    const events = await res.json();

    if (!events.length) { container.innerHTML = '<div class="empty-state">No activity yet.</div>'; return; }

    container.innerHTML = events.map(e => {
      const time = timeAgo(e.time);
      if (e.event_type === 'issue') {
        const icon = e.status === 'open' ? '●' : '✓';
        const color = e.status === 'open' ? 'var(--success)' : (e.status === 'closed' ? 'var(--text-secondary)' : 'var(--accent)');
        return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:${color};flex-shrink:0">${icon}</span>
          <div><strong>${esc(nameOf(e.actor))}</strong> ${e.status === 'open' ? 'opened' : 'updated'} issue <strong>#${e.number}</strong> ${esc(e.title)} <span style="color:var(--text-secondary)">${time}</span></div>
        </div>`;
      } else if (e.event_type === 'comment') {
        return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:var(--text-secondary);flex-shrink:0">💬</span>
          <div><strong>${esc(nameOf(e.actor))}</strong> commented on <strong>#${e.issue_number}</strong> ${esc(e.issue_title)} <span style="color:var(--text-secondary)">${time}</span>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${esc((e.body || '').slice(0, 150))}</div></div>
        </div>`;
      } else if (e.event_type === 'agent_run') {
        const color = e.agent_status === 'running' ? 'var(--success)' : (e.agent_status === 'error' ? 'var(--error)' : 'var(--text-secondary)');
        return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:${color};flex-shrink:0">⚡</span>
          <div>Agent <strong>${esc(e.name)}</strong> [${e.agent_status}] <span style="color:var(--text-secondary)">${time}</span></div>
        </div>`;
      }
      return '';
    }).join('');
  } catch (e) { container.innerHTML = renderError(e, 'loadActivity()'); }
}

// ─── Git Tab ───

async function loadGitTab() {
  const commitContainer = document.getElementById('git-commit-list');
  const statusContainer = document.getElementById('git-status-summary');
  const uncommittedContainer = document.getElementById('git-uncommitted');

  // Load git log and per-agent git status in parallel
  try {
    const [logRes, ...agentStatuses] = await Promise.all([
      fetch(`/api/projects/${projectId}/git-log?limit=30`, { headers: apiHeaders() }),
      ...agentsData.filter(a => a.working_directory).map(a =>
        fetch(`/api/agents/${a.id}/git-status`, { headers: apiHeaders() }).then(r => r.ok ? r.json() : null).then(data => ({ agent: a, data }))
      )
    ]);

    // Render status summary (branch info per agent)
    const validStatuses = agentStatuses.filter(s => s && s.data && s.data.branch);
    if (validStatuses.length > 0) {
      statusContainer.innerHTML = `<div class="card" style="padding:14px 18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:10px">Repository Status</div>
        ${validStatuses.map(s => {
          const d = s.data;
          const lastCommit = d.recent_commits && d.recent_commits[0]
            ? `<code style="color:var(--accent)">${esc(d.recent_commits[0].hash)}</code> ${esc(d.recent_commits[0].message.slice(0, 60))} <span style="color:var(--text-secondary)">${timeAgo(d.recent_commits[0].date)}</span>`
            : '<span style="color:var(--text-secondary)">no commits</span>';
          const uncommitted = d.has_uncommitted
            ? `<span style="color:var(--warning);margin-left:12px">${(d.uncommitted_files || []).length} uncommitted</span>`
            : '';
          return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;flex-wrap:wrap">
            <div style="flex-shrink:0">${roleAvatarHtml(s.agent.name, 22, projectData?.color)}</div>
            <strong>${esc(s.agent.name)}</strong>
            <span style="background:var(--bg);padding:2px 8px;border-radius:10px;border:1px solid var(--border);font-family:monospace;font-size:11px">${esc(d.branch)}</span>
            <div style="flex:1">${lastCommit}</div>
            ${uncommitted}
          </div>`;
        }).join('')}
      </div>`;
    } else {
      statusContainer.innerHTML = '';
    }

    // Render commit list
    if (!logRes.ok) { commitContainer.innerHTML = renderError({ status: logRes.status }, 'loadGitTab()'); return; }
    const commits = await logRes.json();

    if (!commits.length) {
      commitContainer.innerHTML = '<div class="empty-state">No git commits found. Ensure agents have a working directory that is a git repository.</div>';
      uncommittedContainer.innerHTML = '';
      return;
    }

    commitContainer.innerHTML = `
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:10px;padding:0 4px">Recent Commits</div>
      ${commits.map(c => `<div style="display:flex;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border);font-size:13px;align-items:flex-start">
        <span style="color:var(--success);flex-shrink:0;margin-top:2px">●</span>
        <code style="color:var(--accent);flex-shrink:0;font-size:12px">${esc(c.short_hash)}</code>
        <div style="flex:1;min-width:0">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.message)}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${esc(c.author)} <span style="color:var(--text-secondary)">${timeAgo(c.date)}</span></div>
        </div>
      </div>`).join('')}`;

    // Render uncommitted changes
    const allUncommitted = validStatuses.filter(s => s.data.has_uncommitted && s.data.uncommitted_files && s.data.uncommitted_files.length > 0);
    if (allUncommitted.length > 0) {
      uncommittedContainer.innerHTML = `<div class="card" style="padding:14px 18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:10px">Uncommitted Changes</div>
        ${allUncommitted.map(s => s.data.uncommitted_files.map(f => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px;font-family:monospace;border-bottom:1px solid var(--border)">
          <span style="color:${f.status === 'M' ? 'var(--warning)' : f.status === 'A' || f.status === '?' ? 'var(--success)' : 'var(--error)'};width:20px;text-align:center;flex-shrink:0">${esc(f.status)}</span>
          <span>${esc(f.file)}</span>
        </div>`).join('')).join('')}
      </div>`;
    } else {
      uncommittedContainer.innerHTML = '';
    }
  } catch (e) {
    commitContainer.innerHTML = renderError(e, 'loadGitTab()');
    statusContainer.innerHTML = '';
    uncommittedContainer.innerHTML = '';
  }
}

// ─── Dashboard & Visualization ───

async function loadDashboard(options) {
  const el = document.getElementById('project-dashboard');
  if (!el) return;
  try {
    const opts = options || {};
    const [agents, issueCounts, cost] = await Promise.all([
      Array.isArray(opts.agents) ? opts.agents : getProjectAgents(opts),
      opts.issueCounts || getProjectIssueCounts(opts),
      Object.prototype.hasOwnProperty.call(opts, 'cost') ? opts.cost : getProjectCostSummary(opts).catch(() => null),
    ]);

    const running = agents.filter(a => a.status === 'running').length;
    const errors = agents.filter(a => a.status === 'error').length;
    const paused = agents.filter(a => a.paused).length;
    const openIssues = (issueCounts.open || 0) + (issueCounts.in_progress || 0);
    const doneIssues = (issueCounts.done || 0) + (issueCounts.closed || 0);
    const totalIssues = issueCounts.total || 0;
    const fmtCostOverview = v => !v ? '$0' : v < 0.01 ? '<$0.01' : '$' + v.toFixed(2);
    const fmtTokensOverview = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;

    // Update issue count for tab display (fixes #97: count shows 0 until clicking Issues tab)
    issueCount = totalIssues;
    updateTabCounts();

    const card = (label, value, color, sub) => `
      <div style="padding:12px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:4px">${label}</div>
        <div style="font-size:22px;font-weight:700;color:${color || 'var(--fg)'}">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${sub}</div>` : ''}
      </div>`;

    // Show cost or token usage if cost is unavailable
    const costValue = cost?.total_cost_usd > 0 ? fmtCostOverview(cost.total_cost_usd) : (cost?.total_input_tokens > 0 ? fmtTokensOverview(cost.total_input_tokens) + '↑' + fmtTokensOverview(cost.total_output_tokens) + '↓' : '$0');
    const costLabel = cost?.total_cost_usd > 0 ? 'Total Cost' : (cost?.total_input_tokens > 0 ? 'Token Usage' : 'Total Cost');

    el.innerHTML =
      card('Agents', `${running}/${agents.length}`, running > 0 ? 'var(--success)' : 'var(--fg)',
        `${errors > 0 ? `<span style="color:var(--error)">${errors} error</span>` : ''}${paused > 0 ? ` <span style="color:var(--warning)">${paused} paused</span>` : ''}`) +
      card('Open Issues', openIssues, openIssues > 0 ? 'var(--warning)' : 'var(--fg)',
        `${doneIssues} completed`) +
      card(costLabel, costValue, 'var(--accent)',
        cost ? `${cost.total_runs || 0} runs` : '') +
      card('Issues Progress', totalIssues > 0 ? Math.round(doneIssues / totalIssues * 100) + '%' : '-', 'var(--fg)',
        `${doneIssues}/${totalIssues} total`);
  } catch { el.innerHTML = ''; }
}

function getAgentGraphStatusColor(agent) {
  if (agent.paused) return '#d29922';
  switch (agent.status) {
    case 'running': return '#3fb950';
    case 'error': return '#f85149';
    case 'stopped': return '#d29922';
    default: return '#8b949e';
  }
}

function getAgentGraphContext() {
  const latestRun = getLatestOrchestrationRun();
  const dispatchResults = Array.isArray(latestRun?.dispatch_results) ? latestRun.dispatch_results : [];
  const plannedActions = Array.isArray(latestRun?.actions) ? latestRun.actions : [];
  return {
    latestRun,
    dispatchedAgents: new Set(dispatchResults.filter((result) => result && result.started).map((result) => result.agentId)),
    actionReasonByAgent: new Map(
      plannedActions
        .filter((action) => action && action.agentId)
        .map((action) => [action.agentId, action.reason || ''])
    ),
  };
}

function renderHierarchyAgentGraph(container, graphContext) {
  const byId = getAgentMap();
  const visited = new Set();
  const childrenMap = new Map(); // parentId -> [agent]

  // Build children map using only explicit parent_agent_id
  agentsData.forEach((agent) => {
    const pid = agent.parent_agent_id;
    if (pid && byId.has(pid)) {
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid).push(agent);
    }
  });

  // Identify roots: agents with no explicit parent or whose parent doesn't exist
  const roots = agentsData.filter((agent) => {
    const pid = agent.parent_agent_id;
    return !pid || !byId.has(pid);
  });

  // Build subtree sizes for proper horizontal spacing
  const subtreeSize = new Map();
  function calcSize(agent) {
    if (subtreeSize.has(agent.id)) return subtreeSize.get(agent.id);
    const children = childrenMap.get(agent.id) || [];
    const size = children.length === 0 ? 1 : children.reduce((sum, c) => sum + calcSize(c), 0);
    subtreeSize.set(agent.id, size);
    return size;
  }
  roots.forEach((r) => calcSize(r));

  // Walk tree to assign depth levels
  const depthMap = new Map();
  function walk(agent, depth) {
    if (!agent || visited.has(agent.id)) return;
    visited.add(agent.id);
    depthMap.set(agent.id, depth);
    (childrenMap.get(agent.id) || []).forEach((child) => walk(child, depth + 1));
  }
  roots.forEach((root) => walk(root, 0));
  // Safety: visit any unvisited agents as roots
  agentsData.forEach((agent) => {
    if (!visited.has(agent.id)) walk(agent, 0);
  });

  const maxDepth = Math.max(0, ...Array.from(depthMap.values()));
  const nodeH = 40;
  const nodeW = Math.max(140, ...agentsData.map((agent) => agent.name.length * 7.5 + 28));
  const levelGap = Math.max(220, nodeW + 80);
  const rowGap = 76;
  const topPadding = 56;
  const bottomPadding = 72;
  const leftPadding = nodeW / 2 + 36;
  const rightPadding = nodeW / 2 + 36;
  const totalLeaves = Math.max(1, roots.reduce((sum, r) => sum + (subtreeSize.get(r.id) || 1), 0));
  const W = Math.max(container.clientWidth || 760, leftPadding + maxDepth * levelGap + rightPadding);
  const H = Math.max(280, topPadding + Math.max(0, totalLeaves - 1) * rowGap + bottomPadding);
  const positions = new Map();

  // Position nodes left-to-right by hierarchy depth; rows expand vertically with fixed spacing.
  let leafCounter = 0;
  function positionSubtree(agent, depth) {
    const children = childrenMap.get(agent.id) || [];
    const x = leftPadding + depth * levelGap;
    if (children.length === 0) {
      const y = topPadding + leafCounter * rowGap;
      leafCounter++;
      positions.set(agent.id, { x, y });
    } else {
      children.forEach((child) => positionSubtree(child, depth + 1));
      // Center parent beside its child block without squeezing sibling rows.
      const childPositions = children.map((c) => positions.get(c.id)).filter(Boolean);
      const minY = Math.min(...childPositions.map((p) => p.y));
      const maxY = Math.max(...childPositions.map((p) => p.y));
      positions.set(agent.id, { x, y: (minY + maxY) / 2 });
    }
  }
  roots.forEach((root) => positionSubtree(root, 0));

  let svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;margin:0 auto">';

  // Draw edges using only explicit parent_agent_id
  agentsData.forEach((agent) => {
    const pid = agent.parent_agent_id;
    if (!pid || !byId.has(pid)) return;
    const parentPos = positions.get(pid);
    const childPos = positions.get(agent.id);
    if (!parentPos || !childPos) return;

    const dispatched = graphContext.dispatchedAgents.has(agent.id);
    svg += '<line x1="' + (parentPos.x + nodeW / 2) + '" y1="' + parentPos.y + '" x2="' + (childPos.x - nodeW / 2) + '" y2="' + childPos.y + '" stroke="' + (dispatched ? 'var(--accent)' : 'var(--border)') + '" stroke-width="' + (dispatched ? 2.2 : 1.2) + '"' +
      ' opacity="' + (dispatched ? 0.95 : 0.7) + '"/>';

    if (dispatched) {
      const mx = (parentPos.x + childPos.x) / 2;
      const my = (parentPos.y + childPos.y) / 2;
      svg += '<text x="' + mx + '" y="' + (my - 8) + '" text-anchor="middle" fill="var(--accent)" font-size="8">dispatch</text>';
    }
  });

  // Draw nodes
  agentsData.forEach((agent) => {
    const position = positions.get(agent.id);
    if (!position) return;
    const color = getAgentGraphStatusColor(agent);
    const pulse = agent.status === 'running'
      ? '<animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite"/>'
      : '';
    const assignedCount = (window._dashboardIssues || []).filter((issue) => issue.assigned_to === agent.id && ['open', 'in_progress', 'pending'].includes(issue.status)).length;
    const childCount = (childrenMap.get(agent.id) || []).length;
    const dispatched = graphContext.dispatchedAgents.has(agent.id);
    const reason = graphContext.actionReasonByAgent.get(agent.id);
    const statusLabel = agent.paused ? 'paused' : agent.status;
    const metaParts = [statusLabel, assignedCount > 0 ? assignedCount + ' tasks' : null, childCount > 0 ? childCount + ' child' : null].filter(Boolean).join(' · ');

    svg += '<g style="cursor:pointer" onclick="viewAgent(\"' + agent.id + '\")">' +
      '<rect x="' + (position.x - nodeW / 2) + '" y="' + (position.y - nodeH / 2) + '" width="' + nodeW + '" height="' + nodeH + '" rx="8" fill="' + color + '22" stroke="' + color + '" stroke-width="' + (dispatched ? '2.8' : '2') + '"' + (agent.paused ? ' stroke-dasharray="4,4"' : '') + '>' + pulse + '</rect>' +
      '<text x="' + position.x + '" y="' + (position.y - 2) + '" text-anchor="middle" fill="var(--fg)" font-size="11" font-weight="600">' + esc(agent.name) + '</text>' +
      '<text x="' + position.x + '" y="' + (position.y + 12) + '" text-anchor="middle" fill="' + (dispatched ? 'var(--accent)' : color) + '" font-size="8.5">' + esc(metaParts || statusLabel) + '</text>' +
      '<title>' + esc([agent.name, reason].filter(Boolean).join(' · ')) + '</title>' +
    '</g>';
  });

  svg += '</svg>';

  const hasOrphans = roots.some((r) => !r.is_controller);
  const note = hasOrphans
    ? 'Top-level agents (no parent) are shown as independent roots.'
    : 'Links in the graph follow the configured parent-child hierarchy.';

  return {
    title: 'Agent Collaboration · Tree',
    note,
    svg,
  };
}

function renderAgentGraph() {
  const container = document.getElementById('agent-graph-container');
  if (!container || !agentsData.length) {
    if (container) container.innerHTML = '';
    return;
  }

  const graphContext = getAgentGraphContext();
  const graph = renderHierarchyAgentGraph(container, graphContext);

  const runInfo = graphContext.latestRun
    ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:6px">Latest decision: <span style="color:var(--fg)">' + esc(graphContext.latestRun.decision || '-') + '</span> · ' + esc(timeAgo(graphContext.latestRun.created_at)) + '</div>'
    : '<div style="font-size:11px;color:var(--text-secondary);margin-top:6px">No orchestration decision records yet.</div>';

  container.innerHTML = '<div class="card" style="padding:12px;text-align:center">' +
    '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:8px">' + graph.title + '</div>' +
    '<div style="max-height:420px;overflow-y:auto;overflow-x:auto;padding:4px 0">' + graph.svg + '</div>' +
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:8px">' + graph.note + '</div>' +
    runInfo +
  '</div>';
}

function getLatestOrchestrationRun() {
  if (!Array.isArray(orchestrationRunsData) || orchestrationRunsData.length === 0) return null;
  return orchestrationRunsData[0];
}

async function loadOrchestrationRuns() {
  const container = document.getElementById('orchestration-decision-container');
  if (!container) return;
  try {
    const res = await fetch('/api/projects/' + projectId + '/orchestration-runs?limit=12', { headers: apiHeaders() });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    orchestrationRunsData = Array.isArray(data) ? data : [];
  } catch {
    orchestrationRunsData = [];
  }
  renderOrchestrationDecisionPanel();
  renderAgentGraph();
}

function renderOrchestrationDecisionPanel() {
  const container = document.getElementById('orchestration-decision-container');
  if (!container) return;

  const latest = getLatestOrchestrationRun();
  if (!latest) {
    container.innerHTML = '<div class="card" style="padding:12px">' +
      '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:8px">Orchestration Decisions</div>' +
      '<div class="empty-state" style="padding:8px 0">No orchestration runs yet.</div>' +
    '</div>';
    return;
  }

  const decisionColors = {
    execute_controller: 'var(--warning)',
    finish: 'var(--success)',
    error: 'var(--error)'
  };
  const decisionColor = decisionColors[latest.decision] || 'var(--text-secondary)';

  const reasons = Array.isArray(latest.reasons) ? latest.reasons : [];
  const dispatchResults = Array.isArray(latest.dispatch_results) ? latest.dispatch_results : [];
  const actions = Array.isArray(latest.actions) ? latest.actions : [];

  const reasonsHtml = reasons.length
    ? reasons.slice(0, 5).map((r) => '<li style="margin:2px 0">' + esc(r) + '</li>').join('')
    : '<li style="margin:2px 0;color:var(--text-secondary)">none</li>';

  const dispatchHtml = dispatchResults.length
    ? dispatchResults.slice(0, 10).map((r) => {
      const agent = agentsData.find(a => a.id === r.agentId);
      const name = agent ? agent.name : r.agentId;
      const status = r.started ? 'started' : 'skipped';
      const color = r.started ? 'var(--success)' : 'var(--warning)';
      return '<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border);font-size:12px">' +
        '<div style="min-width:0"><strong>' + esc(name) + '</strong><div style="color:var(--text-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px">' + esc(r.message || '') + '</div></div>' +
        '<span style="color:' + color + ';font-weight:600;flex-shrink:0">' + status + '</span>' +
      '</div>';
    }).join('')
    : '<div style="color:var(--text-secondary);font-size:12px">No worker dispatch this run.</div>';

  const history = orchestrationRunsData.slice(0, 8).map((r) => {
    const c = decisionColors[r.decision] || 'var(--text-secondary)';
    return '<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:3px 0;border-bottom:1px dashed var(--border)">' +
      '<span><span style="color:' + c + ';font-weight:600">' + esc(r.decision || '-') + '</span> · ' + esc(r.engine || '-') + '</span>' +
      '<span style="color:var(--text-secondary)">' + esc(timeAgo(r.created_at)) + '</span>' +
    '</div>';
  }).join('');

  container.innerHTML = '<div class="card" style="padding:12px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px">' +
      '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6">Orchestration Decisions</div>' +
      '<button class="btn btn-sm" onclick="loadOrchestrationRuns()">Refresh</button>' +
    '</div>' +

    '<div style="display:grid;grid-template-columns:1.2fr 1.8fr;gap:12px">' +
      '<div style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px">' +
        '<div style="font-size:12px;margin-bottom:4px">Latest: <strong style="color:' + decisionColor + '">' + esc(latest.decision || '-') + '</strong></div>' +
        '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">engine=' + esc(latest.engine || '-') + ' · ' + esc(timeAgo(latest.created_at)) + '</div>' +
        '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">dispatch=' + esc(String(latest.dispatch_count || 0)) + ' · controller=' + (latest.controller_started ? 'started' : 'not started') + '</div>' +
        '<div style="font-size:11px;font-weight:600;margin-bottom:4px">Reasons</div>' +
        '<ul style="margin:0 0 8px 16px;padding:0;font-size:11px">' + reasonsHtml + '</ul>' +
        '<div style="font-size:11px;font-weight:600;margin-bottom:4px">Planned actions</div>' +
        '<div style="font-size:11px;color:var(--text-secondary)">' + esc(String(actions.length)) + ' action(s)</div>' +
      '</div>' +

      '<div style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px">' +
        '<div style="font-size:11px;font-weight:600;margin-bottom:6px">Dispatch Results</div>' +
        '<div style="max-height:165px;overflow:auto">' + dispatchHtml + '</div>' +
        '<div style="font-size:11px;font-weight:600;margin-top:10px;margin-bottom:4px">Recent Runs</div>' +
        '<div style="max-height:120px;overflow:auto">' + history + '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// ─── Cost Time-Series Chart ───

const _agentColors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#39d2c0','#ff7b72','#79c0ff','#7ee787','#e3b341'];
let _currentCostPeriod = 'hour';

function switchCostPeriod(period) {
  _currentCostPeriod = period;
  document.querySelectorAll('.cost-period-btn').forEach(b => {
    b.style.background = b.dataset.period === period ? 'var(--accent)' : '';
    b.style.color = b.dataset.period === period ? '#fff' : '';
  });
  loadCostChart();
}

async function loadCostChart() {
  try {
    const res = await fetch(`/api/projects/${projectId}/costs?period=${_currentCostPeriod}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const panel = document.getElementById('cost-chart-panel');
    if (!data.time_series || data.time_series.length === 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';

    // Highlight active period tab
    document.querySelectorAll('.cost-period-btn').forEach(b => {
      b.style.background = b.dataset.period === _currentCostPeriod ? 'var(--accent)' : '';
      b.style.color = b.dataset.period === _currentCostPeriod ? '#fff' : '';
    });

    // Build a stable agent→color map so both charts use the same colors
    const allAgentNames = new Set();
    if (data.time_series_by_agent) Object.keys(data.time_series_by_agent).forEach(n => allAgentNames.add(n));
    if (data.by_agent) Object.keys(data.by_agent).forEach(n => allAgentNames.add(n));
    const _agentColorMap = {};
    [...allAgentNames].sort().forEach((name, i) => { _agentColorMap[name] = _agentColors[i % _agentColors.length]; });

    // Render per-agent stacked bar chart
    const agentsEl = document.getElementById('cost-chart-agents');
    if (data.time_series_by_agent && Object.keys(data.time_series_by_agent).length > 0) {
      const agents = Object.entries(data.time_series_by_agent);
      agentsEl.innerHTML = renderStackedBarChart(agents, data.time_series, 600, 200, _agentColorMap);
    } else {
      agentsEl.innerHTML = '';
    }

    // Render agent comparison chart
    renderAgentCostComparison(data.by_agent || {}, _agentColorMap);
  } catch {}
}

function renderAgentCostComparison(byAgent, colorMap) {
  const el = document.getElementById('cost-agent-comparison');
  if (!el) return;
  const entries = Object.entries(byAgent).filter(([, v]) => v.cost > 0 || v.input_tokens > 0 || v.output_tokens > 0).sort((a, b) => b[1].cost - a[1].cost);
  if (entries.length === 0) { el.innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">No data</div>'; return; }

  const totalCost = entries.reduce((s, [, v]) => s + v.cost, 0);
  const hasCost = totalCost > 0;
  // When no USD cost available (e.g. Codex), fall back to total tokens for bar sizing
  const totalTokens = entries.reduce((s, [, v]) => s + (v.input_tokens || 0) + (v.output_tokens || 0), 0);
  const metric = hasCost ? (v) => v.cost : (v) => (v.input_tokens || 0) + (v.output_tokens || 0);
  const maxMetric = Math.max(...entries.map(([, v]) => metric(v)), 1);
  const totalMetric = hasCost ? totalCost : totalTokens;
  const fmtTokensComp = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;

  // Horizontal bar chart + percentage
  el.innerHTML = entries.map(([name, v], idx) => {
    const val = metric(v);
    const pct = totalMetric > 0 ? (val / totalMetric * 100).toFixed(1) : '0';
    const barWidth = maxMetric > 0 ? (val / maxMetric * 100).toFixed(1) : '0';
    const color = (colorMap && colorMap[name]) || _agentColors[idx % _agentColors.length];
    const label = hasCost ? ('$' + (v.cost < 0.01 ? v.cost.toFixed(4) : v.cost.toFixed(2))) : (fmtTokensComp((v.input_tokens||0)+(v.output_tokens||0)) + ' tokens');
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="width:120px;font-size:11px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(name)}">${esc(name)}</div>
      <div style="flex:1;height:18px;background:var(--bg);border:1px solid var(--border);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${barWidth}%;background:${color};opacity:0.8;border-radius:3px;transition:width 0.3s"></div>
      </div>
      <div style="width:80px;font-size:11px;color:var(--text-secondary);text-align:right">${label}</div>
      <div style="width:40px;font-size:10px;color:var(--text-secondary);text-align:right">${pct}%</div>
    </div>`;
  }).join('') +
  `<div style="margin-top:8px;font-size:12px;color:var(--fg);font-weight:600">Total: ${hasCost ? '$' + (totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)) : fmtTokensComp(totalTokens) + ' tokens'}</div>`;
}

function renderStackedBarChart(agents, totalSeries, width, height, colorMap) {
  const PAD_L = 50, PAD_R = 16, PAD_T = 12, PAD_B = 32;
  const W = width, H = height;
  const cw = W - PAD_L - PAD_R, ch = H - PAD_T - PAD_B;

  const allDates = totalSeries.map(d => d.period_start);
  const n = allDates.length;
  const maxCost = Math.max(...totalSeries.map(d => d.cost), 0.001);
  const barW = Math.max(2, (cw / n) * 0.7);
  const gap = cw / n;

  // Y-axis labels
  const yLabels = [0, maxCost / 2, maxCost].map(v => {
    const y = PAD_T + ch - (v / maxCost) * ch;
    return `<text x="${PAD_L - 6}" y="${y + 3}" text-anchor="end" fill="var(--text-secondary)" font-size="9">$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}</text>
    <line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="var(--border)" stroke-width="0.5" opacity="0.5"/>`;
  }).join('');

  // X-axis labels
  const step = Math.max(1, Math.floor(n / 6));
  const xLabels = allDates.map((d, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    const x = PAD_L + i * gap + gap / 2;
    const label = d.slice(5);
    return `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--text-secondary)" font-size="8">${label}</text>`;
  }).join('');

  // Build per-date agent cost lookup
  const agentDateMaps = agents.map(([, series]) => {
    const m = {};
    series.forEach(d => { m[d.period_start] = d; });
    return m;
  });

  // Stacked bars
  let bars = '';
  allDates.forEach((date, i) => {
    const x = PAD_L + i * gap + (gap - barW) / 2;
    let yOffset = 0;
    agents.forEach(([agentName], idx) => {
      const cost = agentDateMaps[idx][date]?.cost || 0;
      if (cost <= 0) return;
      const barH = (cost / maxCost) * ch;
      const y = PAD_T + ch - yOffset - barH;
      const color = (colorMap && colorMap[agentName]) || _agentColors[idx % _agentColors.length];
      const runs = agentDateMaps[idx][date]?.runs || 0;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" opacity="0.85" rx="1">
        <title>${agentName} ${date}: $${cost.toFixed(4)} (${runs} runs)</title>
      </rect>`;
      yOffset += barH;
    });
  });

  // Legend
  const legend = agents.map(([name], idx) => {
    const color = (colorMap && colorMap[name]) || _agentColors[idx % _agentColors.length];
    return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary)">
      <span style="width:10px;height:10px;background:${color};border-radius:2px;display:inline-block"></span>${name.length > 15 ? name.slice(0, 14) + '…' : name}
    </span>`;
  }).join('');

  return `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">
    ${yLabels}${xLabels}${bars}
  </svg>
  <div style="margin-top:6px;line-height:1.8">${legend}</div>`;
}

// ─── Knowledge Base ───

async function loadKnowledge() {
  const el = document.getElementById('knowledge-list');
  if (!el) return;
  const canManage = canManageProject();
  const importance = document.getElementById('knowledge-filter-importance')?.value || '';
  const qs = importance ? `?importance=${importance}` : '';
  try {
    const res = await fetch(`/api/projects/${projectId}/knowledge${qs}`, { headers: apiHeaders() });
    if (!res.ok) { el.innerHTML = renderError({ status: res.status }, 'loadKnowledge()'); return; }
    const data = await res.json();
    const entries = data.entries || [];
    if (entries.length === 0) {
      el.innerHTML = `<div class="empty-state">No knowledge entries yet.${canManage ? ' Click "Add Knowledge" to start building the project knowledge base.' : ''}</div>`;
      return;
    }
    const impBadge = (imp) => {
      const colors = { high: 'var(--error)', medium: 'var(--warning)', low: 'var(--text-secondary)' };
      const labels = { high: 'High', medium: 'Medium', low: 'Low' };
      return `<span style="padding:1px 6px;border-radius:3px;font-size:10px;background:${colors[imp] || 'var(--text-secondary)'};color:#fff">${labels[imp] || imp}</span>`;
    };
    el.innerHTML = '<div style="padding:8px 0">' + entries.map(e => `
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            ${impBadge(e.importance)}
            <span style="font-weight:600;font-size:13px">${esc(e.title)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;max-height:60px;overflow:hidden;white-space:pre-wrap">${esc((e.content || '').slice(0, 200))}${e.content && e.content.length > 200 ? '...' : ''}</div>
          ${e.tags ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${e.tags.split(',').filter(t => t.trim()).map(t => `<span style="padding:1px 6px;background:var(--bg);border:1px solid var(--border);border-radius:3px;font-size:10px">${esc(t.trim())}</span>`).join('')}</div>` : ''}
        </div>
        ${canManage ? `<div style="display:flex;gap:4px;flex-shrink:0;margin-left:12px">
          <button class="btn btn-sm" onclick="editKnowledge('${e.id}')" style="padding:3px 8px">Edit</button>
          <button class="btn btn-sm" onclick="deleteKnowledge('${e.id}')" style="padding:3px 8px;color:var(--error)">Delete</button>
        </div>` : ''}
      </div>
    `).join('') + '</div>';
  } catch (e) { el.innerHTML = renderError(e, 'loadKnowledge()'); }
}

let _knowledgeCache = [];

function showCreateKnowledgeModal() {
  if (!requireProjectManageAccess('Insufficient permission to add knowledge')) return;
  document.getElementById('knowledge-modal-title').textContent = 'Add Knowledge Entry';
  document.getElementById('knowledge-edit-id').value = '';
  document.getElementById('knowledge-title').value = '';
  document.getElementById('knowledge-content').value = '';
  document.getElementById('knowledge-tags').value = '';
  document.getElementById('knowledge-importance').value = 'medium';
  document.getElementById('knowledgeModal').classList.add('active');
}

async function editKnowledge(id) {
  if (!requireProjectManageAccess('Insufficient permission to edit knowledge')) return;
  try {
    const res = await fetch(`/api/knowledge/${id}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const e = await res.json();
    document.getElementById('knowledge-modal-title').textContent = 'Edit Knowledge Entry';
    document.getElementById('knowledge-edit-id').value = id;
    document.getElementById('knowledge-title').value = e.title || '';
    document.getElementById('knowledge-content').value = e.content || '';
    document.getElementById('knowledge-tags').value = e.tags || '';
    document.getElementById('knowledge-importance').value = e.importance || 'medium';
    document.getElementById('knowledgeModal').classList.add('active');
  } catch { showToast('Failed to load', 'error'); }
}

async function saveKnowledge() {
  if (!requireProjectManageAccess('Insufficient permission to save knowledge')) return;
  const id = document.getElementById('knowledge-edit-id').value;
  const body = {
    title: document.getElementById('knowledge-title').value,
    content: document.getElementById('knowledge-content').value,
    tags: document.getElementById('knowledge-tags').value,
    importance: document.getElementById('knowledge-importance').value,
  };
  if (!body.title) { showToast('Title is required', 'error'); return; }
  try {
    const url = id ? `/api/knowledge/${id}` : `/api/projects/${projectId}/knowledge`;
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { ...apiHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) {
      hideModal('knowledgeModal');
      showToast(id ? 'Updated' : 'Created', 'success');
      loadKnowledge();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to save', 'error');
    }
  } catch { showToast('Failed to save', 'error'); }
}

async function deleteKnowledge(id) {
  if (!requireProjectManageAccess('Insufficient permission to delete knowledge')) return;
  if (!await showConfirm('Delete this knowledge entry?')) return;
  try {
    const res = await fetch(`/api/knowledge/${id}`, { method: 'DELETE', headers: apiHeaders() });
    if (res.ok) { showToast('Deleted', 'success'); loadKnowledge(); }
    else showToast('Failed to delete', 'error');
  } catch { showToast('Failed to delete', 'error'); }
}

// ─── Workflow Tab (#615) ───

let _workflowData = null;

async function loadWorkflowTab() {
  await Promise.all([loadWorkflowGraph(), loadWorkflowActivity(), loadWorkflowApprovals()]);
}

async function loadWorkflowGraph() {
  const container = document.getElementById('workflow-graph-svg');
  if (!container) return;
  try {
    const res = await fetch('/api/projects/' + projectId + '/workflow-status', { headers: apiHeaders() });
    if (!res.ok) throw new Error('failed');
    _workflowData = await res.json();
    renderWorkflowGraph(container, _workflowData);
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load workflow status.</div>';
  }
}

function renderWorkflowGraph(container, data) {
  if (!data || !data.agents || data.agents.length === 0) {
    container.innerHTML = '<div class="empty-state">No agents configured.</div>';
    return;
  }

  renderWorkflowGraphHierarchy(container, data);
}

function renderWorkflowGraphHierarchy(container, data) {
  const agents = data.agents;
  const byId = {};
  agents.forEach(function(a) { byId[a.id] = a; });

  // Build children map
  var childrenMap = {};
  agents.forEach(function(a) {
    var pid = a.parent_agent_id;
    if (pid && byId[pid]) {
      if (!childrenMap[pid]) childrenMap[pid] = [];
      childrenMap[pid].push(a);
    }
  });

  // Identify roots
  var roots = agents.filter(function(a) {
    return !a.parent_agent_id || !byId[a.parent_agent_id];
  });

  // Build subtree sizes
  var subtreeSize = {};
  function calcSize(agent) {
    if (subtreeSize[agent.id] !== undefined) return subtreeSize[agent.id];
    var children = childrenMap[agent.id] || [];
    var size = children.length === 0 ? 1 : children.reduce(function(sum, c) { return sum + calcSize(c); }, 0);
    subtreeSize[agent.id] = size;
    return size;
  }
  roots.forEach(function(r) { calcSize(r); });

  // Walk tree to assign depth levels
  var visited = {};
  var depthMap = {};
  function walk(agent, depth) {
    if (!agent || visited[agent.id]) return;
    visited[agent.id] = true;
    depthMap[agent.id] = depth;
    (childrenMap[agent.id] || []).forEach(function(child) { walk(child, depth + 1); });
  }
  roots.forEach(function(root) { walk(root, 0); });
  agents.forEach(function(agent) {
    if (!visited[agent.id]) walk(agent, 0);
  });

  var maxDepth = 0;
  agents.forEach(function(a) {
    if ((depthMap[a.id] || 0) > maxDepth) maxDepth = depthMap[a.id];
  });

  var W = Math.min(Math.max(container.clientWidth || 760, 640), 960);
  var levelGap = 112;
  var topPadding = 56;
  var H = Math.max(280, topPadding + maxDepth * levelGap + 96);
  var nodeH = 40;
  var positions = {};

  // Position nodes using subtree sizes
  var totalLeaves = roots.reduce(function(sum, r) { return sum + (subtreeSize[r.id] || 1); }, 0);
  var leafWidth = W / (totalLeaves + 1);
  var leafCounter = 0;

  function positionSubtree(agent, depth) {
    var children = childrenMap[agent.id] || [];
    var y = topPadding + depth * levelGap;
    if (children.length === 0) {
      leafCounter++;
      positions[agent.id] = { x: leafCounter * leafWidth, y: y };
    } else {
      children.forEach(function(child) { positionSubtree(child, depth + 1); });
      var childPositions = children.map(function(c) { return positions[c.id]; }).filter(Boolean);
      var minX = Math.min.apply(null, childPositions.map(function(p) { return p.x; }));
      var maxX = Math.max.apply(null, childPositions.map(function(p) { return p.x; }));
      positions[agent.id] = { x: (minX + maxX) / 2, y: y };
    }
  }
  roots.forEach(function(root) { positionSubtree(root, 0); });

  var svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;margin:0 auto">';

  // Draw hierarchy edges (parent -> child)
  agents.forEach(function(agent) {
    var pid = agent.parent_agent_id;
    if (!pid || !byId[pid]) return;
    var parentPos = positions[pid];
    var childPos = positions[agent.id];
    if (!parentPos || !childPos) return;
    svg += '<line x1="' + parentPos.x + '" y1="' + (parentPos.y + nodeH / 2) + '" x2="' + childPos.x + '" y2="' + (childPos.y - nodeH / 2) + '" stroke="var(--border)" stroke-width="1.2" opacity="0.7"/>';
  });

  // Draw message edges
  if (data.recent_messages && data.recent_messages.length > 0) {
    var msgEdges = {};
    data.recent_messages.forEach(function(m) {
      var key = m.from_agent_id + '->' + m.to_agent_id;
      msgEdges[key] = (msgEdges[key] || 0) + 1;
    });
    Object.keys(msgEdges).forEach(function(key) {
      var parts = key.split('->');
      var from = positions[parts[0]];
      var to = positions[parts[1]];
      if (from && to) {
        svg += '<line x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" stroke="var(--accent)" stroke-width="1.5" opacity="0.4" stroke-dasharray="6,3"/>';
        var dx = to.x - from.x;
        var dy = to.y - from.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          var mx = from.x + dx * 0.65;
          var my = from.y + dy * 0.65;
          svg += '<circle cx="' + mx + '" cy="' + my + '" r="3" fill="var(--accent)" opacity="0.6"/>';
        }
      }
    });
  }

  // Draw nodes
  agents.forEach(function(agent) {
    var pos = positions[agent.id];
    if (!pos) return;
    var color = getWorkflowStatusColor(agent);
    var nw = Math.max(70, agent.name.length * 7.5 + 20);
    var pulse = agent.status === 'running'
      ? '<animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite"/>'
      : '';
    var issues = agent.current_issues || [];
    var issueCount = issues.length;
    var topIssue = issues[0];
    var statusLabel = agent.paused ? 'paused' : agent.status;
    var metaParts = [statusLabel, issueCount > 0 ? issueCount + ' issues' : null].filter(Boolean).join(' \u00b7 ');

    svg += '<g style="cursor:pointer" onclick="viewAgent(\'' + agent.id + '\')">';
    svg += '<rect x="' + (pos.x - nw / 2) + '" y="' + (pos.y - nodeH / 2) + '" width="' + nw + '" height="' + nodeH + '" rx="8" fill="' + color + '22" stroke="' + color + '" stroke-width="' + (agent.is_controller ? '2.8' : '2') + '"' + (agent.paused ? ' stroke-dasharray="4,4"' : '') + '>' + pulse + '</rect>';
    svg += '<text x="' + pos.x + '" y="' + (pos.y - 2) + '" text-anchor="middle" fill="var(--fg)" font-size="11" font-weight="600">' + esc(agent.name) + '</text>';
    svg += '<text x="' + pos.x + '" y="' + (pos.y + 12) + '" text-anchor="middle" fill="' + color + '" font-size="8.5">' + esc(metaParts) + '</text>';
    if (topIssue) {
      svg += '<text x="' + pos.x + '" y="' + (pos.y + nodeH / 2 + 12) + '" text-anchor="middle" fill="var(--accent)" font-size="8">#' + topIssue.number + (issueCount > 1 ? ' +' + (issueCount - 1) : '') + '</text>';
    }
    svg += '</g>';
  });

  // Pending approvals indicator
  if (data.pending_approvals && data.pending_approvals.length > 0) {
    svg += '<text x="' + (W - 10) + '" y="20" text-anchor="end" fill="var(--warning)" font-size="11" font-weight="600">\u26a0 ' + data.pending_approvals.length + ' pending approval(s)</text>';
  }

  svg += '</svg>';

  // Summary line
  var summary = '<div style="text-align:center;font-size:11px;color:var(--text-secondary);margin-top:8px">';
  summary += agents.length + ' agents \u00b7 ' + data.total_active_issues + ' active issues';
  if (data.recent_messages && data.recent_messages.length > 0) {
    summary += ' \u00b7 ' + data.recent_messages.length + ' recent messages';
  }
  summary += '</div>';
  container.innerHTML = svg + summary;
}

function getWorkflowStatusColor(agent) {
  if (agent.status === 'running') return 'var(--warning)';
  if (agent.status === 'error') return 'var(--error)';
  if (agent.status === 'waiting') return 'var(--accent)';
  return 'var(--success)';
}

async function loadWorkflowActivity() {
  var container = document.getElementById('workflow-activity-timeline');
  if (!container) return;
  try {
    var res = await fetch('/api/projects/' + projectId + '/activity?limit=30', { headers: apiHeaders() });
    if (!res.ok) throw new Error('failed');
    var events = await res.json();
    if (!events.length) { container.innerHTML = '<div class="empty-state">No activity yet.</div>'; return; }

    container.innerHTML = events.map(function(e) {
      var time = timeAgo(e.time);
      if (e.event_type === 'issue') {
        var icon = e.status === 'open' ? '<span style="color:var(--success)">\u25cf</span>' : '<span style="color:var(--accent)">\u2713</span>';
        return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          icon + '<div><strong>' + esc(nameOf(e.actor)) + '</strong> ' + (e.status === 'open' ? 'opened' : 'updated') + ' <a href="/issues/' + e.id + '" style="color:var(--link)">#' + e.number + '</a> ' + esc(e.title) + ' <span style="color:var(--text-secondary)">' + time + '</span></div></div>';
      } else if (e.event_type === 'comment') {
        return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          '<span style="color:var(--text-secondary)">\ud83d\udcac</span><div><strong>' + esc(nameOf(e.actor)) + '</strong> commented on <a href="/issues/' + e.id + '" style="color:var(--link)">#' + e.issue_number + '</a> ' + esc(e.issue_title) + ' <span style="color:var(--text-secondary)">' + time + '</span></div></div>';
      } else if (e.event_type === 'agent_run') {
        var statusColor = e.agent_status === 'running' ? 'var(--success)' : (e.agent_status === 'error' ? 'var(--error)' : 'var(--text-secondary)');
        return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          '<span style="color:' + statusColor + '">\u26a1</span><div>Agent <strong>' + esc(e.name) + '</strong> [' + e.agent_status + '] <span style="color:var(--text-secondary)">' + time + '</span></div></div>';
      }
      return '';
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load activity.</div>';
  }
}

// ─── Approval Requests (#616) ───

async function loadWorkflowApprovals() {
  var panel = document.getElementById('workflow-approvals-container');
  var listEl = document.getElementById('workflow-approvals-list');
  var countEl = document.getElementById('workflow-approval-count');
  if (!panel || !listEl) return;

  try {
    var res = await fetch('/api/projects/' + projectId + '/approvals?status=pending', { headers: apiHeaders() });
    if (!res.ok) throw new Error('failed');
    var approvals = await res.json();

    if (approvals.length === 0) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = '';
    if (countEl) { countEl.textContent = approvals.length; countEl.style.display = ''; }

    listEl.innerHTML = approvals.map(function(a) {
      var riskColors = { low: 'var(--success)', medium: 'var(--warning)', high: 'var(--error)', critical: 'var(--error)' };
      var riskColor = riskColors[a.risk_level] || 'var(--warning)';
      return '<div class="approval-card" style="border:1px solid ' + riskColor + '44;border-left:3px solid ' + riskColor + ';border-radius:6px;padding:10px 12px;margin-bottom:8px;background:' + riskColor + '08">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">' +
          '<div><strong style="font-size:13px">' + esc(a.title) + '</strong>' +
          '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">Agent: ' + esc(a.agent_name || 'unknown') + ' \u00b7 Risk: <span style="color:' + riskColor + ';font-weight:600">' + a.risk_level + '</span> \u00b7 ' + timeAgo(a.created_at) + '</div></div>' +
        '</div>' +
        (a.description ? '<div style="font-size:12px;color:var(--fg);margin-bottom:8px">' + esc(a.description) + '</div>' : '') +
        '<div style="display:flex;gap:6px">' +
          '<button class="btn btn-sm btn-primary" onclick="decideApproval(\'' + a.id + '\', \'approved\')">Approve</button>' +
          '<button class="btn btn-sm btn-danger" onclick="decideApproval(\'' + a.id + '\', \'rejected\')">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    panel.style.display = 'none';
  }
}

async function decideApproval(approvalId, decision) {
  var note = '';
  if (decision === 'rejected') {
    note = prompt('Reason for rejection (optional):') || '';
  }
  try {
    var res = await fetch('/api/approvals/' + approvalId, {
      method: 'PUT',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: decision, decision_note: note, decided_by: 'user' })
    });
    if (res.ok) {
      showToast('Approval ' + decision, 'success');
      loadWorkflowApprovals();
    } else {
      var err = await res.json();
      showToast(err.error || 'Failed', 'error');
    }
  } catch (e) {
    showToast('Failed to submit decision', 'error');
  }
}

window.decideApproval = decideApproval;

// ─── Init ───
async function loadProjectBootstrap(options) {
  const opts = options || {};
  await Promise.all([
    loadProject(opts),
    loadAgents(opts),
    loadDashboard(opts),
    loadCostChart(),
  ]);
}

loadProjectBootstrap({ force: true });
window.addEventListener('agentopia:user-ready', () => { renderProjectAccessSummary(); });

// Slow fallback polling (WS handles real-time)
setInterval(() => { loadAgents({ force: true }); }, 30000);

// Connect to project-level WebSocket for real-time updates
const _projectEvents = connectProjectEvents(projectId);

_projectEvents.on('agent_status', function(data) {
  loadAgents({ force: true })
    .then(() => loadDashboard({ agents: agentsData }))
    .catch(() => loadDashboard({ force: true }));
  // If viewing this agent's detail, refresh output too
  if (currentAgentId === data.agentId) {
    loadAgentOutput(data.agentId);
  }
});

_projectEvents.on('issue_created', function() {
  loadIssues();
});

_projectEvents.on('issue_updated', function() {
  loadIssues();
});

_projectEvents.on('comment_added', function() {
  loadIssues();
});

_projectEvents.on('approval_created', function() {
  loadWorkflowApprovals();
});

_projectEvents.on('approval_decided', function() {
  loadWorkflowApprovals();
});

// Auto-refresh workflow tab on relevant events
_projectEvents.on('agent_status', function() {
  if (document.getElementById('tab-workflow') && document.getElementById('tab-workflow').style.display !== 'none') {
    loadWorkflowGraph();
  }
});

_projectEvents.on('issue_created', function() {
  if (document.getElementById('tab-workflow') && document.getElementById('tab-workflow').style.display !== 'none') {
    loadWorkflowGraph();
    loadWorkflowActivity();
  }
});

_projectEvents.on('issue_updated', function() {
  if (document.getElementById('tab-workflow') && document.getElementById('tab-workflow').style.display !== 'none') {
    loadWorkflowGraph();
    loadWorkflowActivity();
  }
});

// Handle hash navigation (e.g., #issues or #agents from dashboard)
const hash = window.location.hash.replace('#', '');
const hashTab = hash.split('?')[0];
if (['overview', 'agents', 'issues', 'activity', 'git', 'knowledge', 'files', 'workflow'].includes(hashTab)) {
  setTimeout(() => {
    switchTab(hashTab);
    // Auto-open file if hash contains ?file= (e.g., #files?file=src/app.ts&agent=AGENT_ID)
    if (hashTab === 'files') {
      const fileMatch = hash.match(/[?&]file=([^&]+)/);
      if (fileMatch) {
        const filePath = decodeURIComponent(fileMatch[1]);
        const agentMatch = hash.match(/[?&]agent=([^&]+)/);
        if (agentMatch) {
          const agentId = decodeURIComponent(agentMatch[1]);
          handleProjectFilesAgentChange(agentId);
          const sel = document.getElementById('project-files-agent');
          if (sel) sel.value = projectFilesAgentId || agentId;
        }
        // setAgent() is synchronous; call openFile immediately.
        // If agent is ready (has working_directory) it fetches directly.
        // If not yet ready, pendingFile stores it and activate() will process it.
        const panel = window.ProjectFiles;
        if (panel && typeof panel.openFile === 'function') {
          panel.openFile(filePath);
        }
      }
    }
  }, 500);
}
