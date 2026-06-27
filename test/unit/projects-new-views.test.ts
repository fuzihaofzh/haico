import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from '../../src/views/html';
import {
  renderNewProjectPage,
  renderAgentToolSelect,
  renderTargetSelect,
  renderWorkdirControls,
  renderReadinessSection,
  renderPathPickerPanel,
  renderCheckItem,
} from '../../src/views/projects/new';
import type { CommandProfile } from '../../src/types';
import type { RemoteInstanceOption } from '../../src/services/remote-instances';
import type { DirectoryRoot, DirectoryEntry } from '../../src/services/projects/directory-browse';

const sampleProfiles: CommandProfile[] = [
  { id: 'p-1', name: 'Claude Code', command: 'claude', type: 'claude', scenario: null, config_json: '{}', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 'p-2', name: 'Codex CLI', command: 'codex', type: 'codex', scenario: null, config_json: '{}', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
];

const sampleInstances: RemoteInstanceOption[] = [
  { id: 'r-1', name: 'Remote Box', base_url: 'https://box.example.com', enabled: true, last_status: 'ok', last_error: '', available: true },
  { id: 'r-2', name: 'Dev Server', base_url: 'https://dev.example.com', enabled: true, last_status: 'error', last_error: 'connection refused', available: false },
];

const sampleRoots: DirectoryRoot[] = [
  { id: 'home', label: 'Home', path: '/home/user' },
  { id: 'workspace', label: 'Workspace', path: '/workspace' },
];

const sampleEntries: DirectoryEntry[] = [
  { name: 'project-a', relative_path: 'project-a', absolute_path: '/home/user/project-a' },
  { name: 'project-b', relative_path: 'project-b', absolute_path: '/home/user/project-b' },
];

const sampleUser = { display_name: 'Alice', username: 'alice', role: 'member' };

describe('projects/new views', () => {
  describe('renderCheckItem', () => {
    it('renders ok tone with title and detail', () => {
      const html = renderToString(renderCheckItem({ tone: 'ok', title: 'CLI available', detail: 'claude is ready' }));
      assert.match(html, /class="create-project-check create-project-check-ok"/);
      assert.match(html, /CLI available/);
      assert.match(html, /claude is ready/);
      assert.doesNotMatch(html, /&lt;span/);
    });

    it('renders error tone', () => {
      const html = renderToString(renderCheckItem({ tone: 'error', title: 'CLI not found', detail: 'Missing binary' }));
      assert.match(html, /class="create-project-check create-project-check-error"/);
      assert.match(html, /CLI not found/);
    });

    it('renders action button when provided', () => {
      const html = renderToString(renderCheckItem({
        tone: 'warn',
        title: 'Setup needed',
        detail: 'Configure a tool',
        action: '<a class="btn btn-sm" href="/settings">Settings</a>',
      }));
      assert.match(html, /create-project-check-actions/);
      assert.match(html, /Settings/);
    });
  });

  describe('renderAgentToolSelect', () => {
    it('renders dropdown with profiles', () => {
      const html = renderToString(renderAgentToolSelect(sampleProfiles, 'p-1'));
      assert.match(html, /<select id="proj-cmd-profile"/);
      assert.match(html, /Claude Code/);
      assert.match(html, /Codex CLI/);
      assert.match(html, /hx-post="\/ui\/projects\/new\/change-tool"/);
    });

    it('renders disabled state when no profiles', () => {
      const html = renderToString(renderAgentToolSelect([], ''));
      assert.match(html, /disabled/);
      assert.match(html, /No Agent Tools configured/);
    });

    it('preserves htmx attributes', () => {
      const html = renderToString(renderAgentToolSelect(sampleProfiles, 'p-1'));
      assert.match(html, /hx-post="\/ui\/projects\/new\/change-tool"/);
      assert.match(html, /hx-target="#create-project-readiness-body"/);
      assert.match(html, /hx-trigger="change"/);
    });
  });

  describe('renderTargetSelect', () => {
    it('renders localhost and remote instances', () => {
      const html = renderToString(renderTargetSelect(sampleInstances, 'localhost'));
      assert.match(html, /value="localhost"/);
      assert.match(html, /Remote Box/);
      assert.match(html, /Dev Server/);
      assert.match(html, /hx-post="\/ui\/projects\/new\/change-target"/);
    });

    it('shows connection issue suffix for error instances', () => {
      const errorInstances: RemoteInstanceOption[] = [
        { id: 'r-3', name: 'Broken Box', base_url: 'https://broken.example.com', enabled: true, last_status: 'error', last_error: 'timeout', available: true },
      ];
      const html = renderToString(renderTargetSelect(errorInstances, 'r-3'));
      assert.match(html, /connection issue/);
    });

    it('shows setup required suffix for unavailable instances', () => {
      const unavailableInstances: RemoteInstanceOption[] = [
        { id: 'r-4', name: 'Unconfigured Box', base_url: 'https://unconfigured.example.com', enabled: true, last_status: 'unknown', last_error: '', available: false },
      ];
      const html = renderToString(renderTargetSelect(unavailableInstances, 'r-4'));
      assert.match(html, /setup required/);
    });
  });

  describe('renderWorkdirControls', () => {
    it('renders browse button for local target', () => {
      const html = renderToString(renderWorkdirControls(
        { id: 'localhost', label: 'localhost', detail: 'This machine', isLocal: true },
        ''
      ));
      assert.match(html, /Browse/);
      assert.match(html, /hx-get="\/ui\/projects\/new\/path-picker"/);
    });

    it('renders disabled browse button for remote target', () => {
      const html = renderToString(renderWorkdirControls(
        { id: 'r-1', label: 'Remote Box', detail: 'Remote machine', isLocal: false },
        ''
      ));
      assert.match(html, /disabled/);
      assert.doesNotMatch(html, /hx-get="\/ui\/projects\/new\/path-picker"/);
    });
  });

  describe('renderReadinessSection', () => {
    it('shows account check when user exists', () => {
      const html = renderToString(renderReadinessSection(sampleUser, {
        ok: false,
        profile: null,
        summary: null,
      }));
      assert.match(html, /Account/);
      assert.match(html, /Signed in/);
      assert.match(html, /Alice/);
    });

    it('shows warning when no user', () => {
      const html = renderToString(renderReadinessSection(null, {
        ok: false,
        profile: null,
        summary: null,
      }));
      assert.match(html, /Your session is required/);
    });

    it('shows agent tool error when no profile', () => {
      const html = renderToString(renderReadinessSection(sampleUser, {
        ok: false,
        profile: null,
        summary: null,
      }));
      assert.match(html, /No Agent Tool is configured/);
      assert.match(html, /Open Settings/);
    });

    it('shows binary found status', () => {
      const html = renderToString(renderReadinessSection(sampleUser, {
        ok: true,
        profile: { id: 'p-1', name: 'Claude Code', type: 'claude', command: 'claude' },
        summary: {
          command: 'claude',
          command_type: 'claude',
          tool_label: 'claude',
          binary: 'claude',
          binary_found: true,
          binary_path: '/usr/local/bin/claude',
          ready: true,
          issues: [],
          auth: { status: 'configured', confidence: 'env', message: 'Logged in', action_command: null },
        },
      }));
      assert.match(html, /claude is available/);
      assert.match(html, /\/usr\/local\/bin\/claude/);
      assert.doesNotMatch(html, /&lt;span/);
    });

    it('shows binary not found error', () => {
      const html = renderToString(renderReadinessSection(sampleUser, {
        ok: true,
        profile: { id: 'p-1', name: 'Claude Code', type: 'claude', command: 'claude' },
        summary: {
          command: 'claude',
          command_type: 'claude',
          tool_label: 'claude',
          binary: 'claude',
          binary_found: false,
          binary_path: null,
          ready: false,
          issues: [{ code: 'missing_cli', severity: 'blocking', title: 'CLI not found', detail: 'claude is not installed', action_label: null, action_command: 'apt install claude' }],
          auth: { status: 'unknown', confidence: 'unknown', message: 'Cannot verify', action_command: null },
        },
      }));
      assert.match(html, /HAICO could not find/);
      assert.match(html, /CLI not found/);
    });

    it('escapes XSS in user input', () => {
      const maliciousUser = { display_name: '<script>alert("xss")</script>', username: 'hacker', role: 'member' };
      const html = renderToString(renderReadinessSection(maliciousUser, {
        ok: false,
        profile: null,
        summary: null,
      }));
      assert.match(html, /&lt;script&gt;alert/);
      assert.doesNotMatch(html, /<script>alert/);
    });
  });

  describe('renderPathPickerPanel', () => {
    it('renders root select and directory entries', () => {
      const html = renderToString(renderPathPickerPanel(sampleRoots, 'home', sampleEntries, '/home/user'));
      assert.match(html, /path-picker-root/);
      assert.match(html, /Home/);
      assert.match(html, /project-a/);
      assert.match(html, /project-b/);
      assert.match(html, /hx-post="\/ui\/projects\/new\/path-picker\/navigate"/);
    });

    it('shows empty state when no entries', () => {
      const html = renderToString(renderPathPickerPanel(sampleRoots, 'home', [], '/home/user/empty'));
      assert.match(html, /No subdirectories here/);
    });
  });

  describe('renderNewProjectPage', () => {
    it('renders full page content', () => {
      const html = renderToString(renderNewProjectPage(sampleProfiles, sampleInstances, sampleRoots, sampleUser));
      assert.match(html, /Create New Project/);
      assert.match(html, /Agent Tool/);
      assert.match(html, /Machine/);
      assert.match(html, /Working Directory/);
      assert.match(html, /Before you create/);
      assert.match(html, /hx-post="\/ui\/projects\/new\/submit"/);
      assert.match(html, /Claude Code/);
      assert.match(html, /localhost/);
    });

    it('escapes XSS in profile names', () => {
      const maliciousProfiles: CommandProfile[] = [
        { id: 'p-xss', name: '<script>evil()</script>', command: 'evil', type: 'claude', scenario: null, config_json: '{}', created_at: '', updated_at: '' },
      ];
      const html = renderToString(renderNewProjectPage(maliciousProfiles, [], sampleRoots, sampleUser));
      assert.match(html, /&lt;script&gt;evil/);
      assert.doesNotMatch(html, /<script>evil/);
    });
  });
});
