/**
 * Shared form logic for Agent Tools create/edit pages.
 * Both agent-tools-new.js and agent-tools-edit.js import this module.
 *
 * Form structure (data attributes on the form container):
 *   [data-agent-tools-form]          — root form container
 *     [data-field="name"]            — input:text
 *     [data-field="scenario"]        — input:text
 *     [data-field="command"]         — input:text
 *     [data-field="type"]            — select
 *     [data-command-profile-config]  — config fields container (rendered dynamically)
 */

const PROFILE_TYPE_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'omp', label: 'OMP' },
];

export function getProfileTypeOptions() {
  return PROFILE_TYPE_OPTIONS;
}

/**
 * Populate the type <select> with options and set the selected value.
 */
export function populateTypeOptions(select, selectedType) {
  if (!select) return;
  select.replaceChildren(...PROFILE_TYPE_OPTIONS.map((option) => {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    item.selected = option.value === selectedType;
    return item;
  }));
}

/**
 * Safely parse config_json from a profile object.
 */
export function getConfigValue(profile) {
  const value = profile?.config_json;
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function hasConfigValues(config) {
  return Boolean(config && typeof config === 'object' && Object.keys(config).length);
}

/**
 * Update config-state data attribute and summary text.
 */
export function syncConfigState(row) {
  const container = row.querySelector('[data-command-profile-config]');
  const summary = row.querySelector('[data-config-summary]');
  if (!container) return;
  const configured = hasConfigValues(readConfigFields(row));
  container.dataset.configState = configured ? 'configured' : 'default';
  if (summary) summary.textContent = configured ? 'Configured' : 'Default';
}

/**
 * Render type-specific config fields into the config container.
 * `row` is the form container element.
 * `type` is the profile type string (claude / codex / gemini).
 * `config` is the config object to populate fields with.
 */
export function renderConfigFields(row, type, config) {
  const container = row.querySelector('[data-command-profile-config]');
  if (!container) return;
  const cfg = config || {};

  if (type === 'codex') {
    container.innerHTML = h`
      <div class="command-profile-config-summary" data-config-summary></div>
      <label class="command-profile-config-field">Sandbox
        <select class="command-profile-select" data-config-field="sandbox">
          <option value="">Default</option>
          <option value="danger-full-access">danger-full-access</option>
          <option value="workspace-write">workspace-write</option>
          <option value="read-only">read-only</option>
        </select>
      </label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="skipGitRepoCheck"> Skip git repo check</label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="bypassApprovals"> Bypass approvals</label>
    `;
    container.querySelector('[data-config-field="sandbox"]').value = cfg.sandbox || '';
    container.querySelector('[data-config-field="skipGitRepoCheck"]').checked = Boolean(cfg.skipGitRepoCheck);
    container.querySelector('[data-config-field="bypassApprovals"]').checked = Boolean(cfg.bypassApprovals);
    syncConfigState(row);
    return;
  }

  if (type === 'gemini') {
    container.innerHTML = h`
      <div class="command-profile-config-summary" data-config-summary></div>
      <label class="command-profile-config-field">Output
        <select class="command-profile-select" data-config-field="outputFormat">
          <option value="">Default</option>
          <option value="stream-json">stream-json</option>
          <option value="text">text</option>
          <option value="json">json</option>
        </select>
      </label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="sandbox"> Sandbox</label>
      <label class="command-profile-config-field">Approval
        <input type="text" class="command-profile-input" data-config-field="approvalMode" placeholder="yolo">
      </label>
    `;
    container.querySelector('[data-config-field="outputFormat"]').value = cfg.outputFormat || '';
    container.querySelector('[data-config-field="sandbox"]').checked = Boolean(cfg.sandbox);
    container.querySelector('[data-config-field="approvalMode"]').value = cfg.approvalMode || '';
    syncConfigState(row);
    return;
  }
  if (type === 'omp') {
    container.innerHTML = h`
      <div class="command-profile-config-summary" data-config-summary></div>
      <label class="command-profile-config-field">Model
        <input type="text" class="command-profile-input" data-config-field="model" placeholder="zai-org/GLM-5.1-FP8">
      </label>
      <label class="command-profile-config-field">Thinking
        <select class="command-profile-select" data-config-field="thinking">
          <option value="">Default</option>
          <option value="off">off</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
        </select>
      </label>
      <label class="command-profile-config-field">Allowed tools
        <textarea class="command-profile-input command-profile-tools" data-config-field="tools" placeholder="Bash,Edit,Read"></textarea>
      </label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="noLsp"> No LSP</label>
      <label class="command-profile-check"><input type="checkbox" data-config-field="autoApprove"> Auto-approve</label>
      <label class="command-profile-config-field">Approval mode
        <select class="command-profile-select" data-config-field="approvalMode">
          <option value="">Default</option>
          <option value="always-ask">always-ask</option>
          <option value="write">write</option>
          <option value="yolo">yolo</option>
        </select>
      </label>
    `;
    container.querySelector('[data-config-field="model"]').value = cfg.model || '';
    container.querySelector('[data-config-field="thinking"]').value = cfg.thinking || '';
    container.querySelector('[data-config-field="tools"]').value = Array.isArray(cfg.tools)
      ? cfg.tools.join(', ')
      : (cfg.tools || '');
    container.querySelector('[data-config-field="noLsp"]').checked = Boolean(cfg.noLsp);
    container.querySelector('[data-config-field="autoApprove"]').checked = Boolean(cfg.autoApprove);
    container.querySelector('[data-config-field="approvalMode"]').value = cfg.approvalMode || '';
    syncConfigState(row);
    return;
  }

  // Default: claude
  container.innerHTML = h`
    <div class="command-profile-config-summary" data-config-summary></div>
    <label class="command-profile-config-field">Model
      <input type="text" class="command-profile-input" data-config-field="model" placeholder="claude-sonnet-4-6">
    </label>
    <label class="command-profile-config-field">Allowed tools
      <textarea class="command-profile-input command-profile-tools" data-config-field="allowedTools" placeholder="Bash, Edit, Read"></textarea>
    </label>
    <label class="command-profile-check"><input type="checkbox" data-config-field="verbose"> Verbose</label>
  `;
  container.querySelector('[data-config-field="model"]').value = cfg.model || '';
  container.querySelector('[data-config-field="allowedTools"]').value = Array.isArray(cfg.allowedTools)
    ? cfg.allowedTools.join(', ')
    : (cfg.allowedTools || '');
  container.querySelector('[data-config-field="verbose"]').checked = Boolean(cfg.verbose);
  syncConfigState(row);
}

/**
 * Read config fields from the form container and return a config object.
 */
export function readConfigFields(row) {
  const type = row.querySelector('[data-field="type"]')?.value || 'claude';
  const config = {};

  if (type === 'codex') {
    const sandbox = row.querySelector('[data-config-field="sandbox"]')?.value?.trim() || '';
    if (sandbox) config.sandbox = sandbox;
    if (row.querySelector('[data-config-field="skipGitRepoCheck"]')?.checked) config.skipGitRepoCheck = true;
    if (row.querySelector('[data-config-field="bypassApprovals"]')?.checked) config.bypassApprovals = true;
    return config;
  }

  if (type === 'gemini') {
    const outputFormat = row.querySelector('[data-config-field="outputFormat"]')?.value?.trim() || '';
    const approvalMode = row.querySelector('[data-config-field="approvalMode"]')?.value?.trim() || '';
    if (outputFormat) config.outputFormat = outputFormat;
    if (row.querySelector('[data-config-field="sandbox"]')?.checked) config.sandbox = true;
    if (approvalMode) config.approvalMode = approvalMode;
    return config;
  }
  if (type === 'omp') {
    const model = row.querySelector('[data-config-field="model"]')?.value?.trim() || '';
    const thinking = row.querySelector('[data-config-field="thinking"]')?.value?.trim() || '';
    const toolsRaw = row.querySelector('[data-config-field="tools"]')?.value || '';
    const approvalMode = row.querySelector('[data-config-field="approvalMode"]')?.value?.trim() || '';
    if (model) config.model = model;
    if (thinking) config.thinking = thinking;
    const tools = toolsRaw.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    if (tools.length) config.tools = tools;
    if (row.querySelector('[data-config-field="noLsp"]')?.checked) config.noLsp = true;
    if (row.querySelector('[data-config-field="autoApprove"]')?.checked) config.autoApprove = true;
    if (approvalMode) config.approvalMode = approvalMode;
    return config;
  }

  // claude
  const model = row.querySelector('[data-config-field="model"]')?.value?.trim() || '';
  const allowedTools = row.querySelector('[data-config-field="allowedTools"]')?.value || '';
  if (model) config.model = model;
  const tools = allowedTools.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  if (tools.length) config.allowedTools = tools;
  if (row.querySelector('[data-config-field="verbose"]')?.checked) config.verbose = true;
  return config;
}

/**
 * Build a payload object from the form fields in the container.
 */
export function getFormPayload(row) {
  return {
    name: row.querySelector('[data-field="name"]')?.value?.trim() || '',
    scenario: row.querySelector('[data-field="scenario"]')?.value?.trim() || null,
    command: row.querySelector('[data-field="command"]')?.value?.trim() || '',
    type: row.querySelector('[data-field="type"]')?.value || 'claude',
    config_json: readConfigFields(row),
  };
}

/**
 * Reset form fields to defaults.
 */
export function resetForm(row) {
  if (!row) return;
  row.querySelectorAll('[data-field]').forEach((field) => {
    if (field.matches('select')) return;
    field.value = '';
  });
  populateTypeOptions(row.querySelector('[data-field="type"]'), 'claude');
  renderConfigFields(row, 'claude', {});
}

/**
 * Fill form fields from a profile object.
 */
export function fillFormFromProfile(row, profile) {
  const nameInput = row.querySelector('[data-field="name"]');
  const scenarioInput = row.querySelector('[data-field="scenario"]');
  const commandInput = row.querySelector('[data-field="command"]');
  const typeSelect = row.querySelector('[data-field="type"]');
  if (nameInput) nameInput.value = profile.name || '';
  if (scenarioInput) scenarioInput.value = profile.scenario || '';
  if (commandInput) commandInput.value = profile.command || '';
  populateTypeOptions(typeSelect, profile.type || 'claude');
  renderConfigFields(row, profile.type || 'claude', getConfigValue(profile));
}

/**
 * Bind type-change listener that re-renders config fields.
 * Returns a cleanup function.
 */
export function bindTypeChangeListener(row) {
  const handler = (event) => {
    const select = event.target.closest('[data-field="type"]');
    if (!select) return;
    renderConfigFields(row, select.value || 'claude', readConfigFields(row));
  };
  row.addEventListener('change', handler);
  return () => row.removeEventListener('change', handler);
}

/**
 * Helper: get command profile manager singleton.
 */
export function getProfileManager() {
  return window.HAICOCommandProfiles || null;
}
