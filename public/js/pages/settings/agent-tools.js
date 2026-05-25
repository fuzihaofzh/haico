import { initDashboardPage } from '../dashboard-core.js';

const PROFILE_TYPE_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
];

function getCommandProfileManager() {
  return window.HAICOCommandProfiles || null;
}

function cloneTemplate(id) {
  const template = document.getElementById(id);
  return template?.content?.firstElementChild?.cloneNode(true) || null;
}

function populateTypeOptions(select, selectedType) {
  if (!select) return;
  select.replaceChildren(...PROFILE_TYPE_OPTIONS.map((option) => {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    item.selected = option.value === selectedType;
    return item;
  }));
}

function getConfigValue(profile) {
  const value = profile?.config_json;
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function hasConfigValues(config) {
  return Boolean(config && typeof config === 'object' && Object.keys(config).length);
}

function payloadForProfile(profile) {
  return {
    name: profile?.name || '',
    scenario: profile?.scenario || null,
    command: profile?.command || '',
    type: profile?.type || 'claude',
    config_json: getConfigValue(profile),
  };
}

function payloadKey(payload) {
  return JSON.stringify(payload || {});
}

function syncConfigState(row) {
  const container = row.querySelector('[data-command-profile-config]');
  const summary = row.querySelector('[data-config-summary]');
  if (!container) return;
  const configured = hasConfigValues(readConfigFields(row));
  container.dataset.configState = configured ? 'configured' : 'default';
  if (summary) summary.textContent = configured ? 'Configured' : 'Default';
}

function setProfileRowDirty(row, dirty) {
  row.classList.toggle('is-dirty', Boolean(dirty));
  row.querySelector('[data-command-profile-action="save"]')?.toggleAttribute('disabled', !dirty);
  row.querySelector('[data-command-profile-action="cancel"]')?.toggleAttribute('disabled', !dirty);
}

function updateProfileRowState(row) {
  const rowId = row.getAttribute('data-command-profile-row');
  if (!rowId || rowId === '__new__') {
    syncConfigState(row);
    return;
  }
  const profile = getCommandProfileManager()?.getById(rowId);
  const dirty = profile ? payloadKey(getRowPayload(row)) !== payloadKey(payloadForProfile(profile)) : false;
  syncConfigState(row);
  setProfileRowDirty(row, dirty);
}

function renderConfigFields(row, type, config) {
  const container = row.querySelector('[data-command-profile-config]');
  if (!container) return;
  const cfg = config || {};
  if (type === 'codex') {
    container.innerHTML = `
      <div class="command-profile-config-summary" data-config-summary></div>
      <label class="command-profile-config-field">Sandbox
        <select class="command-profile-select" data-config-field="sandbox">
          <option value="">Default</option>
          <option value="danger-full-access">danger-full-access</option>
          <option value="workspace-write">workspace-write</option>
          <option value="read-only">read-only</option>
        </select>
      </label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="skipGitRepoCheck"> Skip git repo check</label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="bypassApprovals"> Bypass approvals</label>
    `;
    container.querySelector('[data-config-field="sandbox"]').value = cfg.sandbox || '';
    container.querySelector('[data-config-field="skipGitRepoCheck"]').checked = Boolean(cfg.skipGitRepoCheck);
    container.querySelector('[data-config-field="bypassApprovals"]').checked = Boolean(cfg.bypassApprovals);
    syncConfigState(row);
    return;
  }
  if (type === 'gemini') {
    container.innerHTML = `
      <div class="command-profile-config-summary" data-config-summary></div>
      <label class="command-profile-config-field">Output
        <select class="command-profile-select" data-config-field="outputFormat">
          <option value="">Default</option>
          <option value="stream-json">stream-json</option>
          <option value="text">text</option>
          <option value="json">json</option>
        </select>
      </label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="sandbox"> Sandbox</label>
      <label class="command-profile-config-field">Approval
        <input type="text" class="command-profile-input" data-config-field="approvalMode" placeholder="yolo">
      </label>
    `;
    container.querySelector('[data-config-field="outputFormat"]').value = cfg.outputFormat || '';
    container.querySelector('[data-config-field="sandbox"]').checked = Boolean(cfg.sandbox);
    container.querySelector('[data-config-field="approvalMode"]').value = cfg.approvalMode || '';
    syncConfigState(row);
    return;
  }
  container.innerHTML = `
    <div class="command-profile-config-summary" data-config-summary></div>
    <label class="command-profile-config-field">Model
      <input type="text" class="command-profile-input" data-config-field="model" placeholder="claude-sonnet-4-6">
    </label>
    <label class="command-profile-config-field">Allowed tools
      <textarea class="command-profile-input command-profile-tools" data-config-field="allowedTools" placeholder="Bash, Edit, Read"></textarea>
    </label>
    <label class="command-profile-check"><input type="checkbox" data-config-field="verbose"> Verbose</label>
  `;
  container.querySelector('[data-config-field="model"]').value = cfg.model || '';
  container.querySelector('[data-config-field="allowedTools"]').value = Array.isArray(cfg.allowedTools)
    ? cfg.allowedTools.join(', ')
    : (cfg.allowedTools || '');
  container.querySelector('[data-config-field="verbose"]').checked = Boolean(cfg.verbose);
  syncConfigState(row);
}

function readConfigFields(row) {
  const type = row.querySelector('[data-field="type"]')?.value || 'claude';
  const config = {};
  if (type === 'codex') {
    const sandbox = row.querySelector('[data-config-field="sandbox"]')?.value?.trim() || '';
    if (sandbox) config.sandbox = sandbox;
    if (row.querySelector('[data-config-field="skipGitRepoCheck"]')?.checked) config.skipGitRepoCheck = true;
    if (row.querySelector('[data-config-field="bypassApprovals"]')?.checked) config.bypassApprovals = true;
    return config;
  }
  if (type === 'gemini') {
    const outputFormat = row.querySelector('[data-config-field="outputFormat"]')?.value?.trim() || '';
    const approvalMode = row.querySelector('[data-config-field="approvalMode"]')?.value?.trim() || '';
    if (outputFormat) config.outputFormat = outputFormat;
    if (row.querySelector('[data-config-field="sandbox"]')?.checked) config.sandbox = true;
    if (approvalMode) config.approvalMode = approvalMode;
    return config;
  }
  const model = row.querySelector('[data-config-field="model"]')?.value?.trim() || '';
  const allowedTools = row.querySelector('[data-config-field="allowedTools"]')?.value || '';
  if (model) config.model = model;
  const tools = allowedTools.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  if (tools.length) config.allowedTools = tools;
  if (row.querySelector('[data-config-field="verbose"]')?.checked) config.verbose = true;
  return config;
}

function fillProfileRow(row, profile) {
  row.dataset.commandProfileRow = profile.id;
  const nameInput = row.querySelector('[data-field="name"]');
  const scenarioInput = row.querySelector('[data-field="scenario"]');
  const commandInput = row.querySelector('[data-field="command"]');
  const typeSelect = row.querySelector('[data-field="type"]');
  if (nameInput) nameInput.value = profile.name || '';
  if (scenarioInput) scenarioInput.value = profile.scenario || '';
  if (commandInput) commandInput.value = profile.command || '';
  populateTypeOptions(typeSelect, profile.type || 'claude');
  renderConfigFields(row, profile.type || 'claude', getConfigValue(profile));
  setProfileRowDirty(row, false);
  return row;
}

function resetCreateForm() {
  const row = document.querySelector('[data-command-profile-create-form]');
  if (!row) return;
  row.querySelectorAll('[data-field]').forEach((field) => {
    if (field.matches('select')) return;
    field.value = '';
  });
  populateTypeOptions(row.querySelector('[data-field="type"]'), 'claude');
  renderConfigFields(row, 'claude', {});
}

function renderAgentTools() {
  const manager = getCommandProfileManager();
  const tbody = document.querySelector('[data-command-profiles-list]');
  const loading = document.querySelector('[data-command-profiles-loading]');
  const error = document.querySelector('[data-command-profiles-error]');
  if (!tbody) return;

  const profiles = manager?.getProfiles() || [];
  const loadError = manager?.getLoadError?.() || '';
  if (loading) loading.hidden = !manager?.isLoading?.();
  if (error) {
    error.hidden = !loadError;
    error.textContent = loadError;
  }

  tbody.replaceChildren();
  if (profiles.length) {
    profiles.forEach((profile) => {
      const row = cloneTemplate('command-profile-row-template');
      if (row) tbody.appendChild(fillProfileRow(row, profile));
    });
  } else {
    const emptyRow = cloneTemplate('command-profile-empty-row-template');
    if (emptyRow) tbody.appendChild(emptyRow);
  }
}

function getRowPayload(row) {
  return {
    name: row.querySelector('[data-field="name"]')?.value?.trim() || '',
    scenario: row.querySelector('[data-field="scenario"]')?.value?.trim() || null,
    command: row.querySelector('[data-field="command"]')?.value?.trim() || '',
    type: row.querySelector('[data-field="type"]')?.value || '',
    config_json: readConfigFields(row),
  };
}

async function submitProfile(action, row, button) {
  const payload = getRowPayload(row);
  if (!payload.name) {
    showToast('Agent Tool name is required', 'error');
    return;
  }
  if (!payload.command) {
    showToast('Agent command is required', 'error');
    return;
  }

  const rowId = row.getAttribute('data-command-profile-row');
  const endpoint = action === 'create' ? '/api/command-profiles' : `/api/command-profiles/${rowId}`;
  const method = action === 'create' ? 'POST' : 'PUT';

  await withLoading(button, async () => {
    const res = await fetch(endpoint, {
      method,
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Failed to save Agent Tool', 'error');
      return;
    }
    showToast(action === 'create' ? 'Agent Tool added' : 'Agent Tool saved', 'success');
    await getCommandProfileManager()?.ensureLoaded(true);
    renderAgentTools();
    if (action === 'create') resetCreateForm();
  });
}

async function deleteProfile(rowId, button) {
  const manager = getCommandProfileManager();
  const profile = manager?.getById(rowId);
  const label = profile?.name || 'this Agent Tool';
  const confirmed = await showConfirm(`Delete ${label}? Existing agents keep their stored command.`, {
    title: 'Delete Agent Tool?',
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!confirmed) return;

  await withLoading(button, async () => {
    const res = await fetch(`/api/command-profiles/${rowId}`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Failed to delete Agent Tool', 'error');
      return;
    }
    showToast('Agent Tool deleted', 'success');
    await manager?.ensureLoaded(true);
    renderAgentTools();
  });
}

function bindAgentToolsEvents() {
  document.querySelector('[data-command-profiles-root]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command-profile-action]');
    if (!button) return;

    const row = button.closest('[data-command-profile-row]');
    if (!row) return;

    const action = button.getAttribute('data-command-profile-action');
    if (action === 'save' || action === 'create') {
      await submitProfile(action, row, button);
      return;
    }

    if (action === 'cancel') {
      const profile = getCommandProfileManager()?.getById(row.getAttribute('data-command-profile-row'));
      if (profile) fillProfileRow(row, profile);
      return;
    }

    if (action === 'delete') {
      await deleteProfile(row.getAttribute('data-command-profile-row'), button);
    }
  });

  document.querySelector('[data-command-profiles-root]')?.addEventListener('change', (event) => {
    const select = event.target.closest('[data-field="type"]');
    if (!select) return;
    const row = select.closest('[data-command-profile-row]');
    if (!row) return;
    renderConfigFields(row, select.value || 'claude', readConfigFields(row));
    updateProfileRowState(row);
  });

  document.querySelector('[data-command-profiles-root]')?.addEventListener('input', (event) => {
    const row = event.target.closest('[data-command-profile-row]');
    if (row) updateProfileRowState(row);
  });

  document.querySelector('[data-command-profiles-root]')?.addEventListener('change', (event) => {
    const row = event.target.closest('[data-command-profile-row]');
    if (row) updateProfileRowState(row);
  });

  window.addEventListener('haico:command-profiles-changed', renderAgentTools);
}

async function initAgentToolsPage() {
  await initDashboardPage('settings');
  bindAgentToolsEvents();
  resetCreateForm();
  const loadProfiles = getCommandProfileManager()?.ensureLoaded();
  renderAgentTools();
  await loadProfiles;
  renderAgentTools();
}

initAgentToolsPage().catch((error) => {
  console.error('Failed to initialize Agent Tools settings', error);
});
