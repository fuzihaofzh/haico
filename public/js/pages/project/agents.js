async function updateTabCounts() {}
function syncProjectFilesAgents() {}
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

  const options = [h`<option value="">No parent (top-level agent)</option>`];
  agentsData.forEach((agent) => {
    if (excludedIds.has(agent.id)) return;
    const suffix = agent.is_controller ? ' [controller]' : '';
    const selected = selectedParentId && selectedParentId === agent.id ? h` selected` : '';
    options.push(h`<option value="${agent.id}"${html(selected)}>${agent.name}${suffix}</option>`);
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

function getDefaultCreateAgentParentId() {
  const controller = getControllerAgent();
  return controller ? controller.id : '';
}

function markCreateAgentParentChosen() {
  const select = document.getElementById('agent-parent');
  if (!select) return;
  select.dataset.userChosen = 'true';
}

function getCreateAgentParentValue() {
  const select = document.getElementById('agent-parent');
  if (!select) return '';
  const currentValue = select.value || '';
  if (currentValue) return currentValue;
  if (select.dataset.userChosen === 'true') return '';
  return select.dataset.defaultParentId || '';
}


function getCommandProfileManager() {
  return window.HAICOCommandProfiles || null;
}

async function populateCommandProfileSelect(select, options) {
  if (!select) return [];
  const manager = getCommandProfileManager();
  if (!manager) {
    select.innerHTML = h`
      <option value="">Use project default</option>
      <option value="${CUSTOM_COMMAND_PROFILE_VALUE}">Custom command</option>
    `;
    return [];
  }

  await manager.ensureLoaded();
  manager.populateSelect(select, options || {});
  return manager.getProfiles();
}

function setCommandProfileSelection(select, commandTemplate, commandType, commandProfileId) {
  if (!select) return;

  const manager = getCommandProfileManager();
  if (commandProfileId && manager?.getById(commandProfileId)) {
    select.value = commandProfileId;
    return;
  }
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

function updateCommandPreview(previewId, commandTemplate, commandType, fallbackText, commandProfileId) {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(commandProfileId || '') || manager?.findMatch(commandTemplate, commandType) || null;
  const command = String(commandTemplate || '').trim();
  preview.textContent = command
    ? selectedProfile
      ? `Agent Tool: ${manager?.formatLabel ? manager.formatLabel(selectedProfile) : `${selectedProfile.name} (${selectedProfile.type})`} · Command: ${command}`
      : `Command: ${command}${commandType ? ` (${commandType})` : ''}`
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
  updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Using project-level Agent Tool setting.', select.value);
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
    updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Using project-level Agent Tool setting.', select.value);
    return;
  }

  if (select.value === '') {
    input.value = '';
    input.dataset.commandType = '';
    updateCommandPreview('agent-cmdtpl-preview', '', '', 'Using project-level Agent Tool setting.');
    return;
  }

  updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Select an Agent Tool configured in Settings.');
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
  setCommandProfileSelection(select, agent?.command_template, agent?.command_type, agent?.command_profile_id);
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  input.value = selectedProfile?.command || String(agent?.command_template || '').trim();
  input.dataset.commandType = selectedProfile?.type || agent?.command_type || '';
  updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Using project-level Agent Tool setting.', select.value);
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
    updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Using project-level Agent Tool setting.', select.value);
    return;
  }

  if (select.value === '') {
    input.value = '';
    input.dataset.commandType = '';
    updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, '', '', 'Using project-level Agent Tool setting.');
    return;
  }

  updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Select an Agent Tool configured in Settings.');
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
      command_profile_id: selectedProfile.id,
      command_template: selectedProfile.command,
      command_type: selectedProfile.type,
    };
  }

  if (!commandTemplate) {
    return { command_profile_id: null, command_template: null, command_type: null };
  }

  return {
    command_profile_id: null,
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
  updateCommandPreview('agent-cmdtpl-preview', input.value, input.dataset.commandType, 'Using project-level Agent Tool setting.', select.value);
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
    setCommandProfileSelection(select, commandTemplate, selectedType, existingAgent?.command_profile_id);
    const selectedProfile = manager?.getById(select.value) || null;
    input.value = selectedProfile?.command || commandTemplate;
    input.dataset.commandType = selectedProfile?.type || selectedType || '';
    updateCommandPreview(`ad-cmdtpl-preview-${agentId}`, input.value, input.dataset.commandType, 'Using project-level Agent Tool setting.', select.value);
  }
}


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


function statusBadge(s) {
  const map = {
    'open':        h`<span class="status-badge status-active">open</span>`,
    'in_progress': h`<span class="status-badge status-running">in progress</span>`,
    'pending':     h`<span class="status-badge status-warning">pending</span>`,
    'done':        h`<span class="status-badge status-completed">done</span>`,
    'closed':      h`<span class="status-badge status-idle">closed</span>`,
  };
  return map[s] || s;
}

