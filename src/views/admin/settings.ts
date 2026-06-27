import { h, type HtmlFragment } from '../html';
import { renderAdminNav, renderAdminPageHeader } from './nav';
import type { AdminSettings } from '../../services/admin/settings';

/**
 * Full <main> inner content for the global-settings admin page. Settings
 * values are SSR-injected; the remote-instances panel is loaded via htmx
 * on page load into #remote-instances-settings.
 */
export function renderGlobalSettingsPage(path: string, settings: AdminSettings): HtmlFragment {
  return h`<div id="admin-view-panel" class="dashboard-view dashboard-view-admin">
  ${renderAdminPageHeader()}
  ${renderAdminNav(path)}
  <div class="settings-page-grid">
    ${renderLogRetentionSection(settings)}
    ${renderEventLogToggle(settings)}
  </div>
  <div class="admin-fullwidth-section">
    <div class="admin-page-bar">
      <h3>Remote HAICO Instances</h3>
    </div>
    <div class="admin-scrollable">
      <div id="remote-instances-settings" hx-get="/ui/admin/remote-instances" hx-trigger="load" hx-swap="innerHTML">
        <div class="empty-state">Loading remote instances...</div>
      </div>
    </div>
  </div>
</div>`;
}

function renderLogRetentionSection(settings: AdminSettings): HtmlFragment {
  return h`<section class="card settings-card settings-card-wide">
  <div class="settings-card-header">
    <div>
      <h3>Log Retention</h3>
      <p>Number of days to keep conversation logs. Older logs are automatically deleted.</p>
    </div>
  </div>
  <div class="settings-section settings-section-page admin-card-body">
    <div class="setting-group">
      <label for="log-retention-days">Retention Days</label>
      <input type="number" id="log-retention-days" name="log_retention_days" min="1" max="365" value="${settings.log_retention_days}" class="admin-number-input" hx-put="/ui/admin/settings/log-retention" hx-trigger="change" hx-swap="none">
    </div>
  </div>
</section>`;
}

/**
 * Event-log toggle. The button POSTs the *opposite* of the current state
 * (hx-vals carries the target value), and the endpoint returns a fresh button
 * reflecting the new state — so the client holds no on/off state at all.
 */
function renderEventLogToggle(settings: AdminSettings): HtmlFragment {
  const nextState = !settings.event_log_enabled;
  const onClass = settings.event_log_enabled ? ' on' : '';
  const checked = settings.event_log_enabled ? 'true' : 'false';
  return h`<section class="card settings-card settings-card-wide">
  <div class="settings-card-header">
    <div>
      <h3>Event Log</h3>
      <p>Enable or disable the event log for debugging and auditing.</p>
    </div>
  </div>
  <div class="settings-section settings-section-page admin-card-body">
    <div class="settings-toggle-row">
      <div class="settings-toggle-copy">
        <div class="settings-toggle-title">Event Log Enabled</div>
      </div>
      <button class="settings-sound-toggle${onClass}" id="event-log-toggle" role="switch" aria-checked="${checked}" aria-label="Toggle event log" hx-post="/ui/admin/settings/event-log" hx-vals='{"event_log_enabled": ${nextState}}' hx-target="this" hx-swap="outerHTML">
        <span class="settings-sound-toggle-track">
          <span class="settings-sound-toggle-knob"></span>
        </span>
      </button>
    </div>
  </div>
</section>`;
}

/** Re-rendered toggle button returned by the event-log endpoint. */
export function renderEventLogToggleButton(enabled: boolean): HtmlFragment {
  const nextState = !enabled;
  const onClass = enabled ? ' on' : '';
  const checked = enabled ? 'true' : 'false';
  return h`<button class="settings-sound-toggle${onClass}" id="event-log-toggle" role="switch" aria-checked="${checked}" aria-label="Toggle event log" hx-post="/ui/admin/settings/event-log" hx-vals='{"event_log_enabled": ${nextState}}' hx-target="this" hx-swap="outerHTML">
  <span class="settings-sound-toggle-track">
    <span class="settings-sound-toggle-knob"></span>
  </span>
</button>`;
}
