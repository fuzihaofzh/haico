import { initDashboardPage, invalidateDashboardProjects } from './dashboard-core.js';

function bindSettingsEvents() {
  document.body.addEventListener('htmx:afterSwap', (event) => {
    if (event.detail?.target?.id === 'remote-instances-settings') {
      invalidateDashboardProjects({ invalidateRemoteOptions: true });
    }
  });
}

async function initSettingsPage() {
  bindSettingsEvents();
  await initDashboardPage('settings');
  if (window.HAICOCommandProfiles && typeof window.HAICOCommandProfiles.ensureLoaded === 'function') {
    await window.HAICOCommandProfiles.ensureLoaded();
  }
}

initSettingsPage().catch((error) => {
  console.error('Failed to initialize settings dashboard', error);
});