// ─── Project ───

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

  const createAgentParentSelect = document.getElementById('agent-parent');
  const createAgentModal = document.getElementById('createAgentModal');
  const createAgentParentId = createAgentModal?.classList.contains('active')
    ? getCreateAgentParentValue()
    : (createAgentParentSelect?.value || '');
  syncParentAgentSelect('agent-parent', null, createAgentParentId, !canManageProject());
  const list = document.getElementById('agent-list');
  const canManage = canManageProject();

  // Update tab count
  updateTabCounts();

  if (!agentsData.length) { list.innerHTML = h`<li class="empty-state">No agents yet.</li>`; return; }

  // Update issue assign dropdown (preserve current selection, default to controller)
  const assignSel = document.getElementById('issue-assign');
  if (assignSel) {
    const prev = assignSel.value;
    const controllerId = agentsData.find(a => a.is_controller)?.id || '';
    assignSel.innerHTML = h`<option value="">Select a recipient</option><option value="all">All (broadcast)</option><option value="user">User (me)</option>${html(
      agentsData.map(a => h`<option value="${a.id}">${a.name}${a.is_controller ? ' [controller]' : ''}</option>`).join('')
    )}`;
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
      const sr = await fetch(agentApiPath(a.id, '/status'), { headers: apiHeaders() });
      if (sr.ok) { const st = await sr.json(); errorLogs[a.id] = st.last_error || ''; }
    } catch (e) { console.error('Failed to fetch error logs for agent', a.id, e); }
  }));

  // Error banner for agents in error state
  const errorAgents = agentsData.filter(a => a.status === 'error');
  const bannerEl = document.getElementById('agent-error-banner');
  if (bannerEl) {
    if (errorAgents.length > 0) {
      bannerEl.style.display = '';
      bannerEl.innerHTML = errorAgents.map(a => {
        const errMsg = errorLogs[a.id] ? errorLogs[a.id].slice(0, 300) : 'Unknown error';
        const retryAction = canManage
          ? h`<button class="btn btn-sm" onclick="retryAgent('${a.id}')" style="margin-left:8px;color:var(--warning);padding:2px 8px">Retry</button>`
          : '';
        return h`<div style="margin-bottom:4px"><strong>${a.name}</strong> failed: <span style="font-family:monospace;font-size:11px">${errMsg}</span>${html(retryAction)}</div>`;
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
        new Notification('HAICO: Agent Error', { body: `${a.name} failed. ${(errorLogs[a.id] || '').slice(0, 100)}`, tag: 'haico-error-' + a.id });
      }
    }
  }

  // Render a single agent list item
  function renderAgentItem(a, depth) {
    const indent = depth * 20;
    const tag = a.is_controller ? h` <span style="color:var(--accent);font-size:11px">[controller]</span>` : '';
    const parentAgent = getDisplayParentAgent(a);
    const childAgents = getDirectChildAgents(a.id);
    const hierarchyMeta = depth > 0 ? '' : [
      parentAgent ? h`Parent ${parentAgent.name}` : null,
      childAgents.length > 0 ? `${childAgents.length} direct reports` : null,
    ].filter(Boolean).join(' · ');
    const errBox = a.status === 'error' && errorLogs[a.id]
      ? h`<div style="margin-top:4px;padding:6px 8px;background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.3);border-radius:4px;font-size:11px;color:var(--error);font-family:monospace;max-height:60px;overflow:auto;white-space:pre-wrap">${errorLogs[a.id].slice(0, 500)}</div>` : '';
    const spinner = a.status === 'running' ? h`<span class="thinking-spinner">✦</span> ` : '';
    const deleteBtn = canManage && !a.is_controller && a.status !== 'running'
      ? h`<button class="btn btn-sm" onclick="event.stopPropagation();deleteAgent('${a.id}')" style="color:var(--error);padding:3px 6px" title="Delete">✕</button>` : '';
    const runtime = a.runtime_state || {};
    const retryBtn = canManage && runtime.status === 'error' && runtime.last_task_run_id && !a.paused
      ? h`<button class="btn btn-sm" onclick="event.stopPropagation();retryAgent('${a.id}')" style="color:var(--warning);padding:3px 6px" title="Retry last prompt">Retry</button>` : '';
    const pauseBtn = canManage && !a.paused
      ? h`<button class="btn btn-sm" onclick="event.stopPropagation();pauseAgent('${a.id}')" style="color:var(--warning);padding:3px 6px" title="Pause agent">⏸</button>`
      : canManage
        ? h`<button class="btn btn-sm" onclick="event.stopPropagation();unpauseAgent('${a.id}')" style="color:var(--success);padding:3px 6px" title="Resume agent">▶</button>`
        : '';
    const chatBtn = canManage && !isRemoteProjectView
      ? h`<button class="btn btn-sm" onclick="event.stopPropagation();openTerminal('${a.id}')" style="padding:3px 6px" title="Open terminal chat">Chat</button>`
      : '';
    let actions;
    if (!canManage) {
      actions = '';
    } else if (a.paused) {
      actions = h`${html(chatBtn)}${html(pauseBtn)}${html(deleteBtn)}`;
    } else if (a.status === 'running') {
      actions = h`${html(chatBtn)}${html(pauseBtn)}<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();stopAgentById('${a.id}')">Stop</button>`;
    } else {
      actions = h`${html(chatBtn)}${html(pauseBtn)}${html(retryBtn)}<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();quickStartAgent('${a.id}')">Start</button>${html(deleteBtn)}`;
    }
    const selected = currentAgentId === a.id ? 'background:var(--selected-bg);' : '';
    const pausedStyle = a.paused ? 'opacity:0.55;' : '';
    const issuePills = (agentIssues[a.id] || []).length > 0
      ? h`<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px">${html((agentIssues[a.id] || []).map(iss => {
          const isActive = iss.status === 'in_progress';
          const bg = isActive ? 'rgba(63,185,80,0.15)' : 'rgba(88,166,255,0.1)';
          const border = isActive ? 'rgba(63,185,80,0.4)' : 'rgba(88,166,255,0.3)';
          const color = isActive ? 'var(--success, #3fb950)' : 'var(--accent)';
          const dot = isActive ? h`<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--success, #3fb950);margin-right:3px;animation:pulse 1.5s infinite"></span>` : '';
          return h`<a href="${issuePageHref(iss)}" onclick="event.stopPropagation()" style="display:inline-flex;align-items:center;padding:2px 6px;background:${bg};border:1px solid ${border};border-radius:3px;font-size:10px;color:${color};text-decoration:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="#${iss.number} ${iss.title} [${iss.status}]">${html(dot)}#${iss.number} ${iss.title}</a>`;
        }).join(''))}</div>`
      : (a.status !== 'error' ? h`<div style="margin-top:2px;font-size:10px;color:var(--text-secondary);opacity:0.5">Idle - no active tasks</div>` : '');
    return h`
    <li class="agent-item" style="cursor:pointer;padding-left:${indent}px;${selected}${pausedStyle}" onclick="viewAgent('${a.id}')">
      <div style="flex-shrink:0;margin-right:8px">${html(roleAvatarHtml(a.name, 32, projectData?.color))}</div>
      <div class="agent-info">
        <div class="agent-name">${html(spinner)}${a.name}${html(tag)}</div>
        <div class="agent-role">${a.role}</div>
        ${hierarchyMeta ? html(h`<div style="margin-top:3px;font-size:10px;color:var(--text-secondary)">${html(hierarchyMeta)}</div>`) : ''}
        ${html(issuePills)}
        ${html(errBox)}
      </div>
      <div class="flex" style="gap:8px">
        <span class="status-badge status-${a.paused ? 'paused' : a.status}">${a.paused ? 'paused' : a.status}</span>
        ${html(actions)}
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
const AGENT_OUTPUT_POLL_MS = 5000;
let agentOutputPollTimer = null;
let agentOutputPollingAgentId = null;
let agentOutputRefreshInFlight = false;
const agentOutputLogState = new Map();

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
  el.innerHTML = h`<div class="card">${html(renderLoading('Loading agent details...'))}</div>`;

  try {
    const agentRes = await fetch(agentApiPath(agentId, ''), { headers: apiHeaders() });
    const agent = agentRes.ok ? await agentRes.json() : agentsData.find(a => a.id === agentId);
    const canManage = canManageProject();
    const parentAgent = getDisplayParentAgent(agent);
    const childAgents = getDirectChildAgents(agentId);
    const readOnlyAttr = canManage ? '' : 'disabled';
    const readonlyNote = canManage
      ? ''
      : h`<div class="project-readonly-banner" style="display:block;margin-bottom:16px">This is a shared read-only view. You cannot start, pause, retry, delete, chat with, or edit this agent.</div>`;
    const detailActions = canManage && !isRemoteProjectView
      ? h`
              <button class="btn btn-sm" onclick="openTerminal('${agentId}')" title="Open terminal chat">Chat</button>
              <a class="btn btn-sm" href="/project/${projectId}/agent/${agentId}/edit" title="Edit agent configuration">Edit</a>
              ${(agent.runtime_state || {}).status === 'error' && (agent.runtime_state || {}).last_task_run_id ? html(h`<button class="btn btn-sm" onclick="retryAgent('${agentId}')" style="color:var(--warning)">Retry</button>`) : ''}
      `
      : '';
    const saveSettingsButton = canManage
      ? h`<button class="btn btn-primary" onclick="saveAllAgentFields('${agentId}')">Save Settings</button>`
      : '';
    const controllerTag = agent.is_controller
      ? h`<span style="color:var(--accent);font-size:12px">[controller]</span>`
      : '';
    const statusPid = agent.pid ? ` (PID:${agent.pid})` : '';
    const sessionPreview = agent.session_id ? agent.session_id.slice(0, 8) + '...' : 'none';
    const directReports = childAgents.length > 0
      ? childAgents.map((child) => h`${child.name}`).join(', ')
      : 'None';
    const parentDisabledAttr = !canManage || agent.is_controller ? 'disabled' : '';

    const L = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:4px';
    const B = 'padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px';

    // Step 1: Render config immediately (no logs yet)
    el.innerHTML = h`
      <div class="card" style="padding:0">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
          <div class="flex-between">
            <h3 style="display:flex;align-items:center;gap:8px">${html(roleAvatarHtml(agent.name, 28, projectData?.color))} ${agent.name} ${html(controllerTag)}</h3>
            <div class="flex" style="gap:6px">
              ${html(detailActions)}
              <span class="status-badge status-${agent.status}">${agent.status}${statusPid}</span>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${agent.role}</div>
        </div>

        <div id="agent-detail-scroll" style="padding:16px 20px">
          ${html(readonlyNote)}
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(120px, 1fr));gap:8px 16px;font-size:12px;color:var(--text-secondary);margin-bottom:16px">
            <div>Started: <span style="color:var(--fg)">${formatLocalDateTime(agent.started_at)}</span></div>
            <div>Finished: <span style="color:var(--fg)">${formatLocalDateTime(agent.finished_at)}</span></div>
            <div>Session: <code style="color:var(--fg);font-size:10px">${sessionPreview}</code></div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:12px;margin-bottom:16px">
            <div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
              <div style="${L}">Direct Parent</div>
              <div style="font-size:13px;color:var(--fg)">${parentAgent ? parentAgent.name : 'None'}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${parentAgent ? 'Messages are limited to this parent and direct reports.' : 'Without a parent, this agent is not restricted by hierarchy messaging rules.'}</div>
            </div>
            <div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
              <div style="${L}">Direct Reports</div>
              <div style="font-size:13px;color:var(--fg)">${html(directReports)}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${childAgents.length > 0 ? `${childAgents.length} direct reports total.` : 'This agent has no direct reports.'}</div>
            </div>
          </div>

          <div id="agent-git-status-${agentId}" style="margin-bottom:16px"></div>

          <div id="agent-cost-${agentId}" style="margin-bottom:16px"></div>

          <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="${L}">Working Directory</div>
              <input type="text" id="ad-workdir-${agentId}" value="${agent.working_directory || ''}" placeholder="(default)" ${readOnlyAttr} style="${B};width:100%;font-size:12px;font-family:monospace;color:var(--fg)">
            </div>
            <div style="flex:1;min-width:200px">
              <div style="${L}">Agent Tool</div>
              <select id="ad-cmdprof-${agentId}" onchange="handleAgentCommandProfileChange('${agentId}')" ${readOnlyAttr} style="${B};width:100%;font-size:12px;color:var(--fg)">
                <option value="">Loading...</option>
              </select>
              <input type="hidden" id="ad-cmdtpl-${agentId}" value="${agent.command_template || ''}">
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
              <select id="ad-parent-${agentId}" ${parentDisabledAttr} style="${B};width:100%;font-size:12px;color:var(--fg)">
                ${html(buildParentAgentOptions(agentId, agent.parent_agent_id))}
              </select>
              <div style="font-size:10px;color:var(--text-secondary);opacity:0.6;margin-top:2px">${agent.is_controller ? 'The controller stays at the root by default.' : 'You cannot choose this agent or its descendants as the parent.'}</div>
            </div>
          </div>

          <div style="margin-bottom:16px">
            <div style="${L}">Custom Instructions</div>
            <textarea id="ad-instructions-${agentId}" rows="3" ${readOnlyAttr} style="${B};width:100%;font-size:12px;font-family:inherit;color:var(--fg);resize:vertical" placeholder="Extra instructions appended to system prompt...">${agent.custom_instructions || ''}</textarea>
          </div>

          <div style="margin-bottom:16px;text-align:right">
            ${html(saveSettingsButton)}
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
    el.innerHTML = h`<div class="card">${html(renderError(e, `viewAgent('${agentId}')`))}</div>`;
  }
}

async function loadAgentCost(agentId) {
  const container = document.getElementById('agent-cost-' + agentId);
  if (!container) return;
  try {
    const res = await fetch(agentApiPath(agentId, '/costs'), { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    if (data.total_runs === 0) { container.innerHTML = ''; return; }

    const fmtCostAgent = v => v > 0 ? (v < 0.01 ? '<$0.01' : '$' + v.toFixed(2)) : 'N/A';
    const fmtTokens = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;
    const avgCost = data.total_runs > 0 ? data.total_cost_usd / data.total_runs : 0;

    container.innerHTML = h`
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
    const res = await fetch(agentApiPath(agentId, '/git-status'), { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    if (!data.branch) { container.innerHTML = ''; return; }

    const lastCommit = data.recent_commits && data.recent_commits[0]
      ? h`<code style="color:var(--accent)">${data.recent_commits[0].hash}</code> ${data.recent_commits[0].message.slice(0, 50)} <span style="color:var(--text-secondary)">${timeAgo(data.recent_commits[0].date)}</span>`
      : h`<span style="color:var(--text-secondary)">no commits</span>`;
    const uncommitted = data.has_uncommitted
      ? h`<span style="color:var(--warning)"> | ${(data.uncommitted_files || []).length} uncommitted files</span>` : '';

    container.innerHTML = h`
      <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;word-break:break-word;overflow-wrap:break-word">
        <span style="font-family:monospace;background:var(--card);padding:2px 8px;border-radius:10px;border:1px solid var(--border)">${data.branch}</span>
        <span style="margin-left:8px">Last commit: ${html(lastCommit)}</span>${html(uncommitted)}
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
    const cachedState = agentOutputLogState.get(agentId);
    const useIncremental = opts.silent && cachedState && cachedState.lastLogId > 0;
    const logsUrl = useIncremental
      ? `${agentApiPath(agentId, '/logs')}?since_id=${cachedState.lastLogId}&limit=100`
      : `${agentApiPath(agentId, '/logs')}?limit=100`;
    const logsRes = await fetch(logsUrl, { headers: apiHeaders() });
    const fetchedLogs = logsRes.ok ? await logsRes.json() : [];
    if (useIncremental && fetchedLogs.length === 0) return;
    let logs = fetchedLogs;
    if (useIncremental) {
      logs = cachedState.logs.concat(fetchedLogs).slice(-500);
    } else {
      logs.reverse();
    }
    const lastLogId = logs.length ? Math.max(...logs.map(l => l.id || 0)) : 0;
    agentOutputLogState.set(agentId, { logs, lastLogId });

    // Group by run, only show last 3 runs
    const runs = [];
    let curRun = null;
    for (const l of logs) {
      if (l.run_id !== curRun) { curRun = l.run_id; runs.push({ id: l.run_id, logs: [] }); }
      runs[runs.length - 1].logs.push(l);
    }
    // Show last 5 runs, oldest first (newest at bottom)
    const recentRuns = runs.slice(-5);

    const markup = recentRuns.map((run, idx) => {
      const filtered = run.logs.filter(l =>
        l.stream !== 'cost' && !l.content.includes('proxychains') &&
        !l.content.includes('Executing through proxy') && !l.content.includes('Port 7897')
      );
      if (!filtered.length) return '';
      const content = filtered.map(l => {
        const ts = l.created_at ? h`<span style="color:var(--text-secondary);opacity:0.7;cursor:default" title="${formatLocalDateTime(l.created_at)}">[${formatLocalTime(l.created_at)}]</span> ` : '';
        if (l.stream === 'stdin') {
          const inputHtml = renderCollapsibleText(l.content, { previewChars: 240, style: 'display:flex;width:100%;margin-top:4px' });
          return h`<div style="background:var(--accent-bg, rgba(59,130,246,0.08));border-left:3px solid var(--accent);padding:4px 8px;margin:4px 0;border-radius:0 4px 4px 0">${html(ts)}<span style="color:var(--accent);font-weight:600">▶ INPUT</span><div>${html(inputHtml)}</div></div>`;
        }
        const text = l.content.length > 1500 ? l.content.slice(0, 1500) + '\n... (truncated)' : l.content;
        const msg = l.stream === 'stderr' ? h`<span style="color:var(--error)">${text}</span>` : h`${text}`;
        return h`${html(ts)}${html(msg)}`;
      }).join('');
      const label = idx === recentRuns.length - 1 ? 'Latest Run' : `${recentRuns.length - idx} runs ago`;
      return h`<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:600;color:var(--text-secondary);margin-bottom:2px">${label}</div><div>${html(content)}</div></div>`;
    }).filter(Boolean).join(h`<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">`);

    const nextHtml = markup
      ? h`<div style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-word;margin:0;line-height:1.5;overflow-x:hidden;max-height:400px;overflow-y:auto">${html(markup)}</div>`
      : h`<span style="color:var(--text-secondary)">No history yet.</span>`;

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
    const res = await fetch(agentApiPath(agentId, ''), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
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
    const res = await fetch(agentApiPath(agentId, '/system-prompt'), { headers: apiHeaders() });
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
    const res = await fetch(`${agentApiPath(agentId, '/task-runs')}?limit=10`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = renderError({ status: res.status }, 'loadRunHistory(\'' + agentId + '\')'); return; }
    const data = await res.json();
    const runs = data.task_runs || [];
    if (!runs.length) { container.innerHTML = h`<span style="color:var(--text-secondary);font-size:12px">No runs yet.</span>`; return; }

    const fmtDur = ms => {
      if (!ms) return '-';
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    };
    const runDuration = r => {
      if (!r.task_run_started_at || !r.task_run_finished_at) return 0;
      return Math.max(0, new Date(r.task_run_finished_at).getTime() - new Date(r.task_run_started_at).getTime());
    };

    container.innerHTML = h`<div style="display:flex;flex-direction:column;gap:6px">${html(runs.map((r) => {
      const failed = r.task_run_status === 'failed';
      const running = r.task_run_status === 'running' || r.task_run_status === 'starting';
      const statusColor = failed ? 'var(--error)' : running ? 'var(--warning)' : 'var(--success)';
      const statusIcon = failed ? '✕' : running ? '…' : '✓';
      const failure = r.task_run_failure_message || r.task_failure_message || '';
      const clickAttr = r.run_id ? h`onclick="viewRunReport('${agentId}','${r.run_id}')"` : '';
      const failureHtml = failure
        ? h`<div style="margin-top:4px;color:var(--error);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${failure.slice(0, 180)}</div>`
        : '';
      return h`<div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:${r.run_id ? 'pointer' : 'default'}" ${html(clickAttr)}>
        <div style="display:flex;align-items:center;gap:10px;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:${statusColor};font-weight:600">${statusIcon}</span>
            <span style="color:var(--text-secondary)">${timeAgo(r.task_run_created_at)}</span>
            <span style="font-family:monospace;color:var(--text-secondary)">attempt ${r.attempt}</span>
            <span>${r.task_type || 'task'}</span>
          </div>
          <div style="display:flex;gap:12px;color:var(--text-secondary);font-size:11px">
            <span>${r.task_run_status}</span>
            <span title="Duration">${fmtDur(runDuration(r))}</span>
          </div>
        </div>
        <div style="margin-top:4px;color:var(--fg);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.reason || r.prompt_preview || ''}</div>
        ${html(failureHtml)}
      </div>`;
    }).join(''))}</div>`;
  } catch {
    container.innerHTML = renderError(null, 'loadRunHistory(\'' + agentId + '\')');
  }
}

async function viewRunReport(agentId, runId) {
  const container = document.getElementById('agent-runs-' + agentId);
  if (!container) return;
  container.innerHTML = renderLoading('Loading report...', true);
  try {
    const res = await fetch(agentApiPath(agentId, `/runs/${encodeURIComponent(String(runId || ''))}/report`), { headers: apiHeaders() });
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
      .map(([name, count]) => h`<span style="padding:2px 8px;background:rgba(88,166,255,0.1);border:1px solid rgba(88,166,255,0.3);border-radius:12px;font-size:10px">${name} ×${count}</span>`)
      .join(' ');

    // File changes
    const filesHtml = (r.summary.files_changed || []).map(f =>
      h`<div style="font-family:monospace;font-size:11px;padding:2px 0">${f}</div>`
    ).join('') || h`<span style="color:var(--text-secondary)">None</span>`;

    // Tool call timeline
    const toolsHtml = (r.tool_calls || []).map((tc, i) => {
      const inputHtml = renderCollapsibleText(tc.input, { previewChars: 100, style: 'width:100%' });
      const result = tc.result
        ? h`<div style="margin-left:26px;color:var(--text-secondary);font-family:monospace;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px">${tc.result.slice(0, 150)}</div>`
        : '';
      return h`<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:11px">
        <div style="display:flex;gap:6px;align-items:flex-start">
          <span style="color:var(--accent);font-weight:600;min-width:20px">${i + 1}.</span>
          <span style="color:var(--accent);font-weight:500">${tc.name}</span>
          <div style="min-width:0;flex:1;color:var(--text-secondary);font-family:monospace">${html(inputHtml)}</div>
        </div>
        ${html(result)}
      </div>`;
    }).join('');

    const errorMessage = r.error_message
      ? h`<div style="margin-bottom:12px;padding:8px;background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.3);border-radius:4px;font-size:11px;color:var(--error);font-family:monospace;white-space:pre-wrap">${r.error_message.slice(0, 500)}</div>`
      : '';
    const toolFrequency = toolFreqHtml
      ? h`<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Tool Usage</div><div style="display:flex;gap:6px;flex-wrap:wrap">${html(toolFreqHtml)}</div></div>`
      : '';
    const changedFiles = r.summary.files_changed.length > 0
      ? h`<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Files Changed (${r.summary.files_changed.length})</div>${html(filesHtml)}</div>`
      : '';
    const finalResult = r.final_result
      ? h`<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Final Result</div><pre style="padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0;max-height:200px;overflow-y:auto">${r.final_result.slice(0, 1000)}</pre></div>`
      : '';
    const toolTimeline = toolsHtml
      ? h`<div><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Tool Call Timeline (${r.tool_calls.length})</div><div style="max-height:300px;overflow-y:auto">${html(toolsHtml)}</div></div>`
      : '';

    container.innerHTML = h`
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

        ${html(errorMessage)}
        ${html(toolFrequency)}
        ${html(changedFiles)}
        ${html(finalResult)}
        ${html(toolTimeline)}
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
  if (!await showConfirm(`Delete agent "${agent?.name || id}"?`, {
    title: 'Delete agent?',
    confirmLabel: 'Delete agent',
    tone: 'danger',
  })) return;
  const res = await fetch(agentApiPath(id, ''), { method: 'DELETE' });
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
    const res = await fetch(agentApiPath(id, '/retry'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({}),
    });
    if (res.ok) {
      invalidateProjectResources(['agents']);
      loadAgents({ force: true });
      if (currentAgentId === id) viewAgent(id);
      showToast('Retry started', 'success');
      return;
    }
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to retry', 'error');
  });
}

