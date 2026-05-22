import { initDashboardPage, invalidateDashboardProjects } from './dashboard-core.js';

let accountSummaryRendered = false;

function settingsEsc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function formatAccountDate(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function displayAccountValue(value) {
  const text = String(value || '').trim();
  return text || 'Not set';
}

function renderAccountSummary(user) {
  const root = document.getElementById('settings-account-summary');
  if (!root) return;
  accountSummaryRendered = true;

  const displayName = displayAccountValue(user?.display_name || user?.username);
  const fields = [
    ['Display name', displayName],
    ['Username', displayAccountValue(user?.username)],
    ['Role', displayAccountValue(user?.role)],
    ['Email', displayAccountValue(user?.email)],
    ['Joined', formatAccountDate(user?.created_at)],
  ];

  root.innerHTML = `
    <div class="settings-account-identity">
      <div class="settings-account-avatar" aria-hidden="true">${settingsEsc(displayName.charAt(0).toUpperCase() || '?')}</div>
      <div class="settings-account-heading">
        <div class="settings-account-name">${settingsEsc(displayName)}</div>
        <div class="settings-account-meta">${settingsEsc(displayAccountValue(user?.role))}</div>
      </div>
    </div>
    <dl class="settings-account-details">
      ${fields.map(([label, value]) => `
        <div class="settings-account-detail">
          <dt>${settingsEsc(label)}</dt>
          <dd>${settingsEsc(value)}</dd>
        </div>
      `).join('')}
    </dl>
  `;
}

async function loadAccountSummary() {
  if (accountSummaryRendered) return;
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Account request failed: ${response.status}`);
    renderAccountSummary(await response.json());
  } catch (error) {
    console.warn('Failed to load account summary', error);
    const root = document.getElementById('settings-account-summary');
    if (root) root.innerHTML = '<div class="empty-state">Account details are unavailable.</div>';
  }
}

function bindSettingsEvents() {
  document.body.addEventListener('htmx:afterSwap', (event) => {
    if (event.detail?.target?.id === 'remote-instances-settings') {
      invalidateDashboardProjects({ invalidateRemoteOptions: true });
    }
  });
  window.addEventListener('haico:user-ready', (event) => {
    renderAccountSummary(event.detail);
  });
}

async function initSettingsPage() {
  bindSettingsEvents();
  await initDashboardPage('settings');
  await loadAccountSummary();
  if (window.HAICOCommandProfiles && typeof window.HAICOCommandProfiles.ensureLoaded === 'function') {
    await window.HAICOCommandProfiles.ensureLoaded();
  }
}

initSettingsPage().catch((error) => {
  console.error('Failed to initialize settings dashboard', error);
});
