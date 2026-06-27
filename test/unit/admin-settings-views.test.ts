import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from '../../src/views/html';
import {
  renderGlobalSettingsPage,
  renderEventLogToggleButton,
} from '../../src/views/admin/settings';
import type { AdminSettings } from '../../src/services/admin/settings';

const settingsOn: AdminSettings = { log_retention_days: 30, event_log_enabled: true };
const settingsOff: AdminSettings = { log_retention_days: 7, event_log_enabled: false };

describe('renderGlobalSettingsPage', () => {
  it('renders the log retention input with the current value', () => {
    const html = renderToString(renderGlobalSettingsPage('/admin/global-settings', settingsOn));
    assert.match(html, /id="log-retention-days"/);
    assert.match(html, /value="30"/);
    assert.match(html, /hx-put="\/ui\/admin\/settings\/log-retention"/);
    assert.match(html, /hx-trigger="change"/);
  });

  it('renders the event-log toggle in the on state', () => {
    const html = renderToString(renderGlobalSettingsPage('/admin/global-settings', settingsOn));
    assert.match(html, /class="settings-sound-toggle on"/);
    assert.match(html, /aria-checked="true"/);
  });

  it('renders the event-log toggle in the off state', () => {
    const html = renderToString(renderGlobalSettingsPage('/admin/global-settings', settingsOff));
    assert.match(html, /class="settings-sound-toggle"/);
    assert.doesNotMatch(html, /class="settings-sound-toggle on"/);
    assert.match(html, /aria-checked="false"/);
  });

  it('toggle posts the opposite of the current state via hx-vals', () => {
    const onHtml = renderToString(renderGlobalSettingsPage('/admin/global-settings', settingsOn));
    // Currently on → posts event_log_enabled: false
    assert.match(onHtml, /hx-vals='\{"event_log_enabled": false\}'/);

    const offHtml = renderToString(renderGlobalSettingsPage('/admin/global-settings', settingsOff));
    // Currently off → posts event_log_enabled: true
    assert.match(offHtml, /hx-vals='\{"event_log_enabled": true\}'/);
  });

  it('wires remote-instances panel to load via htmx', () => {
    const html = renderToString(renderGlobalSettingsPage('/admin/global-settings', settingsOn));
    assert.match(html, /id="remote-instances-settings"/);
    assert.match(html, /hx-get="\/ui\/admin\/remote-instances"/);
    assert.match(html, /hx-trigger="load"/);
  });

  it('marks global-settings nav active', () => {
    const html = renderToString(renderGlobalSettingsPage('/admin/global-settings', settingsOn));
    assert.match(html, /href="\/admin\/global-settings" class="active" aria-current="page"/);
  });
});

describe('renderEventLogToggleButton', () => {
  it('renders on state with correct hx-vals for toggling off', () => {
    const html = renderToString(renderEventLogToggleButton(true));
    assert.match(html, /class="settings-sound-toggle on"/);
    assert.match(html, /aria-checked="true"/);
    assert.match(html, /hx-vals='\{"event_log_enabled": false\}'/);
  });

  it('renders off state with correct hx-vals for toggling on', () => {
    const html = renderToString(renderEventLogToggleButton(false));
    assert.match(html, /class="settings-sound-toggle"/);
    assert.match(html, /aria-checked="false"/);
    assert.match(html, /hx-vals='\{"event_log_enabled": true\}'/);
  });

  it('is an outerHTML swap target', () => {
    const html = renderToString(renderEventLogToggleButton(true));
    assert.match(html, /hx-target="this"/);
    assert.match(html, /hx-swap="outerHTML"/);
  });
});
