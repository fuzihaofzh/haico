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

function fillProfileRow(row, profile) {
  row.dataset.commandProfileRow = profile.id;
  const nameInput = row.querySelector('[data-field="name"]');
  const commandInput = row.querySelector('[data-field="command"]');
  const typeSelect = row.querySelector('[data-field="type"]');
  if (nameInput) nameInput.value = profile.name || '';
  if (commandInput) commandInput.value = profile.command || '';
  populateTypeOptions(typeSelect, profile.type || 'claude');
  return row;
}

function buildNewProfileRow() {
  const row = cloneTemplate('command-profile-new-row-template');
  if (!row) return null;
  populateTypeOptions(row.querySelector('[data-field="type"]'), 'claude');
  return row;
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

  const newRow = buildNewProfileRow();
  if (newRow) tbody.appendChild(newRow);
}

function getRowPayload(row) {
  return {
    name: row.querySelector('[data-field="name"]')?.value?.trim() || '',
    command: row.querySelector('[data-field="command"]')?.value?.trim() || '',
    type: row.querySelector('[data-field="type"]')?.value || '',
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

    if (action === 'delete') {
      await deleteProfile(row.getAttribute('data-command-profile-row'), button);
    }
  });

  window.addEventListener('haico:command-profiles-changed', renderAgentTools);
}

async function initAgentToolsPage() {
  await initDashboardPage('settings');
  bindAgentToolsEvents();
  const loadProfiles = getCommandProfileManager()?.ensureLoaded();
  renderAgentTools();
  await loadProfiles;
  renderAgentTools();
}

initAgentToolsPage().catch((error) => {
  console.error('Failed to initialize Agent Tools settings', error);
});
