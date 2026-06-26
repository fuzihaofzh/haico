import { h, html } from '../html';
import { renderAdminNav, renderAdminPageHeader } from './nav';
import type { SystemStatus } from '../../services/admin/system-status';
import type { MaintenanceResult } from '../../services/admin/maintenance';

/**
 * Full <main> inner content for the system admin page. Sections are wired to
 * htmx fragment endpoints under /ui/admin/system/* — no page-specific JS.
 */
export function renderSystemPage(path: string): string {
  return h`<div id="admin-view-panel" class="dashboard-view dashboard-view-admin">
  ${html(renderAdminPageHeader())}
  ${html(renderAdminNav(path))}
  <div class="settings-page-grid">
    <section class="card settings-card settings-card-wide">
      <div class="settings-card-header">
        <div>
          <h3>System Status</h3>
          <p>Overview of system health and resource usage.</p>
        </div>
      </div>
      <div class="settings-section settings-section-page admin-card-body">
        <div id="system-status-overview" hx-get="/ui/admin/system/status" hx-trigger="load" hx-swap="innerHTML">
          <div class="empty-state">Loading system status...</div>
        </div>
      </div>
    </section>

    <section class="card settings-card settings-card-wide">
      <div class="settings-card-header">
        <div>
          <h3>Stuck Agents</h3>
          <p>Reset agents stuck in running status from a previous crash.</p>
        </div>
      </div>
      <div class="settings-section settings-section-page admin-card-body">
        <button class="btn btn-sm" hx-post="/ui/admin/system/reset-stuck-agents" hx-confirm="Reset all agents stuck in running status?" hx-target="#reset-stuck-agents-result" hx-swap="innerHTML">Reset Stuck Agents</button>
        <div id="reset-stuck-agents-result" class="admin-action-result"></div>
      </div>
    </section>

    <section class="card settings-card settings-card-wide">
      <div class="settings-card-header">
        <div>
          <h3>Database Maintenance</h3>
          <p>Run startup maintenance tasks manually: fix zero session tokens, upgrade old token limits, etc.</p>
        </div>
      </div>
      <div class="settings-section settings-section-page admin-card-body">
        <button class="btn btn-sm" hx-post="/ui/admin/system/run-maintenance" hx-confirm="Run database maintenance tasks?" hx-target="#run-maintenance-result" hx-swap="innerHTML">Run Maintenance</button>
        <div id="run-maintenance-result" class="admin-action-result"></div>
      </div>
    </section>
  </div>
</div>`;
}

/** System status fragment swapped into #system-status-overview on load. */
export function renderSystemStatus(status: SystemStatus): string {
  const items = [
    { label: 'Users', value: status.total_users },
    { label: 'Projects', value: status.total_projects },
    { label: 'Running Agents', value: status.running_agents },
    { label: 'DB Size', value: status.db_size },
    { label: 'Uptime', value: status.uptime },
  ];
  return h`<div class="info-panel">${html(
    items.map((i) => h`<dt>${i.label}</dt><dd>${i.value}</dd>`).join(''),
  )}</div>`;
}

/** Maintenance/reset result fragment swapped into the action result div. */
export function renderMaintenanceResult(result: MaintenanceResult): string {
  return h`<span class="admin-result-success">${result.message}</span>`;
}
