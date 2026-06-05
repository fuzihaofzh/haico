// agent-edit.js — ES module for the agent edit page
// URL pattern: /project/:pid/agent/:id/edit

import { showToast } from '/public/js/components/toast.js';

// ─── State ───

let agentId = '';
let projectId = '';
let agent = null;
let project = null;
let skillsList = [];
let executorProfiles = [];
let projectAgents = [];
let systemPromptText = '';
let dirty = new Set();

// ─── URL Parsing ───

function parsePath() {
  const m = window.location.pathname.match(/^\/project\/([^/]+)\/agent\/([^/]+)\/edit$/);
  if (!m) {
    document.getElementById('agent-edit-content').innerHTML = renderError('Invalid URL');
    return false;
  }
  projectId = decodeURIComponent(m[1]);
  agentId = decodeURIComponent(m[2]);
  return true;
}

// ─── API Helpers ───

async function apiFetch(url) {
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Data Loading ───

async function loadAll() {
  const root = document.getElementById('agent-edit-content');
  root.innerHTML = renderLoading('Loading agent...');

  try {
    const [agentData, projectData, skillsData, profilesData, agentsData] = await Promise.all([
      apiFetch(`/api/agents/${encodeURIComponent(agentId)}`),
      apiFetch(`/api/projects/${encodeURIComponent(projectId)}`),
      apiFetch('/api/skills'),
      apiFetch(`/api/projects/${encodeURIComponent(projectId)}/executor-profiles`),
      apiFetch(`/api/projects/${encodeURIComponent(projectId)}/agents`),
    ]);

    agent = agentData;
    project = projectData;
    skillsList = skillsData || [];
    executorProfiles = profilesData || [];
    projectAgents = agentsData || [];

    renderPage();
  } catch (e) {
    root.innerHTML = renderError(e.message || 'Failed to load agent data');
  }
}

// ─── JSON Parsing Helpers ───

function parseJsonField(val, fallback) {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

function getCapabilities() { return parseJsonField(agent.capabilities_json, []); }
function getContext() { return parseJsonField(agent.context_json, {}); }
function getConstraints() { return parseJsonField(agent.constraints_json, {}); }
function getExecutorPrefs() { return parseJsonField(agent.executor_preferences_json, {}); }

// ─── Dirty Tracking ───

function markDirty(field) {
  dirty.add(field);
}

// ─── Rendering ───

function renderPage() {
  const root = document.getElementById('agent-edit-content');
  const canManage = !!project?.can_manage;
  const ro = canManage ? '' : 'disabled';
  const controllerTag = agent.is_controller ? '<span class="controller-tag">[controller]</span>' : '';
  const statusHtml = agent.status ? `<span class="status-badge status-${agent.status}">${esc(agent.status)}</span>` : '';

  // Breadcrumb links
  const projectLink = document.getElementById('project-link');
  const agentLink = document.getElementById('agent-link');
  if (projectLink) {
    projectLink.href = `/project/${encodeURIComponent(projectId)}`;
    projectLink.textContent = project?.name || 'Project';
  }
  if (agentLink) {
    agentLink.href = `/agents/${encodeURIComponent(agentId)}`;
    agentLink.textContent = agent.name || 'Agent';
  }

  root.innerHTML = h`
    <div>
      <a class="edit-back-link" href="/project/${encodeURIComponent(projectId)}/agents">← Back to Agents</a>

      <div class="edit-page-title">
        ${html(roleAvatarHtml(agent.name, 32, project?.color))}
        <h2>${esc(agent.name)}</h2>
        ${html(controllerTag)}
        ${html(statusHtml)}
      </div>

      <div class="tab-bar" role="tablist">
        <button class="tab active" data-tab="identity" role="tab" aria-selected="true">Identity</button>
        <button class="tab" data-tab="skills" role="tab" aria-selected="false">Skills</button>
        <button class="tab" data-tab="execution" role="tab" aria-selected="false">Execution</button>
        <button class="tab" data-tab="advanced" role="tab" aria-selected="false">Advanced</button>
      </div>

      <div class="tab-panel active" data-panel="identity">
        ${html(renderIdentityTab(ro))}
      </div>
      <div class="tab-panel" data-panel="skills">
        ${html(renderSkillsTab(ro))}
      </div>
      <div class="tab-panel" data-panel="execution">
        ${html(renderExecutionTab(ro))}
      </div>
      <div class="tab-panel" data-panel="advanced">
        ${html(renderAdvancedTab(ro))}
      </div>

      <div class="save-bar">
        <button class="btn" id="btn-cancel" ${canManage ? '' : 'disabled'}>Cancel</button>
        <button class="btn btn-primary" id="btn-save" ${canManage ? '' : 'disabled'}>Save</button>
      </div>
    </div>
  `;

  bindEvents(canManage);
}

// ─── Tab: Identity ───

function renderIdentityTab(ro) {
  const ctx = getContext();
  const parentAgent = agent.parent_agent_id
    ? projectAgents.find(a => a.id === agent.parent_agent_id)
    : null;
  const childAgents = projectAgents.filter(a => a.parent_agent_id === agent.id);

  return h`
    <div class="form-group">
      <label for="f-name">Name</label>
      <input type="text" id="f-name" value="${esc(agent.name || '')}" ${ro} data-field="name">
    </div>

    <div class="form-group">
      <label for="f-role">Role</label>
      <textarea id="f-role" rows="3" ${ro} data-field="role">${esc(agent.role || '')}</textarea>
    </div>

    <div class="form-group">
      <label for="f-custom-instructions">Custom Instructions</label>
      <textarea id="f-custom-instructions" rows="4" ${ro} data-field="custom_instructions" placeholder="Extra instructions appended to system prompt...">${esc(agent.custom_instructions || '')}</textarea>
      <div class="hint">Appended to the auto-generated system prompt</div>
    </div>

    <div class="readonly-info">
      <div class="readonly-info-item">
        <div class="label">Controller</div>
        <div class="value">${agent.is_controller ? 'Yes' : 'No'}</div>
      </div>
      <div class="readonly-info-item">
        <div class="label">Parent Agent</div>
        <div class="value">${parentAgent ? esc(parentAgent.name) : 'None'}</div>
      </div>
      <div class="readonly-info-item">
        <div class="label">Direct Reports</div>
        <div class="value">${childAgents.length > 0 ? childAgents.map(c => esc(c.name)).join(', ') : 'None'}</div>
      </div>
      <div class="readonly-info-item">
        <div class="label">Created</div>
        <div class="value">${formatLocalDateTime(agent.created_at)}</div>
      </div>
    </div>
  `;
}

// ─── Tab: Skills ───

function renderSkillsTab(ro) {
  const capabilities = getCapabilities();
  const ctx = getContext();

  const items = skillsList.map(skill => {
    const checked = capabilities.includes(skill.id);
    const triggerBadge = skill.hasTrigger ? '<span class="skill-badge trigger">⚡ Trigger</span>' : '';
    const actionBadge = skill.hasAction ? '<span class="skill-badge action">⚡ Action</span>' : '';

    // Skill-specific config
    let configHtml = '';
    if (skill.id === 'scheduled-check') {
      const interval = ctx.scheduled_check_interval_seconds ?? 60;
      configHtml = h`
        <div class="skill-config ${checked ? 'visible' : ''}" data-skill-config="${skill.id}">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:3px">Check interval (seconds)</label>
          <input type="number" id="f-scheduled-check-interval" value="${interval}" min="10" ${ro} data-field="scheduled_check_interval_seconds">
          <div class="hint">How often the agent checks for triggered conditions</div>
        </div>
      `;
    }

    return h`
      <div class="skill-item">
        <input type="checkbox" id="f-skill-${esc(skill.id)}" data-skill-id="${esc(skill.id)}" ${checked ? 'checked' : ''} ${ro}>
        <div class="skill-item-label">
          <div class="skill-name">${esc(skill.id)} ${html(triggerBadge)} ${html(actionBadge)}</div>
          <div class="skill-desc">${esc(skill.description)}</div>
        </div>
      </div>
      ${html(configHtml)}
    `;
  }).join('');

  return h`
    <div style="margin-bottom:8px;font-size:13px;color:var(--text-secondary)">Select the skills this agent should have. Skills add capabilities and prompt context.</div>
    <div id="skills-list">
      ${html(items)}
    </div>
  `;
}

// ─── Tab: Execution ───

function renderExecutionTab(ro) {
  const constraints = getConstraints();
  const execPrefs = getExecutorPrefs();
  const currentProfileId = execPrefs.default_executor_profile_id || '';

  const profileOptions = executorProfiles.map(p =>
    `<option value="${esc(p.id)}" ${p.id === currentProfileId ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  const maxConcurrent = constraints.max_concurrent_tasks ?? 1;
  const isPaused = !!agent.paused;

  return h`
    <div class="form-group">
      <label for="f-workdir">Working Directory</label>
      <input type="text" id="f-workdir" value="${esc(agent.working_directory || '')}" ${ro} data-field="working_directory" style="font-family:monospace" placeholder="(default)">
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="f-executor-profile">Executor Profile</label>
        <select id="f-executor-profile" ${ro} data-field="default_executor_profile_id">
          <option value="">(default)</option>
          ${html(profileOptions)}
        </select>
      </div>

      <div class="form-group">
        <label for="f-max-concurrent">Max Concurrent Tasks</label>
        <input type="number" id="f-max-concurrent" value="${maxConcurrent}" min="1" ${ro} data-field="max_concurrent_tasks">
        <div class="hint">Maximum number of tasks this agent can handle simultaneously</div>
      </div>
    </div>

    <div class="form-group">
      <label>Paused</label>
      <div class="toggle-row">
        <div class="toggle-switch ${isPaused ? 'on' : ''}" id="f-paused" data-field="paused" role="switch" aria-checked="${isPaused}" tabindex="0">
          <div class="toggle-knob"></div>
        </div>
        <span style="font-size:13px;color:var(--text-secondary)">${isPaused ? 'Agent is paused and will not run' : 'Agent is active'}</span>
      </div>
    </div>
  `;
}

// ─── Tab: Advanced ───

function renderAdvancedTab(ro) {
  const capabilities = getCapabilities();
  const ctx = getContext();
  const constraints = getConstraints();
  const execPrefs = getExecutorPrefs();

  // Build parent agent options excluding self and descendants
  const descendantIds = getDescendantIds(agentId);
  const parentOptions = projectAgents
    .filter(a => a.id !== agentId && !descendantIds.has(a.id))
    .map(a => `<option value="${esc(a.id)}" ${a.id === agent.parent_agent_id ? 'selected' : ''}>${esc(a.name)}${a.is_controller ? ' [controller]' : ''}</option>`)
    .join('');

  const contextJsonStr = JSON.stringify(ctx, null, 2);
  const constraintsJsonStr = JSON.stringify(constraints, null, 2);

  return h`
    <div class="form-group">
      <label for="f-parent-agent">Parent Agent</label>
      <select id="f-parent-agent" ${ro || (agent.is_controller ? 'disabled' : '')} data-field="parent_agent_id">
        <option value="">None (root level)</option>
        ${html(parentOptions)}
      </select>
      <div class="hint">${agent.is_controller ? 'The controller stays at the root by default.' : 'You cannot choose this agent or its descendants as the parent.'}</div>
    </div>

    <div class="form-group">
      <div class="sysprompt-toggle" id="sysprompt-toggle">
        <span id="sysprompt-arrow">▶</span> System Prompt (auto-generated, read-only)
      </div>
      <pre class="sysprompt-content" id="sysprompt-content">Loading...</pre>
    </div>

    <div class="form-row" style="margin-bottom:14px">
      <div class="form-group">
        <label>Agent ID</label>
        <div class="copy-id-row">
          <code>${esc(agentId)}</code>
          <button class="copy-btn" data-copy="${esc(agentId)}">Copy</button>
        </div>
      </div>
      <div class="form-group">
        <label>Project ID</label>
        <div class="copy-id-row">
          <code>${esc(projectId)}</code>
          <button class="copy-btn" data-copy="${esc(projectId)}">Copy</button>
        </div>
      </div>
    </div>

    <div class="form-group">
      <label>context_json</label>
      <textarea class="debug-textarea" rows="8" readonly>${esc(contextJsonStr)}</textarea>
    </div>

    <div class="form-group">
      <label>constraints_json</label>
      <textarea class="debug-textarea" rows="4" readonly>${esc(constraintsJsonStr)}</textarea>
    </div>
  `;
}

// ─── Descendant ID computation ───

function getDescendantIds(agentId) {
  const ids = new Set();
  const queue = [agentId];
  while (queue.length) {
    const current = queue.shift();
    for (const a of projectAgents) {
      if (a.parent_agent_id === current && !ids.has(a.id)) {
        ids.add(a.id);
        queue.push(a.id);
      }
    }
  }
  return ids;
}

// ─── Event Binding ───

function bindEvents(canManage) {
  // Tab switching
  document.querySelectorAll('.tab-bar .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-bar .tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const panel = document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  if (!canManage) return;

  // Dirty tracking for text/number/select inputs
  document.querySelectorAll('#agent-edit-content [data-field]').forEach(el => {
    if (el.id === 'f-paused') return; // handled separately
    const eventType = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'number') ? 'change' : 'input';
    el.addEventListener(eventType, () => markDirty(el.dataset.field));
  });

  // Skills checkboxes
  document.querySelectorAll('#skills-list input[type="checkbox"][data-skill-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      markDirty('capabilities_json');
      // Toggle skill-specific config visibility
      const configEl = document.querySelector(`[data-skill-config="${cb.dataset.skillId}"]`);
      if (configEl) configEl.classList.toggle('visible', cb.checked);
    });
  });

  // Scheduled check interval input
  const intervalInput = document.getElementById('f-scheduled-check-interval');
  if (intervalInput) {
    intervalInput.addEventListener('input', () => markDirty('scheduled_check_interval_seconds'));
  }

  // Paused toggle
  const pausedToggle = document.getElementById('f-paused');
  if (pausedToggle) {
    const handleToggle = () => {
      const isOn = pausedToggle.classList.toggle('on');
      pausedToggle.setAttribute('aria-checked', isOn);
      markDirty('paused');
      const label = pausedToggle.nextElementSibling;
      if (label) label.textContent = isOn ? 'Agent is paused and will not run' : 'Agent is active';
    };
    pausedToggle.addEventListener('click', handleToggle);
    pausedToggle.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handleToggle(); }
    });
  }

  // System prompt toggle
  const syspromptToggle = document.getElementById('sysprompt-toggle');
  if (syspromptToggle) {
    syspromptToggle.addEventListener('click', () => {
      const content = document.getElementById('sysprompt-content');
      const arrow = document.getElementById('sysprompt-arrow');
      if (!content) return;
      const isVisible = content.classList.toggle('visible');
      if (arrow) arrow.textContent = isVisible ? '▼' : '▶';
      if (isVisible && !systemPromptText) {
        loadSystemPrompt();
      }
    });
  }

  // Copy buttons
  document.querySelectorAll('.copy-btn[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        showToast('Copied', 'success');
      }).catch(() => {
        showToast('Copy failed', 'error');
      });
    });
  });

  // Save button
  const saveBtn = document.getElementById('btn-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveAgent(saveBtn));
  }

  // Cancel button
  const cancelBtn = document.getElementById('btn-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      dirty.clear();
      location.href = `/project/${encodeURIComponent(projectId)}/agents`;
    });
  }
}

// ─── Load System Prompt ───

async function loadSystemPrompt() {
  const el = document.getElementById('sysprompt-content');
  if (!el) return;
  try {
    const data = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/system-prompt`);
    systemPromptText = data.prompt || data.system_prompt || JSON.stringify(data, null, 2);
    el.textContent = systemPromptText;
  } catch (e) {
    el.textContent = 'Failed to load system prompt: ' + (e.message || 'Unknown error');
  }
}

// ─── Save Agent ───

async function saveAgent(btn) {
  if (dirty.size === 0) {
    showToast('No changes to save', 'info');
    return;
  }

  await withLoading(btn, async () => {
    const body = {};

    for (const field of dirty) {
      switch (field) {
        case 'name': {
          const val = document.getElementById('f-name')?.value?.trim();
          if (val) body.name = val;
          break;
        }
        case 'role': {
          body.role = document.getElementById('f-role')?.value?.trim() || null;
          break;
        }
        case 'custom_instructions': {
          const val = document.getElementById('f-custom-instructions')?.value?.trim();
          body.custom_instructions = val || null;
          break;
        }
        case 'working_directory': {
          body.working_directory = document.getElementById('f-workdir')?.value?.trim() || null;
          break;
        }
        case 'parent_agent_id': {
          body.parent_agent_id = document.getElementById('f-parent-agent')?.value || null;
          break;
        }
        case 'paused': {
          const toggle = document.getElementById('f-paused');
          body.paused = toggle ? toggle.classList.contains('on') : false;
          break;
        }
        case 'capabilities_json': {
          const checked = [];
          document.querySelectorAll('#skills-list input[type="checkbox"][data-skill-id]').forEach(cb => {
            if (cb.checked) checked.push(cb.dataset.skillId);
          });
          body.capabilities_json = JSON.stringify(checked);
          break;
        }
        case 'max_concurrent_tasks': {
          const constraints = getConstraints();
          const val = parseInt(document.getElementById('f-max-concurrent')?.value, 10);
          constraints.max_concurrent_tasks = isNaN(val) ? 1 : Math.max(1, val);
          body.constraints_json = JSON.stringify(constraints);
          break;
        }
        case 'default_executor_profile_id': {
          const execPrefs = getExecutorPrefs();
          execPrefs.default_executor_profile_id = document.getElementById('f-executor-profile')?.value || null;
          body.executor_preferences_json = JSON.stringify(execPrefs);
          break;
        }
        case 'scheduled_check_interval_seconds': {
          const ctx = getContext();
          const val = parseInt(document.getElementById('f-scheduled-check-interval')?.value, 10);
          ctx.scheduled_check_interval_seconds = isNaN(val) ? 60 : Math.max(10, val);
          body.context_json = JSON.stringify(ctx);
          break;
        }
      }
    }

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify(body),
      });

      if (res.ok) {
        showToast('Saved', 'success');
        dirty.clear();
        location.href = `/project/${encodeURIComponent(projectId)}/agents`;
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to save', 'error');
      }
    } catch (e) {
      showToast('Failed to save: network error', 'error');
    }
  });
}

// ─── Init ───

if (parsePath()) {
  loadAll();
}
