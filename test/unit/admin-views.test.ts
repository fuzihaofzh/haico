import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from '../../src/views/html';
import { renderAdminNav, renderAdminPageHeader } from '../../src/views/admin/nav';
import { renderSystemPage, renderSystemStatus, renderMaintenanceResult } from '../../src/views/admin/system';
import type { SystemStatus } from '../../src/services/admin/system-status';
import type { MaintenanceResult } from '../../src/services/admin/maintenance';

const sampleStatus: SystemStatus = {
  total_users: 5,
  total_projects: 3,
  running_agents: 2,
  db_size: '1.2 GB',
  uptime: '2h 15m',
  log_retention_days: 30,
  event_log_enabled: true,
};

describe('renderAdminNav', () => {
  it('marks the current path active with aria-current', () => {
    const html = renderToString(renderAdminNav('/admin/system'));
    assert.match(html, /href="\/admin\/system" class="active" aria-current="page"/);
    assert.doesNotMatch(html, /href="\/admin\/users" class="active"/);
    assert.doesNotMatch(html, /href="\/admin\/global-settings" class="active"/);
  });

  it('marks users active when on /admin/users', () => {
    const html = renderToString(renderAdminNav('/admin/users'));
    assert.match(html, /href="\/admin\/users" class="active" aria-current="page"/);
    assert.doesNotMatch(html, /href="\/admin\/system" class="active"/);
  });

  it('renders all three nav items exactly once', () => {
    const html = renderToString(renderAdminNav('/admin/system'));
    assert.equal((html.match(/<a /g) || []).length, 3);
  });
});

describe('renderAdminPageHeader', () => {
  it('renders the shared admin header', () => {
    const html = renderToString(renderAdminPageHeader());
    assert.match(html, /settings-page-eyebrow/);
    assert.match(html, /<h2>Admin<\/h2>/);
  });
});

describe('renderSystemStatus', () => {
  it('renders a dt/dd pair for every status field', () => {
    const html = renderToString(renderSystemStatus(sampleStatus));
    assert.match(html, /<dt>Users<\/dt><dd>5<\/dd>/);
    assert.match(html, /<dt>DB Size<\/dt><dd>1.2 GB<\/dd>/);
    assert.match(html, /<dt>Uptime<\/dt><dd>2h 15m<\/dd>/);
    assert.equal((html.match(/<dt>/g) || []).length, 5);
  });

  it('escapes HTML-special characters in values', () => {
    const malicious: SystemStatus = { ...sampleStatus, db_size: '<script>' };
    const html = renderToString(renderSystemStatus(malicious));
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('renderMaintenanceResult', () => {
  it('renders the message inside a success span', () => {
    const result: MaintenanceResult = { message: 'Reset 3 stuck agent(s) to idle.' };
    const html = renderToString(renderMaintenanceResult(result));
    assert.match(html, /<span class="admin-result-success">Reset 3 stuck agent\(s\) to idle\.<\/span>/);
  });

  it('escapes special characters in the message', () => {
    const result: MaintenanceResult = { message: '<img src=x>' };
    const html = renderToString(renderMaintenanceResult(result));
    assert.ok(!html.includes('<img'));
    assert.match(html, /&lt;img/);
  });
});

describe('renderSystemPage', () => {
  it('wires sections to htmx fragment endpoints', () => {
    const html = renderToString(renderSystemPage('/admin/system'));
    assert.match(html, /hx-get="\/ui\/admin\/system\/status"/);
    assert.match(html, /hx-trigger="load"/);
    assert.match(html, /hx-post="\/ui\/admin\/system\/reset-stuck-agents"/);
    assert.match(html, /hx-post="\/ui\/admin\/system\/run-maintenance"/);
    assert.match(html, /hx-confirm="Reset all agents stuck in running status\?"/);
  });

  it('marks the system nav item active', () => {
    const html = renderToString(renderSystemPage('/admin/system'));
    assert.match(html, /href="\/admin\/system" class="active" aria-current="page"/);
  });
});
