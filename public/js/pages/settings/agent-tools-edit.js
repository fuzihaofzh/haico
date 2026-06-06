import { initDashboardPage } from '../dashboard-core.js';
import { showConfirm } from '../../components/confirm.js';
import { showToast } from '../../components/toast.js';
import {
  populateTypeOptions,
  renderConfigFields,
  readConfigFields,
  getFormPayload,
  fillFormFromProfile,
  bindTypeChangeListener,
  getProfileManager,
} from '../../shared/agent-tools-form.js';

function getProfileIdFromPath() {
  // Path: /settings/agent-tools/:id/edit
  const match = window.location.pathname.match(/\/settings\/agent-tools\/([^/]+)\/edit/);
  return match ? match[1] : null;
}

async function loadProfile(profileId) {
  const manager = getProfileManager();
  await manager?.ensureLoaded();
  const profile = manager?.getById(profileId);
  if (!profile) {
    const errorEl = document.querySelector('[data-agent-tools-error]');
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = 'Agent Tool not found. It may have been deleted.';
    }
    return null;
  }
  return profile;
}

async function initEditPage() {
  await initDashboardPage('settings');

  const profileId = getProfileIdFromPath();
  if (!profileId) {
    showToast('Invalid Agent Tool ID', 'error');
    window.location.href = '/settings/agent-tools';
    return;
  }

  const loadingEl = document.querySelector('[data-agent-tools-loading]');
  const errorEl = document.querySelector('[data-agent-tools-error]');
  const form = document.querySelector('[data-agent-tools-form]');

  if (!form) return;

  // Wait for profiles to load, then fill the form
  const profile = await loadProfile(profileId);
  if (!profile) {
    if (loadingEl) loadingEl.hidden = true;
    return;
  }

  if (loadingEl) loadingEl.hidden = true;

  // Populate the type select with options before filling
  populateTypeOptions(form.querySelector('[data-field="type"]'), profile.type || 'claude');

  // Fill form from profile data
  fillFormFromProfile(form, profile);

  // Bind type change listener to re-render config fields
  bindTypeChangeListener(form);

  // Event delegation for Save / Delete
  form.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-agent-tools-action]');
    if (!button) return;

    const action = button.getAttribute('data-agent-tools-action');

    if (action === 'save') {
      await handleSave(profileId, form, button);
      return;
    }

    if (action === 'delete') {
      await handleDelete(profileId, button);
    }
  });
}

async function handleSave(profileId, form, button) {
  const payload = getFormPayload(form);
  if (!payload.name) {
    showToast('Agent Tool name is required', 'error');
    return;
  }
  if (!payload.command) {
    showToast('Agent command is required', 'error');
    return;
  }

  await withLoading(button, async () => {
    const res = await fetch(`/api/command-profiles/${profileId}`, {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Failed to save Agent Tool', 'error');
      return;
    }
    showToast('Agent Tool saved', 'success');
    await getProfileManager()?.ensureLoaded(true);
    window.location.href = '/settings/agent-tools';
  });
}

async function handleDelete(profileId, button) {
  const manager = getProfileManager();
  const profile = manager?.getById(profileId);
  const label = profile?.name || 'this Agent Tool';
  const confirmed = await showConfirm(`Delete ${label}? Existing agents keep their stored command.`, {
    title: 'Delete Agent Tool?',
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!confirmed) return;

  await withLoading(button, async () => {
    const res = await fetch(`/api/command-profiles/${profileId}`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Failed to delete Agent Tool', 'error');
      return;
    }
    showToast('Agent Tool deleted', 'success');
    await manager?.ensureLoaded(true);
    window.location.href = '/settings/agent-tools';
  });
}

initEditPage().catch((error) => {
  console.error('Failed to initialize Agent Tool edit page', error);
});
