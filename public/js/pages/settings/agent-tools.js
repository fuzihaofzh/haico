import { initDashboardPage } from '../dashboard-core.js';
import { showConfirm } from '../../components/confirm.js';
import { showToast } from '../../components/toast.js';

function getCommandProfileManager() {
  return window.HAICOCommandProfiles || null;
}

function cloneTemplate(id) {
  const template = document.getElementById(id);
  return template?.content?.firstElementChild?.cloneNode(true) || null;
}

const TYPE_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

function fillReadOnlyRow(row, profile) {
  row.dataset.commandProfileRow = profile.id;

  const nameCell = row.querySelector('[data-cell="name"]');
  const scenarioCell = row.querySelector('[data-cell="scenario"]');
  const commandCell = row.querySelector('[data-cell="command"]');
  const typeCell = row.querySelector('[data-cell="type"]');

  if (nameCell) nameCell.textContent = profile.name || '';
  if (scenarioCell) {
    scenarioCell.textContent = profile.scenario || '';
    if (!profile.scenario) scenarioCell.classList.add('command-profile-empty-value');
  }
  if (commandCell) {
    commandCell.textContent = profile.command || '';
    commandCell.classList.add('command-profile-command');
  }
  if (typeCell) {
    const badge = typeCell.querySelector('.command-profile-type-badge');
    if (badge) badge.textContent = TYPE_LABELS[profile.type] || profile.type || '';
  }

  // Set Edit link target
  const editLink = row.querySelector('[data-action="edit"]');
  if (editLink) {
    editLink.href = `/settings/agent-tools/${profile.id}/edit`;
  }

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
      if (row) tbody.appendChild(fillReadOnlyRow(row, profile));
    });
  } else {
    const emptyRow = cloneTemplate('command-profile-empty-row-template');
    if (emptyRow) tbody.appendChild(emptyRow);
  }
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

function bindListEvents() {
  document.querySelector('[data-command-profiles-root]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="delete"]');
    if (!button) return;

    const row = button.closest('[data-command-profile-row]');
    if (!row) return;

    const rowId = row.getAttribute('data-command-profile-row');
    await deleteProfile(rowId, button);
  });

  window.addEventListener('haico:command-profiles-changed', renderAgentTools);
}

async function initAgentToolsListPage() {
  await initDashboardPage('settings');
  bindListEvents();
  const loadProfiles = getCommandProfileManager()?.ensureLoaded();
  renderAgentTools();
  await loadProfiles;
  renderAgentTools();
}

initAgentToolsListPage().catch((error) => {
  console.error('Failed to initialize Agent Tools list', error);
});
