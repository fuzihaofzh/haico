import { h, type HtmlFragment } from '../html';
import type { ToolReadinessSummary } from '../../services/tool-readiness';
import type { CommandProfile } from '../../types';
import type { RemoteInstanceOption } from '../../services/remote-instances';
import type { DirectoryRoot, DirectoryEntry } from '../../services/projects/directory-browse';

// ── View data types ──────────────────────────────────────────────

export interface TargetMeta {
  id: string;
  label: string;
  detail: string;
  isLocal: boolean;
}

export interface ReadinessResult {
  ok: boolean;
  profile: { id: string; name: string; type: string; command: string } | null;
  summary: ToolReadinessSummary | null;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function renderCheckItemTitle(title: string): HtmlFragment {
  return h`<div class="create-project-check-title">${title}</div>`;
}

function renderCheckItemDetail(detail: string): HtmlFragment {
  return h`<div class="create-project-check-detail">${detail}</div>`;
}

// ── Readiness check item ─────────────────────────────────────────

export function renderCheckItem(check: {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  detail: HtmlFragment | string;
  action?: HtmlFragment;
}): HtmlFragment {
  return h`
    <div class="create-project-check create-project-check-${check.tone}">
      <div class="create-project-check-icon" aria-hidden="true"></div>
      <div class="create-project-check-copy">
        ${check.title ? h`<div class="create-project-check-title">${check.title}</div>` : ''}
        ${check.detail ? h`<div class="create-project-check-detail">${check.detail}</div>` : ''}
        ${check.action ? h`<div class="create-project-check-actions">${check.action}</div>` : ''}
      </div>
    </div>`;
}

// ── Readiness section (full panel) ───────────────────────────────

export function renderReadinessSection(
  currentUser: { display_name?: string; username: string; role: string } | null,
  readinessResult: ReadinessResult
): HtmlFragment {
  const items: HtmlFragment[] = [];

  // Account check
  if (currentUser) {
    items.push(renderCheckItem({
      tone: 'ok',
      title: 'Account',
      detail: h`Signed in as <strong>${currentUser.display_name || currentUser.username}</strong> (${currentUser.role || 'member'}).`,
    }));
  } else {
    items.push(renderCheckItem({
      tone: 'warn',
      title: 'Account',
      detail: 'Your session is required to create a project.',
    }));
  }

  if (!readinessResult.profile) {
    items.push(renderCheckItem({
      tone: 'error',
      title: 'Agent Tool',
      detail: 'No Agent Tool is configured yet. Open Settings, add one, then come back here.',
      action: h`<a class="btn btn-sm" href="/settings/agent-tools">Open Settings</a>`,
    }));
    return h`<div id="create-project-readiness-body" class="create-project-readiness-body">${items}</div>`;
  }

  if (readinessResult.error) {
    items.push(renderCheckItem({
      tone: 'warn',
      title: 'Setup check unavailable',
      detail: readinessResult.error,
    }));
    return h`<div id="create-project-readiness-body" class="create-project-readiness-body">${items}</div>`;
  }

  const summary = readinessResult.summary;
  if (!summary) {
    items.push(renderCheckItem({
      tone: 'warn',
      title: 'Setup check unavailable',
      detail: 'HAICO could not inspect the CLI right now.',
    }));
    return h`<div id="create-project-readiness-body" class="create-project-readiness-body">${items}</div>`;
  }

  // Tool check (always ok since we have a profile)
  items.push(renderCheckItem({
    tone: 'ok',
    title: 'Agent Tool',
    detail: h`Using <strong>${readinessResult.profile.name}</strong> (${readinessResult.profile.type}): <span class="create-project-inline-code">${readinessResult.profile.command}</span>`,
  }));

  // CLI availability
  items.push(renderCheckItem({
    tone: summary.binary_found ? 'ok' : 'error',
    title: 'CLI availability',
    detail: summary.binary_found
      ? h`${summary.binary} is available at <span class="create-project-inline-code">${summary.binary_path || ''}</span>.`
      : h`HAICO could not find <span class="create-project-inline-code">${summary.binary}</span>. Install it and make sure the shell can run it.`,
  }));

  // Auth
  const authTone = summary.auth?.status === 'configured' ? 'ok' : 'warn';
  const authParts = [summary.auth?.message || 'HAICO cannot verify login state for this tool automatically.'];
  if (summary.auth?.action_command) {
    authParts.push(`Suggested command: ${summary.auth.action_command}`);
  }
  items.push(renderCheckItem({
    tone: authTone,
    title: 'CLI login',
    detail: authParts.join(' '),
  }));

  // Issues  
  for (const issue of (summary.issues || []).filter((i) => i.code !== 'auth_missing')) {
    const issueDetail = issue.detail + (issue.action_command ? ` Suggested command: ${issue.action_command}` : '');
    items.push(renderCheckItem({
      tone: issue.severity === 'blocking' ? 'error' : 'warn',
      title: issue.title,
      detail: issueDetail,
      action: issue.action_label === 'Open Settings'
        ? h`<a class="btn btn-sm" href="/settings/agent-tools">Open Settings</a>`
        : undefined,
    }));
  }

  return h`<div id="create-project-readiness-body" class="create-project-readiness-body">${items}</div>`;
}

// ── Agent Tool select ────────────────────────────────────────────

export function renderAgentToolSelect(
  profiles: CommandProfile[],
  selectedId: string
): HtmlFragment {
  if (!profiles.length) {
    return h`
      <select id="proj-cmd-profile" disabled>
        <option value="">No Agent Tools configured</option>
      </select>
      <input type="hidden" id="proj-cmd" value="">
      <div id="proj-cmd-preview" class="project-new-help">No Agent Tool is configured yet. Open Settings and add one.</div>`;
  }

  const selected = selectedId && profiles.some((p) => p.id === selectedId)
    ? selectedId
    : profiles[0].id;
  const selectedProfile = profiles.find((p) => p.id === selected) || profiles[0];
  const previewText = selectedProfile
    ? `Agent Tool: ${selectedProfile.name} (${selectedProfile.type}) · Command: ${selectedProfile.command}`
    : '';

  return h`
    <select id="proj-cmd-profile"
      hx-post="/ui/projects/new/change-tool"
      hx-target="#create-project-readiness-body"
      hx-swap="innerHTML"
      hx-trigger="change">
      ${profiles.map((p) => h`<option value="${p.id}"${p.id === selected ? h` selected` : ''}>${p.name} (${p.type})</option>`)}
    </select>
    <input type="hidden" id="proj-cmd" value="${selectedProfile?.command || ''}">
    <div id="proj-cmd-preview" class="project-new-help">${previewText}</div>`;
}

// ── Target machine select ────────────────────────────────────────

export function renderTargetSelect(
  instances: RemoteInstanceOption[],
  selectedId: string
): HtmlFragment {
  const desiredId = selectedId && (selectedId === 'localhost' || instances.some((i) => i.id === selectedId))
    ? selectedId
    : 'localhost';
  const isLocal = desiredId === 'localhost';
  const targetInstance = isLocal ? null : instances.find((i) => i.id === desiredId);
  const hintText = isLocal
    ? 'New projects run on localhost by default.'
    : `HAICO will prepare and create this project on ${targetInstance?.name || targetInstance?.base_url || 'the selected machine'}.`;

  return h`
    <select id="proj-target-instance"
      hx-post="/ui/projects/new/change-target"
      hx-target="#create-project-readiness-body"
      hx-swap="innerHTML"
      hx-trigger="change">
      <option value="localhost"${desiredId === 'localhost' ? h` selected` : ''}>localhost</option>
      ${instances.map((i) => {
        const statusSuffix = !i.available
          ? ' - setup required'
          : i.last_status === 'error'
            ? ' - connection issue'
            : '';
        return h`<option value="${i.id}"${i.id === desiredId ? h` selected` : ''}>${i.name} - ${i.base_url}${statusSuffix}</option>`;
      })}
    </select>
    <input type="hidden" id="proj-target-instance-id" value="${desiredId}">
    <div id="proj-target-instance-hint" class="project-new-help">${hintText}</div>`;
}

// ── Workdir controls ─────────────────────────────────────────────

export function renderWorkdirControls(
  target: TargetMeta,
  workdir: string
): HtmlFragment {
  return h`
    <div class="create-project-path-row">
      <input type="text" id="proj-workdir" placeholder="${target.isLocal ? 'Optional absolute path' : 'Optional absolute path on the selected machine'}" value="${workdir}">
      ${target.isLocal ? h`<button type="button" class="btn btn-sm" id="proj-workdir-browse"
        hx-get="/ui/projects/new/path-picker"
        hx-target="#path-picker-panel"
        hx-swap="innerHTML">Browse</button>` : h`<button type="button" class="btn btn-sm" id="proj-workdir-browse" disabled title="Remote folder browsing is not available">Browse</button>`}
      <button type="button" class="btn btn-sm" onclick="document.getElementById('proj-workdir').value=''">Clear</button>
    </div>
    <div id="proj-workdir-hint" class="project-new-help">
      ${target.isLocal
        ? 'Optional. If empty, HAICO will use the path inferred from your prompt or leave it unset.'
        : `Optional. Enter an absolute path on ${target.label} manually. Folder browsing only works for localhost.`}
    </div>
    <section class="path-picker-inline" id="path-picker-panel" hidden>
      <div class="create-project-readiness-empty">Click Browse to select a directory.</div>
    </section>`;
}

// ── Path picker panel ────────────────────────────────────────────

export function renderPathPickerPanel(
  roots: DirectoryRoot[],
  currentRootId: string,
  entries: DirectoryEntry[],
  currentPath: string
): HtmlFragment {
  return h`
    <div class="path-picker-toolbar">
      <div class="form-group path-picker-root-group">
        <label for="path-picker-root">Browse Root</label>
        <select id="path-picker-root"
          hx-post="/ui/projects/new/path-picker/navigate"
          hx-target="#path-picker-panel"
          hx-swap="innerHTML"
          hx-trigger="change">
          ${roots.map((r) => h`<option value="${r.id}"${r.id === currentRootId ? h` selected` : ''}>${r.label} - ${r.path}</option>`)}
        </select>
      </div>
      <div class="path-picker-actions">
        <button type="button" class="btn btn-sm"
          hx-post="/ui/projects/new/path-picker/up"
          hx-target="#path-picker-panel"
          hx-swap="innerHTML"${currentPath ? '' : ' disabled'}>Up</button>
        <button type="button" class="btn btn-sm btn-primary"
          hx-post="/ui/projects/new/path-picker/use"
          hx-target="#path-picker-panel"
          hx-swap="none">Use This Folder</button>
        <button type="button" class="btn btn-sm"
          onclick="document.getElementById('path-picker-panel').hidden=true">Close</button>
      </div>
    </div>
    <div class="path-picker-current">${currentPath || '/'}</div>
    <div class="path-picker-list">
      ${entries.length
        ? entries.map((entry) => h`
          <button type="button" class="path-picker-entry"
            hx-post="/ui/projects/new/path-picker/navigate"
            hx-vals='${JSON.stringify({ path: entry.relative_path })}'
            hx-target="#path-picker-panel"
            hx-swap="innerHTML">
            <div>
              <div class="path-picker-entry-name">${entry.name}</div>
              <div class="path-picker-entry-path">${entry.absolute_path}</div>
            </div>
            <div class="create-project-inline-code">dir</div>
          </button>
        `)
        : [h`<div class="create-project-readiness-empty">No subdirectories here.</div>`]}
    </div>`;
}

// ── Main page content (without shell) ────────────────────────────

export function renderNewProjectPage(
  profiles: CommandProfile[],
  instances: RemoteInstanceOption[],
  directoryRoots: DirectoryRoot[],
  currentUser: { display_name?: string; username: string; role: string } | null
): HtmlFragment {
  const selectedProfileId = profiles.length ? profiles[0].id : '';
  const selectedTargetId = 'localhost';

  return h`
    <section class="project-new-header">
      <div>
        <div class="settings-page-eyebrow">Projects</div>
        <h2>Create New Project</h2>
        <p>Describe the work, choose where HAICO should run it, and verify the selected agent tool before launch.</p>
      </div>
    </section>

    <section class="project-new-layout">
      <form id="new-project-form" class="card project-new-form"
        hx-post="/ui/projects/new/submit"
        hx-target="#main-content"
        hx-swap="innerHTML">

        <div class="form-group">
          <label for="proj-task">What do you want to do?</label>
          <textarea id="proj-task" name="task" rows="6" placeholder="Describe your task... The system will create a name and configure everything automatically."></textarea>
        </div>

        <div class="project-new-grid">
          <div class="form-group">
            <label for="proj-cmd-profile">Agent Tool</label>
            ${renderAgentToolSelect(profiles, selectedProfileId)}
          </div>

          <div class="form-group">
            <label for="proj-target-instance">Machine</label>
            ${renderTargetSelect(instances, selectedTargetId)}
          </div>
        </div>

        <div class="form-group">
          <label for="proj-workdir">Working Directory</label>
          ${renderWorkdirControls(
            { id: 'localhost', label: 'localhost', detail: 'This machine', isLocal: true },
            ''
          )}
        </div>

        <div class="create-project-readiness" id="create-project-readiness">
          <div class="create-project-readiness-head">
            <div>
              <strong>Before you create</strong>
              <div class="create-project-readiness-subtitle">HAICO checks whether the selected CLI is ready on this machine.</div>
            </div>
            <a class="btn btn-sm" href="/settings/agent-tools">Open Settings</a>
          </div>
          ${renderReadinessSection(currentUser, {
            ok: false,
            profile: profiles.length ? { id: profiles[0].id, name: profiles[0].name, type: profiles[0].type, command: profiles[0].command } : null,
            summary: null,
          })}
        </div>

        <div class="modal-actions project-new-actions">
          <a class="btn" href="/projects">Cancel</a>
          <button class="btn btn-primary" type="submit" id="new-project-submit">Create</button>
        </div>
      </form>
    </section>`;
}