function openTerminal(agentId) {
  if (!requireProjectManageAccess('Insufficient permission to open the agent terminal')) return;
  if (isRemoteProjectView || isRemoteAgentId(agentId)) {
    showToast('Remote agent terminal is not available in the local dashboard yet', 'error');
    return;
  }
  window.location.href = `${buildAgentPageHref(agentId)}?newSession=true`;
}

async function quickStartAgent(id) {
  showToast('Open the agent and start with an explicit prompt.', 'error');
}
async function pauseAgent(id) {
  if (!requireProjectManageAccess('Insufficient permission to pause agent')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(agentApiPath(id, '/pause'), { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent paused', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to pause', 'error'); }
  });
}

async function unpauseAgent(id) {
  if (!requireProjectManageAccess('Insufficient permission to resume agent')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(agentApiPath(id, '/unpause'), { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent resumed', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to resume', 'error'); }
  });
}

async function stopAgentById(id) {
  if (!requireProjectManageAccess('Insufficient permission to stop agent')) return;
  if (!await showConfirm('Stop this agent?', {
    title: 'Stop agent?',
    confirmLabel: 'Stop',
  })) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(agentApiPath(id, '/stop'), { method: 'POST', headers: apiHeaders(), body: '{}' });
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
  const parentSelect = document.getElementById('agent-parent');
  const defaultParentId = getDefaultCreateAgentParentId();
  if (parentSelect) {
    parentSelect.dataset.defaultParentId = defaultParentId;
    delete parentSelect.dataset.userChosen;
  }
  syncParentAgentSelect('agent-parent', null, defaultParentId, false);
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
    const parentAgentId = getCreateAgentParentValue() || null;
    const body = {
      name: document.getElementById('agent-name').value,
      role: document.getElementById('agent-role').value,
      working_directory: document.getElementById('agent-workdir').value || undefined,
      parent_agent_id: parentAgentId,
      ...commandConfig,
    };
    if (!body.name) { showToast('Name is required', 'error'); return; }
    const res = await fetch(projectApiPath('/agents'), { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) { hideModal('createAgentModal'); invalidateProjectResources(['agents']); loadAgents({ force: true }); showToast('Agent created', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to create', 'error'); }
  });
}

// ─── Issues ───


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

  let svg = h`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;margin:0 auto">`;

  // Draw edges using only explicit parent_agent_id
  agentsData.forEach((agent) => {
    const pid = agent.parent_agent_id;
    if (!pid || !byId.has(pid)) return;
    const parentPos = positions.get(pid);
    const childPos = positions.get(agent.id);
    if (!parentPos || !childPos) return;

    const dispatched = graphContext.dispatchedAgents.has(agent.id);
    svg += h`<line x1="${parentPos.x + nodeW / 2}" y1="${parentPos.y}" x2="${childPos.x - nodeW / 2}" y2="${childPos.y}" stroke="${dispatched ? 'var(--accent)' : 'var(--border)'}" stroke-width="${dispatched ? 2.2 : 1.2}" opacity="${dispatched ? 0.95 : 0.7}"/>`;

    if (dispatched) {
      const mx = (parentPos.x + childPos.x) / 2;
      const my = (parentPos.y + childPos.y) / 2;
      svg += h`<text x="${mx}" y="${my - 8}" text-anchor="middle" fill="var(--accent)" font-size="8">dispatch</text>`;
    }
  });

  // Draw nodes
  agentsData.forEach((agent) => {
    const position = positions.get(agent.id);
    if (!position) return;
    const color = getAgentGraphStatusColor(agent);
    const pulse = agent.status === 'running'
      ? h`<animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite"/>`
      : '';
    const assignedCount = (window._dashboardIssues || []).filter((issue) => issue.assigned_to === agent.id && ['open', 'in_progress', 'pending'].includes(issue.status)).length;
    const childCount = (childrenMap.get(agent.id) || []).length;
    const dispatched = graphContext.dispatchedAgents.has(agent.id);
    const reason = graphContext.actionReasonByAgent.get(agent.id);
    const statusLabel = agent.paused ? 'paused' : agent.status;
    const metaParts = [statusLabel, assignedCount > 0 ? assignedCount + ' tasks' : null, childCount > 0 ? childCount + ' child' : null].filter(Boolean).join(' · ');
    const pausedAttr = agent.paused ? h` stroke-dasharray="4,4"` : '';

    svg += h`<g style="cursor:pointer" onclick="viewAgent('${agent.id}')">
      <rect x="${position.x - nodeW / 2}" y="${position.y - nodeH / 2}" width="${nodeW}" height="${nodeH}" rx="8" fill="${color}22" stroke="${color}" stroke-width="${dispatched ? '2.8' : '2'}"${html(pausedAttr)}>${html(pulse)}</rect>
      <text x="${position.x}" y="${position.y - 2}" text-anchor="middle" fill="var(--fg)" font-size="11" font-weight="600">${agent.name}</text>
      <text x="${position.x}" y="${position.y + 12}" text-anchor="middle" fill="${dispatched ? 'var(--accent)' : color}" font-size="8.5">${metaParts || statusLabel}</text>
      <title>${[agent.name, reason].filter(Boolean).join(' · ')}</title>
    </g>`;
  });

  svg += h`</svg>`;

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
    ? h`<div style="font-size:11px;color:var(--text-secondary);margin-top:6px">Latest decision: <span style="color:var(--fg)">${graphContext.latestRun.decision || '-'}</span> · ${timeAgo(graphContext.latestRun.created_at)}</div>`
    : h`<div style="font-size:11px;color:var(--text-secondary);margin-top:6px">No orchestration decision records yet.</div>`;

  container.innerHTML = h`<div class="card" style="padding:12px;text-align:center">
    <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:8px">${graph.title}</div>
    <div style="max-height:420px;overflow-y:auto;overflow-x:auto;padding:4px 0">${html(graph.svg)}</div>
    <div style="font-size:11px;color:var(--text-secondary);margin-top:8px">${graph.note}</div>
    ${html(runInfo)}
  </div>`;
}

