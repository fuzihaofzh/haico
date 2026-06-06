import { initDashboardPage } from '../dashboard-core.js';
import { showToast } from '../../components/toast.js';
import {
  populateTypeOptions,
  resetForm,
  bindTypeChangeListener,
  getFormPayload,
  getProfileManager,
} from '../../shared/agent-tools-form.js';

async function initNewPage() {
  await initDashboardPage('settings');

  const form = document.querySelector('[data-agent-tools-form]');
  if (!form) return;

  // Initialize empty form
  populateTypeOptions(form.querySelector('[data-field="type"]'), 'claude');
  resetForm(form);
  bindTypeChangeListener(form);

  // Create button handler
  form.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-agent-tools-action="create"]');
    if (!button) return;

    await handleCreate(form, button);
  });
}

async function handleCreate(form, button) {
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
    const res = await fetch('/api/command-profiles', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Failed to create Agent Tool', 'error');
      return;
    }
    showToast('Agent Tool added', 'success');
    await getProfileManager()?.ensureLoaded(true);
    window.location.href = '/settings/agent-tools';
  });
}

initNewPage().catch((error) => {
  console.error('Failed to initialize Agent Tool new page', error);
});
