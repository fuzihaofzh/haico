import { initRemoteInstancesPanel } from './remote-instances.js';

// Load current settings from API
async function initGlobalSettingsTab() {
  try {
    const res = await fetch('/api/admin/settings');
    if (res.ok) {
      const settings = await res.json();
      const retentionInput = document.getElementById('log-retention-days');
      if (retentionInput && typeof settings.log_retention_days === 'number') {
        retentionInput.value = String(settings.log_retention_days);
      }
      const toggleBtn = document.getElementById('event-log-toggle');
      if (toggleBtn && typeof settings.event_log_enabled === 'boolean') {
        toggleBtn.classList.toggle('on', settings.event_log_enabled);
        toggleBtn.setAttribute('aria-checked', String(settings.event_log_enabled));
      }
    }
  } catch { /* ignore — defaults from HTML are fine */ }

  // Log retention
  const retentionInput = document.getElementById('log-retention-days');
  if (retentionInput) {
    retentionInput.addEventListener('change', async () => {
      const value = parseInt(retentionInput.value, 10);
      if (isNaN(value) || value < 1) {
        retentionInput.value = '30';
        return;
      }
      try {
        await fetch('/api/admin/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ log_retention_days: value }),
        });
        if (window.showToast) window.showToast('Log retention updated', 'success');
      } catch {
        if (window.showToast) window.showToast('Failed to update log retention', 'error');
      }
    });
  }

  // Event log toggle
  const toggleBtn = document.getElementById('event-log-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      const isOn = toggleBtn.classList.contains('on');
      toggleBtn.classList.toggle('on', !isOn);
      toggleBtn.setAttribute('aria-checked', String(!isOn));
      try {
        await fetch('/api/admin/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_log_enabled: !isOn }),
        });
        if (window.showToast) window.showToast('Event log setting updated', 'success');
      } catch {
        toggleBtn.classList.toggle('on', isOn);
        toggleBtn.setAttribute('aria-checked', String(isOn));
        if (window.showToast) window.showToast('Failed to update event log setting', 'error');
      }
    });
  }
  // Remote instances panel (replaces htmx partial)
  initRemoteInstancesPanel();
}

// Self-initialize — this file is loaded directly as a page module
initGlobalSettingsTab();
