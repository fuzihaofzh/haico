import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderRemotePanel,
  deriveRemoteInstanceName,
  type RemoteInstanceView,
} from '../../src/views/admin/remote';

const sampleInstance: RemoteInstanceView = {
  id: 'inst-1',
  name: 'remote-host',
  base_url: 'https://remote.example.com',
  enabled: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_checked_at: '2026-06-01T00:00:00Z',
  last_status: 'ok',
  last_error: '',
  has_api_token: true,
  api_token_preview: 'abcd...wxyz',
};

describe('deriveRemoteInstanceName', () => {
  it('extracts host from a full URL', () => {
    assert.equal(deriveRemoteInstanceName('https://remote.example.com'), 'remote.example.com');
  });

  it('prepends http:// if missing', () => {
    assert.equal(deriveRemoteInstanceName('remote.example.com'), 'remote.example.com');
  });

  it('falls back when URL is invalid', () => {
    assert.equal(deriveRemoteInstanceName('   ', 'fallback'), 'fallback');
  });

  it('returns raw input when no fallback and invalid URL', () => {
    assert.equal(deriveRemoteInstanceName('not a url'), 'not a url');
  });
});

describe('renderRemotePanel', () => {
  it('renders an empty state when no instances', () => {
    const html = renderRemotePanel([]);
    assert.match(html, /No remote HAICO instances yet\./);
  });

  it('renders instance rows with edit/check/delete buttons', () => {
    const html = renderRemotePanel([sampleInstance]);
    assert.match(html, /remote-host/);
    assert.match(html, /hx-get="\/ui\/admin\/remote-instances\?editing=inst-1"/);
    assert.match(html, /hx-post="\/ui\/admin\/remote-instances\/inst-1\/check"/);
    assert.match(html, /hx-delete="\/ui\/admin\/remote-instances\/inst-1"/);
    assert.match(html, /hx-confirm="Delete this remote HAICO instance/);
  });

  it('renders the add-new form row by default', () => {
    const html = renderRemotePanel([]);
    assert.match(html, /hx-post="\/ui\/admin\/remote-instances"/);
    assert.match(html, /name="base_url"/);
  });

  it('renders the edit form row when editingId matches', () => {
    const html = renderRemotePanel([sampleInstance], { editingId: 'inst-1' });
    assert.match(html, /hx-put="\/ui\/admin\/remote-instances\/inst-1"/);
    assert.match(html, /value="https:\/\/remote.example.com"/);
    assert.match(html, /Cancel/);
  });

  it('does not render the edit row when editingId does not match', () => {
    const html = renderRemotePanel([sampleInstance], { editingId: 'other-id' });
    // Should still show the add-new form, not the edit form
    assert.match(html, /hx-post="\/ui\/admin\/remote-instances"/);
    assert.doesNotMatch(html, /hx-put="\/ui\/admin\/remote-instances\/inst-1"/);
  });

  it('renders an error message when provided', () => {
    const html = renderRemotePanel([], { error: 'base_url is required' });
    assert.match(html, /command-profiles-status-error/);
    assert.match(html, /base_url is required/);
  });

  it('renders a notice when provided', () => {
    const html = renderRemotePanel([], { notice: 'Remote instance added' });
    assert.match(html, /command-profiles-status"/);
    assert.match(html, /Remote instance added/);
  });

  it('escapes HTML in instance name', () => {
    const malicious: RemoteInstanceView = {
      ...sampleInstance,
      name: '<script>alert(1)</script>',
    };
    const html = renderRemotePanel([malicious]);
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});
