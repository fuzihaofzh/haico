(function() {
  const CUSTOM_PROFILE_VALUE = '__custom__';
  const PROFILE_TYPE_OPTIONS = [
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini' },
  ];
  let commandProfiles = [];
  let profilesLoaded = false;
  let profilesLoading = false;
  let loadError = '';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
      return;
    }
    fn();
  }

  function renderDrawerManagers() {
    const roots = document.querySelectorAll('[data-command-profiles-root]');
    if (!roots.length) return;

    roots.forEach((root) => {
      root.innerHTML = buildDrawerManagerHtml();
    });
  }

  function buildDrawerManagerHtml() {
    const rowsHtml = commandProfiles.length
      ? commandProfiles.map((profile) => renderProfileRow(profile)).join('')
      : '<tr><td colspan="4" class="command-profiles-empty">No command profiles yet.</td></tr>';

    const loadingHtml = profilesLoading
      ? '<div class="command-profiles-status">Loading command profiles...</div>'
      : '';
    const errorHtml = loadError
      ? `<div class="command-profiles-status command-profiles-status-error">${esc(loadError)}</div>`
      : '';

    return `
      <div class="setting-group command-profiles-group">
        <label>Command Profiles</label>
        <div class="command-profiles-note">Reusable CLI presets for agent creation and editing.</div>
        ${loadingHtml}
        ${errorHtml}
        <div class="command-profiles-table-wrap">
          <table class="command-profiles-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Command</th>
                <th>Type</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
              ${renderNewProfileRow()}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderProfileRow(profile) {
    const typeOptions = PROFILE_TYPE_OPTIONS.map((option) =>
      `<option value="${option.value}"${profile.type === option.value ? ' selected' : ''}>${option.label}</option>`
    ).join('');

    return `
      <tr data-command-profile-row="${profile.id}">
        <td>
          <input
            type="text"
            class="command-profile-input"
            data-field="name"
            value="${esc(profile.name)}"
            placeholder="Name"
          >
        </td>
        <td>
          <input
            type="text"
            class="command-profile-input command-profile-command"
            data-field="command"
            value="${esc(profile.command)}"
            placeholder="Command"
          >
        </td>
        <td>
          <select class="command-profile-select" data-field="type">${typeOptions}</select>
        </td>
        <td>
          <div class="command-profile-actions">
            <button type="button" class="btn btn-sm" data-command-profile-action="save">Save</button>
            <button type="button" class="btn btn-sm" data-command-profile-action="delete">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderNewProfileRow() {
    const typeOptions = PROFILE_TYPE_OPTIONS.map((option) =>
      `<option value="${option.value}"${option.value === 'claude' ? ' selected' : ''}>${option.label}</option>`
    ).join('');

    return `
      <tr data-command-profile-row="__new__">
        <td>
          <input type="text" class="command-profile-input" data-field="name" value="" placeholder="New profile">
        </td>
        <td>
          <input type="text" class="command-profile-input command-profile-command" data-field="command" value="" placeholder="cld --model claude-sonnet-4-6">
        </td>
        <td>
          <select class="command-profile-select" data-field="type">${typeOptions}</select>
        </td>
        <td>
          <div class="command-profile-actions">
            <button type="button" class="btn btn-sm btn-primary" data-command-profile-action="create">Add</button>
          </div>
        </td>
      </tr>
    `;
  }

  function dispatchProfilesChanged() {
    window.dispatchEvent(new CustomEvent('agentopia:command-profiles-changed', {
      detail: commandProfiles.slice(),
    }));
  }

  async function ensureLoaded(force) {
    if (profilesLoading) {
      return commandProfiles;
    }

    if (profilesLoaded && !force) {
      return commandProfiles;
    }

    profilesLoading = true;
    loadError = '';
    renderDrawerManagers();

    try {
      const res = await fetch('/api/command-profiles', { headers: apiHeaders() });
      const data = res.ok ? await res.json() : null;
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load command profiles');
      }
      commandProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
      profilesLoaded = true;
      dispatchProfilesChanged();
    } catch (error) {
      console.error('Failed to load command profiles', error);
      loadError = error?.message || 'Failed to load command profiles';
    } finally {
      profilesLoading = false;
      renderDrawerManagers();
    }

    return commandProfiles;
  }

  function getProfileById(profileId) {
    return commandProfiles.find((profile) => profile.id === profileId) || null;
  }

  function normalizeValue(value) {
    return String(value || '').trim();
  }

  function findMatchingProfile(command, type) {
    const normalizedCommand = normalizeValue(command);
    const normalizedType = normalizeValue(type).toLowerCase();
    if (!normalizedCommand) return null;

    let profile = commandProfiles.find((item) =>
      normalizeValue(item.command) === normalizedCommand && item.type === normalizedType
    );
    if (profile) return profile;

    profile = commandProfiles.find((item) => normalizeValue(item.command) === normalizedCommand);
    return profile || null;
  }

  function populateSelect(select, options) {
    if (!select) return;
    const opts = options || {};
    const includeProjectDefault = opts.includeProjectDefault !== false;
    const includeCustom = opts.includeCustom !== false;
    const projectDefaultLabel = opts.projectDefaultLabel || 'Use project default';
    const customLabel = opts.customLabel || 'Custom command';
    const emptyLabel = opts.emptyLabel || 'No command profiles configured. Open Settings to add one.';

    const items = [];
    if (includeProjectDefault) {
      items.push(`<option value="">${esc(projectDefaultLabel)}</option>`);
    }
    if (includeCustom) {
      items.push(`<option value="${CUSTOM_PROFILE_VALUE}">${esc(customLabel)}</option>`);
    }
    commandProfiles.forEach((profile) => {
      items.push(
        `<option value="${profile.id}">${esc(profile.name)} (${esc(profile.type)})</option>`
      );
    });
    if (commandProfiles.length === 0 && !includeProjectDefault && !includeCustom) {
      items.push(`<option value="" disabled>${esc(emptyLabel)}</option>`);
    }
    select.innerHTML = items.join('');
  }

  function getRowPayload(row) {
    return {
      name: row.querySelector('[data-field="name"]')?.value?.trim() || '',
      command: row.querySelector('[data-field="command"]')?.value?.trim() || '',
      type: row.querySelector('[data-field="type"]')?.value || '',
    };
  }

  async function submitProfile(action, row, button) {
    const payload = getRowPayload(row);
    if (!payload.name) {
      showToast('Command profile name is required', 'error');
      return;
    }
    if (!payload.command) {
      showToast('Command profile command is required', 'error');
      return;
    }

    const rowId = row.getAttribute('data-command-profile-row');
    const endpoint = action === 'create' ? '/api/command-profiles' : `/api/command-profiles/${rowId}`;
    const method = action === 'create' ? 'POST' : 'PUT';

    await withLoading(button, async () => {
      const res = await fetch(endpoint, {
        method,
        headers: apiHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Failed to save command profile', 'error');
        return;
      }
      showToast(action === 'create' ? 'Command profile added' : 'Command profile saved', 'success');
      await ensureLoaded(true);
    });
  }

  async function deleteProfile(rowId, button) {
    const profile = getProfileById(rowId);
    const label = profile?.name || 'this command profile';
    const confirmed = await showConfirm(`Delete ${label}? Existing agents keep their stored command.`, {
      title: 'Delete command profile?',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;

    await withLoading(button, async () => {
      const res = await fetch(`/api/command-profiles/${rowId}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Failed to delete command profile', 'error');
        return;
      }
      showToast('Command profile deleted', 'success');
      await ensureLoaded(true);
    });
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command-profile-action]');
    if (!button) return;

    const row = button.closest('[data-command-profile-row]');
    if (!row) return;

    const action = button.getAttribute('data-command-profile-action');
    if (action === 'save' || action === 'create') {
      await submitProfile(action, row, button);
      return;
    }

    if (action === 'delete') {
      await deleteProfile(row.getAttribute('data-command-profile-row'), button);
    }
  });

  window.AgentopiaCommandProfiles = {
    CUSTOM_PROFILE_VALUE,
    ensureLoaded,
    getProfiles: () => commandProfiles.slice(),
    getById: getProfileById,
    findMatch: findMatchingProfile,
    populateSelect,
  };

  ready(() => {
    renderDrawerManagers();
    ensureLoaded();
  });
})();
