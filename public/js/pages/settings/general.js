import { initDashboardPage, invalidateDashboardProjects } from '../dashboard-core.js';
import { syncNotificationSoundToggles, toggleNotificationSound } from '../../components/notification-sound.js';
import { showToast } from '../../components/toast.js';

let accountSummaryRendered = false;

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

  root.innerHTML = h`
    <div class="settings-account-identity">
      <div class="settings-account-avatar" aria-hidden="true">${displayName.charAt(0).toUpperCase() || '?'}</div>
      <div class="settings-account-heading">
        <div class="settings-account-name">${displayName}</div>
        <div class="settings-account-meta">${displayAccountValue(user?.role)}</div>
      </div>
    </div>
    <dl class="settings-account-details">
      ${html(fields.map(([label, value]) => h`
        <div class="settings-account-detail">
          <dt>${label}</dt>
          <dd>${value}</dd>
        </div>
      `).join(''))}
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
    if (root) root.innerHTML = h`<div class="empty-state">Account details are unavailable.</div>`;
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

function getBrowserNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission || 'default';
}

function updateBrowserNotificationPermissionControls() {
  const statusEl = document.getElementById('browser-notification-status');
  const detailEl = document.getElementById('browser-notification-detail');
  const btn = document.getElementById('browser-notification-request-btn');
  if (!statusEl || !detailEl || !btn) return;

  const state = getBrowserNotificationPermission();
  const configs = {
    unsupported: {
      label: 'Unsupported',
      detail: 'This browser does not support system notifications.',
      button: 'Unavailable',
      disabled: true,
    },
    default: {
      label: 'Not requested',
      detail: 'Allow HAICO to show system notifications for new actionable work.',
      button: 'Enable Browser Notifications',
      disabled: false,
    },
    granted: {
      label: 'Allowed',
      detail: 'Browser notifications are enabled for this site.',
      button: 'Enabled',
      disabled: true,
    },
    denied: {
      label: 'Blocked',
      detail: 'Notifications are blocked. Enable them in your browser site settings.',
      button: 'Blocked',
      disabled: true,
    },
  };
  const config = configs[state] || configs.default;
  statusEl.textContent = config.label;
  statusEl.dataset.state = state;
  detailEl.textContent = config.detail;
  btn.textContent = config.button;
  btn.disabled = config.disabled;
  btn.dataset.state = state;
}

function requestBrowserNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') {
    updateBrowserNotificationPermissionControls();
    return;
  }
  Notification.requestPermission().then(function() {
    updateBrowserNotificationPermissionControls();
  });
}

function bindNotificationSettings() {
  const browserBtn = document.getElementById('browser-notification-request-btn');
  if (browserBtn) browserBtn.addEventListener('click', requestBrowserNotificationPermission);

  const soundToggle = document.querySelector('.settings-sound-toggle');
  if (soundToggle) soundToggle.addEventListener('click', toggleNotificationSound);

  updateBrowserNotificationPermissionControls();
  syncNotificationSoundToggles();
}

async function loadDefaultLandingPage() {
  const select = document.getElementById('default-landing-page');
  if (!select) return;
  try {
    const res = await fetch('/api/settings/default-landing-page', { headers: apiHeaders() });
    if (res.ok) {
      const data = await res.json();
      select.value = data.value || 'overview';
    }
  } catch {}
  select.addEventListener('change', async () => {
    try {
      const res = await fetch('/api/settings/default-landing-page', {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify({ value: select.value }),
      });
      if (res.ok) {
        showToast('Default landing page updated', 'success');
      }
    } catch {}
  });
}

async function initSettingsGeneralPage() {
  bindSettingsEvents();
  bindNotificationSettings();
  await initDashboardPage('settings');
  await Promise.all([loadAccountSummary(), loadDefaultLandingPage()]);
}

initSettingsGeneralPage().catch((error) => {
  console.error('Failed to initialize settings dashboard', error);
});