function getLatestOrchestrationRun() {
  if (!Array.isArray(orchestrationRunsData) || orchestrationRunsData.length === 0) return null;
  return orchestrationRunsData[0];
}

async function loadOrchestrationRuns() {
  const container = document.getElementById('orchestration-decision-container');
  if (!container) return;
  try {
    const res = await fetch(projectApiPath('/orchestration-runs') + '?limit=12', { headers: apiHeaders() });
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
    container.innerHTML = h`<div class="card" style="padding:12px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:8px">Orchestration Decisions</div>
      <div class="empty-state" style="padding:8px 0">No orchestration runs yet.</div>
    </div>`;
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
  const backoffLabel = latest.backoff_label || '';
  const backoffMinutes = latest.backoff_ms ? Math.round(Number(latest.backoff_ms) / 60000) : 0;
  const backoffReason = latest.backoff_reason || '';
  const backoffHtml = backoffLabel
    ? h`<div style="margin-bottom:8px;padding:8px;border:1px solid var(--warning);border-radius:8px;background:rgba(210,153,34,0.08)">
        <div style="font-size:11px;font-weight:600;color:var(--warning)">Backoff active: ${backoffLabel}${backoffMinutes ? ` (${String(backoffMinutes)}m)` : ''}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${backoffReason || 'No additional details'}</div>
      </div>`
    : '';

  const reasonsHtml = reasons.length
    ? reasons.slice(0, 5).map((r) => h`<li style="margin:2px 0">${r}</li>`).join('')
    : h`<li style="margin:2px 0;color:var(--text-secondary)">none</li>`;

  const dispatchHtml = dispatchResults.length
    ? dispatchResults.slice(0, 10).map((r) => {
      const agent = agentsData.find(a => a.id === r.agentId);
      const name = agent ? agent.name : r.agentId;
      const status = r.started ? 'started' : 'skipped';
      const color = r.started ? 'var(--success)' : 'var(--warning)';
      return h`<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border);font-size:12px">
        <div style="min-width:0"><strong>${name}</strong><div style="color:var(--text-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px">${r.message || ''}</div></div>
        <span style="color:${color};font-weight:600;flex-shrink:0">${status}</span>
      </div>`;
    }).join('')
    : h`<div style="color:var(--text-secondary);font-size:12px">No worker dispatch this run.</div>`;

  const history = orchestrationRunsData.slice(0, 8).map((r) => {
    const c = decisionColors[r.decision] || 'var(--text-secondary)';
    const backoffNote = r.backoff_label ? h` · backoff ${r.backoff_label}` : '';
    return h`<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:3px 0;border-bottom:1px dashed var(--border)">
      <span><span style="color:${c};font-weight:600">${r.decision || '-'}</span> · ${r.engine || '-'}${html(backoffNote)}</span>
      <span style="color:var(--text-secondary)">${timeAgo(r.created_at)}</span>
    </div>`;
  }).join('');

  container.innerHTML = h`<div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6">Orchestration Decisions</div>
      <button class="btn btn-sm" onclick="loadOrchestrationRuns()">Refresh</button>
    </div>

    <div style="display:grid;grid-template-columns:1.2fr 1.8fr;gap:12px">
      <div style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
        <div style="font-size:12px;margin-bottom:4px">Latest: <strong style="color:${decisionColor}">${latest.decision || '-'}</strong></div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">engine=${latest.engine || '-'} · ${timeAgo(latest.created_at)}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">dispatch=${String(latest.dispatch_count || 0)} · controller=${latest.controller_started ? 'started' : 'not started'}</div>
        ${html(backoffHtml)}
        <div style="font-size:11px;font-weight:600;margin-bottom:4px">Reasons</div>
        <ul style="margin:0 0 8px 16px;padding:0;font-size:11px">${html(reasonsHtml)}</ul>
        <div style="font-size:11px;font-weight:600;margin-bottom:4px">Planned actions</div>
        <div style="font-size:11px;color:var(--text-secondary)">${String(actions.length)} action(s)</div>
      </div>

      <div style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
        <div style="font-size:11px;font-weight:600;margin-bottom:6px">Dispatch Results</div>
        <div style="max-height:165px;overflow:auto">${html(dispatchHtml)}</div>
        <div style="font-size:11px;font-weight:600;margin-top:10px;margin-bottom:4px">Recent Runs</div>
        <div style="max-height:120px;overflow:auto">${html(history)}</div>
      </div>
    </div>
  </div>`;
}

// ─── Cost Time-Series Chart ───
window.addEventListener("haico:command-profiles-changed", () => {
  refreshCreateAgentCommandProfileControls().catch((error) => console.error("Failed to refresh create-agent command profile controls", error));
  refreshVisibleAgentCommandProfileControls().catch((error) => console.error("Failed to refresh agent command profile controls", error));
});

(async function initAgentsPage(){
  await loadProjectShell();
  await loadAgents();
  const params = new URLSearchParams(window.location.search);
  const agentId = params.get("agent");
  if (agentId) viewAgent(agentId);
  setInterval(() => { loadAgents(); }, 30000);
  const events = connectProjectEvents(projectId);
  events.on("agent_status", function(data) {
    loadAgents();
    if (currentAgentId === data.agentId) loadAgentOutput(data.agentId);
  });
})();
