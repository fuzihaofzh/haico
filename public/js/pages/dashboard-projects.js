import { initDashboardPage, invalidateDashboardProjects, loadDashboardProjects, setupDashboardWS } from './dashboard-core.js';
import { showToast } from '../components/toast.js';

let _currentUser = null;
let _lastActivityMap = {};
let _dashboardProjectsById = {};
let _dashboardProjectsLoadPromise = null;
let _activityStreamData = [];
let _activityStreamCollapsed = false;
let _agentBoardFilter = 'running';
let _agentBoardData = [];

function openProjectCard(projectId) {
  const project = _dashboardProjectsById[projectId];
  if (project) window.location.href = buildProjectPageHref(project.id);
}
function getLocalDashboardProjects() {
  return Object.values(_dashboardProjectsById || {}).filter((project) => project && !isRemoteProject(project));
}

const PROJECT_ACCESS_META = {
  owner: {
    badge: 'OWNER',
    tone: 'owner',
    summary: 'Project Owner',
    detail: 'Owned by you',
  },
  member: {
    badge: 'SHARED',
    tone: 'shared',
    summary: 'Shared Member',
    detail: 'Shared with you',
  },
  admin: {
    badge: 'ADMIN VIEW',
    tone: 'admin',
    summary: 'Global Admin',
    detail: 'Admin view',
  },
  none: {
    badge: 'UNKNOWN',
    tone: 'shared',
    summary: 'Unknown role',
    detail: 'Role info missing',
  },
};

function displayProjectUser(user) {
  if (!user) return 'Not set';
  return user.display_name || user.username || 'Not set';
}

function getProjectAccessLevel(project) {
  if (project?.owner?.id && _currentUser?.id && project.owner.id === _currentUser.id) {
    return 'owner';
  }
  return project?.permission_level || 'none';
}

function getProjectAccessMeta(project) {
  return PROJECT_ACCESS_META[getProjectAccessLevel(project)] || PROJECT_ACCESS_META.none;
}

async function loadDashboardSummary() {
  try {
    const res = await fetch('/api/dashboard/summary', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    _lastActivityMap = data.last_activity || {};

    const runningStat = document.getElementById('stat-running');
    const openIssuesStat = document.getElementById('stat-open-issues');
    if (!runningStat || !openIssuesStat) return;

    runningStat.textContent = data.agents.running;
    openIssuesStat.textContent = data.issues.open;
    const fmtTokensDash = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;
    if (data.total_cost_usd > 0) {
      document.getElementById('stat-cost').textContent = '$' + data.total_cost_usd.toFixed(2);
    } else if (data.total_input_tokens > 0) {
      document.getElementById('stat-cost').textContent = fmtTokensDash(data.total_input_tokens) + '↑ ' + fmtTokensDash(data.total_output_tokens) + '↓';
      const costLabel = document.getElementById('stat-cost')?.closest('.stat-card')?.querySelector('.stat-label');
      if (costLabel) costLabel.textContent = 'Token Usage';
    }

    const errCard = document.getElementById('stat-errors-card');
    if (data.agents.error_count > 0) {
      document.getElementById('stat-errors').textContent = data.agents.error_count;
      errCard.style.display = '';
    } else {
      errCard.style.display = 'none';
    }

    document.getElementById('dashboard-stats').style.display = '';
  } catch (e) {
    console.error('Failed to load dashboard summary', e);
  }
}

async function loadProjects(options = {}) {
  if (_dashboardProjectsLoadPromise) return _dashboardProjectsLoadPromise;

  const container = document.getElementById('projects');
  _dashboardProjectsLoadPromise = (async () => {
    try {
      const projects = await loadDashboardProjects({ force: options.force === true });
      _dashboardProjectsById = Object.fromEntries(projects.map((project) => [project.id, project]));
      populateActivityProjectFilter();
      if (!projects.length) {
        if (container) container.innerHTML = h`<div class="empty-state">No projects yet. Create one to get started.</div>`;
        return projects;
      }

      if (!container) return projects;
      // Preserve quick-cmd input values before re-render
      const savedInputs = {};
      container.querySelectorAll('.quick-cmd-input').forEach(input => {
        if (input.value) savedInputs[input.id] = input.value;
      });
      const savedBodies = {};
      container.querySelectorAll('.quick-cmd-body').forEach(ta => {
        if (ta.value) savedBodies[ta.id] = ta.value;
      });
      const focusedEl = document.activeElement;
      const focusedId = (focusedEl?.classList.contains('quick-cmd-input') || focusedEl?.classList.contains('quick-cmd-body')) ? focusedEl.id : null;

      container.innerHTML = projects.map(p => {
        const s = p.stats || { agents: 0, running: 0, agentError: 0, issues: 0, openIssues: 0, userIssues: [] };
        const remote = isRemoteProject(p);
        const link = buildProjectPageHref(p.id);
        const access = remote
          ? { badge: 'REMOTE', tone: 'remote', summary: 'Remote instance', detail: `Connected via ${p.remote_instance_name || p.remote_base_url || 'remote instance'}` }
          : getProjectAccessMeta(p);
        const ownerName = remote ? (p.remote_instance_name || 'Remote instance') : displayProjectUser(p.owner);
        const ownerRole = remote ? 'Remote HAICO' : (p.owner?.role === 'admin' ? 'Global Admin' : 'Project Member');
        const memberCount = Number.isFinite(p.member_count) ? p.member_count : 0;
        const toggleButton = !remote && p.can_manage
          ? h`<button data-action="toggle-project-status" data-project-id="${p.id}" data-project-status="${p.status}" title="${p.status === 'active' ? 'Pause' : 'Resume'}" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:14px;padding:2px 6px;line-height:1">${p.status === 'active' ? '⏸' : '▶'}</button>`
          : '';
        const userCount = remote ? 0 : (s.userIssues?.length || 0);
        const notifBadge = userCount > 0
          ? h`<a href="${link}/issues" style="background:var(--error);color:#fff;font-size:11px;padding:1px 8px;border-radius:10px;cursor:pointer;margin-left:6px" title="${userCount} issue(s) need your attention">${userCount}</a>`
          : '';
        const lastAct = remote ? p.updated_at : _lastActivityMap[p.id];
        const activityText = lastAct ? timeAgo(lastAct) : null;
        const activityLine = activityText
          ? h`<div class="last-activity">Last activity: ${activityText}</div>`
          : '';
        const remoteSource = remote
          ? h`<div class="project-card-source">Source: ${p.remote_instance_name || p.remote_base_url || 'Remote instance'}</div>`
          : '';
        const remoteChip = remote
          ? h`<span class="meta-chip meta-chip-remote" title="Remote instance URL">${p.remote_base_url || ''}</span>`
          : '';
        const agentError = s.agentError > 0
          ? h`<span style="color:var(--error)">${s.agentError} error</span>`
          : '';
        const quickCmdBar = !remote && p.can_manage ? h`
          <div class="quick-cmd-bar" data-action="stop-card-open">
            <div class="quick-cmd-row">
              <input type="text" class="quick-cmd-input" id="quick-cmd-${p.id}" placeholder="Quick command..." data-action="quick-cmd-input" data-project-id="${p.id}">
              <button class="quick-cmd-btn" data-action="send-quick-cmd" data-project-id="${p.id}" title="Send">&#9654;</button>
            </div>
            <textarea class="quick-cmd-body" id="quick-cmd-body-${p.id}" placeholder="Details (optional)..." rows="3" data-collapsed></textarea>
          </div>
        ` : '';
        return h`
        <div class="card project-card" style="cursor:pointer" data-action="open-project-card" data-project-id="${p.id}">
          <div class="project-card-head">
            <div class="project-card-main">
              <strong class="project-card-title">${p.name}${html(notifBadge)}</strong>
              ${html(remoteSource)}
              <div class="project-card-tags">
                <span class="permission-badge permission-${access.tone}" title="${access.summary}">${access.badge}</span>
                <span class="meta-chip" title="Project owner">
                  <span class="meta-chip-label">Owner</span>
                  <span>${ownerName}</span>
                </span>
                ${html(remoteChip)}
                <span class="meta-chip" title="Project member count">
                  <span class="meta-chip-label">Members</span>
                  <span>${memberCount}</span>
                </span>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="status-badge status-${p.status}">${p.status}</span>
              ${html(toggleButton)}
            </div>
          </div>
          <div class="project-card-note">
            <span>${access.detail}</span>
            <span>·</span>
            <span>${ownerRole}</span>
          </div>
          <p class="project-card-desc">${p.description || ''}</p>
          <div class="project-card-stats">
            <div style="display:flex;align-items:center;gap:4px;color:var(--text-secondary)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm5 7c0-2.8-2.2-5-5-5s-5 2.2-5 5h10z"/></svg>
              <span>${s.running} running</span>
              <span style="opacity:0.5">/ ${s.agents}</span>
              ${html(agentError)}
            </div>
            <div style="display:flex;align-items:center;gap:4px;color:var(--text-secondary)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
              <span>${s.openIssues} open</span>
              <span style="opacity:0.5">/ ${s.issues}</span>
            </div>
          </div>
          ${html(activityLine)}
          ${html(quickCmdBar)}
        </div>
      `}).join('');

      // Restore quick-cmd input values after re-render
      for (const [id, value] of Object.entries(savedInputs)) {
        const input = document.getElementById(id);
        if (input) {
          input.value = value;
          // Also restore body textarea visibility
          const pId = id.replace('quick-cmd-', '');
          const body = document.getElementById('quick-cmd-body-' + pId);
          if (body) body.removeAttribute('data-collapsed');
        }
      }
      for (const [id, value] of Object.entries(savedBodies)) {
        const ta = document.getElementById(id);
        if (ta) ta.value = value;
      }
      if (focusedId) {
        const el = document.getElementById(focusedId);
        if (el) el.focus();
      }
      return projects;
    } catch (e) {
      if (container) {
        container.innerHTML = h`<div class="empty-state"></div>`;
        container.querySelector('.empty-state').textContent = 'Error loading projects: ' + e.message;
      }
      return [];
    } finally {
      _dashboardProjectsLoadPromise = null;
    }
  })();

  return _dashboardProjectsLoadPromise;
}

async function toggleProjectStatus(projectId, currentStatus) {
  if (!_dashboardProjectsById[projectId]?.can_manage) {
    showToast('Insufficient permission to update project status', 'error');
    return;
  }
  const newStatus = currentStatus === 'active' ? 'paused' : 'active';
  try {
    const res = await fetch(buildProjectApiPath(projectId, ''), {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) {
      invalidateDashboardProjects();
      showToast('Status updated', 'success');
      loadProjects({ force: true });
    }
    else showToast('Failed to update status', 'error');
  } catch { showToast('Network error', 'error'); }
}

function toggleQuickCmdBody(projectId) {
  const input = document.getElementById('quick-cmd-' + projectId);
  const body = document.getElementById('quick-cmd-body-' + projectId);
  if (!body) return;
  if (input.value.trim()) {
    body.removeAttribute('data-collapsed');
  } else {
    body.setAttribute('data-collapsed', '');
  }
}

async function sendQuickCmd(projectId) {
  if (!_dashboardProjectsById[projectId]?.can_manage) {
    showToast('Insufficient permission to create task', 'error');
    return;
  }
  const input = document.getElementById('quick-cmd-' + projectId);
  const bodyEl = document.getElementById('quick-cmd-body-' + projectId);
  const msg = input.value.trim();
  if (!msg) return;
  const bodyText = bodyEl ? bodyEl.value.trim() : '';
  const btn = input.parentElement.querySelector('.quick-cmd-btn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    // Use cached controller agent ID from project stats (avoids extra API call)
    const controllerId = _dashboardProjectsById[projectId]?.stats?.controllerAgentId;
    if (!controllerId) { showToast('No controller agent found', 'error'); return; }

    // Create issue assigned to controller
    const res = await fetch(buildProjectApiPath(projectId, '/issues'), {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ title: msg, body: bodyText || msg, created_by: 'user', assigned_to: controllerId })
    });
    if (res.ok) {
      // Re-query DOM elements: loadProjects() may have re-rendered during await,
      // replacing the original elements with new ones
      const curInput = document.getElementById('quick-cmd-' + projectId);
      const curBody = document.getElementById('quick-cmd-body-' + projectId);
      if (curInput) curInput.value = '';
      if (curBody) { curBody.value = ''; curBody.setAttribute('data-collapsed', ''); }
      invalidateDashboardProjects();
      showToast('Issue created', 'success');
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  } finally {
    // Re-query button in case DOM was re-rendered
    const curBtn = document.getElementById('quick-cmd-' + projectId)?.parentElement?.querySelector('.quick-cmd-btn');
    if (curBtn) { curBtn.disabled = false; curBtn.innerHTML = '&#9654;'; }
  }
}

async function loadActivityStream() {
  try {
    const filter = document.getElementById('activity-project-filter');
    const projectId = filter ? filter.value : '';
    const url = '/api/dashboard/activity-stream?limit=50' + (projectId ? '&project_id=' + projectId : '');
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) return;
    const events = await res.json();
    _activityStreamData = events;

    const panel = document.getElementById('activity-stream-panel');
    const list = document.getElementById('activity-stream-list');
    if (!panel || !list) return;

    var countEl = document.getElementById('activity-stream-count');
    if (countEl) countEl.textContent = events.length > 0 ? '(' + events.length + ')' : '';

    if (events.length === 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'flex';

    list.innerHTML = events.map(function(ev) {
      let icon = '', label = '', detail = '', link = '';

      switch (ev.event_type) {
        case 'issue_created':
          icon = h`<span style="color:var(--success)">&#9679;</span>`;
          label = 'New Issue';
          detail = h`<a href="${buildIssuePageHref({ issueId: ev.id, projectId: ev.project_id, issueNumber: ev.number })}">#${ev.number}</a> ${ev.title}`;
          break;
        case 'issue_status_change':
          icon = h`<span style="color:var(--accent)">&#8635;</span>`;
          label = ev.status;
          detail = h`<a href="${buildIssuePageHref({ issueId: ev.id, projectId: ev.project_id, issueNumber: ev.number })}">#${ev.number}</a> ${ev.title}`;
          break;
        case 'comment':
          icon = h`<span style="color:var(--text-secondary)">&#9998;</span>`;
          label = 'Comment';
          var preview = (ev.body || '').slice(0, 50) + ((ev.body || '').length > 50 ? '...' : '');
          detail = h`<a href="${buildIssuePageHref({ issueId: ev.id, projectId: ev.project_id, issueNumber: ev.issue_number })}">#${ev.issue_number}</a> ${preview}`;
          break;
        case 'agent_started':
          icon = h`<span style="color:var(--success)">&#9654;</span>`;
          label = 'Agent Started';
          detail = h`<a href="${buildProjectPageHref(ev.project_id)}/agents">${ev.agent_name}</a>`;
          break;
        case 'agent_stopped':
          icon = h`<span style="color:var(--text-secondary)">&#9632;</span>`;
          label = 'Agent Stopped';
          detail = h`<a href="${buildProjectPageHref(ev.project_id)}/agents">${ev.agent_name}</a>`;
          break;
        default:
          icon = h`<span style="color:var(--text-secondary)">&#183;</span>`;
          label = ev.event_type;
          detail = '';
      }
      const statusClass = label.toLowerCase().replace(/\s+/g,'-');

      return h`<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:flex-start">
        <div style="flex-shrink:0;width:16px;text-align:center;line-height:18px">${html(icon)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">[${ev.project_name || ''}]</span>
            <span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">${timeAgo(ev.time)}</span>
          </div>
          <div><span class="status-badge status-${statusClass}" style="font-size:10px;padding:1px 4px;margin-right:4px">${label}</span>${html(detail)}</div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    console.error('Failed to load activity stream', e);
  }
}

function populateActivityProjectFilter() {
  var filter = document.getElementById('activity-project-filter');
  if (!filter) return;
  var current = filter.value;
  var options = h`<option value="">All Projects</option>`;
  for (var p of getLocalDashboardProjects()) {
    var id = p.id;
    var selectedAttr = id === current ? h` selected` : '';
    options += h`<option value="${id}"${html(selectedAttr)}>${p.name}</option>`;
  }
  filter.innerHTML = options;
}

function toggleActivityStream() {
  _activityStreamCollapsed = !_activityStreamCollapsed;
  var list = document.getElementById('activity-stream-list');
  var btn = document.getElementById('activity-toggle-btn');
  if (list) list.style.display = _activityStreamCollapsed ? 'none' : '';
  if (btn) btn.textContent = _activityStreamCollapsed ? 'Expand' : 'Collapse';
  var panel = document.getElementById('activity-stream-panel');
  if (panel) panel.style.maxHeight = _activityStreamCollapsed ? 'none' : '400px';
}

async function loadAgentBoard() {
  try {
    const statusParam = _agentBoardFilter !== 'all' ? '?status=' + _agentBoardFilter : '';
    const res = await fetch('/api/dashboard/agents' + statusParam, { headers: apiHeaders() });
    if (!res.ok) return;
    const agents = await res.json();
    _agentBoardData = agents;

    const panel = document.getElementById('agent-board-panel');
    const list = document.getElementById('agent-board-list');
    if (!panel || !list) return;

    if (agents.length === 0 && _agentBoardFilter === 'all') {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';

    if (agents.length === 0) {
      list.innerHTML = h`<div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:12px">No agents with status: ${_agentBoardFilter}</div>`;
      return;
    }

    list.innerHTML = h`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px">
      ${html(agents.map(function(agent) {
        var statusColors = { running: 'var(--success)', error: 'var(--error)', waiting: 'var(--warning)', idle: 'var(--text-secondary)' };
        var statusIcons = { running: '&#9654;', error: '&#9888;', waiting: '&#8987;', idle: '&#9679;' };
        var color = statusColors[agent.status] || 'var(--text-secondary)';
        var icon = statusIcons[agent.status] || '&#9679;';
        var issueInfo = agent.current_issue
          ? h`<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">#${agent.current_issue.number} ${agent.current_issue.title}</div>`
          : '';
        var controllerBadge = agent.is_controller ? h`<span style="font-size:9px;background:var(--accent);color:#fff;padding:0 4px;border-radius:3px;margin-left:4px">CTRL</span>` : '';
        var pausedBadge = agent.paused ? h`<span style="font-size:9px;background:var(--warning);color:#000;padding:0 4px;border-radius:3px;margin-left:4px">PAUSED</span>` : '';
        var remoteBadge = agent.is_remote ? h`<span style="font-size:9px;background:var(--selected-bg);color:var(--accent);padding:0 4px;border-radius:3px;margin-left:4px">REMOTE</span>` : '';

        return h`<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:10px 12px;display:flex;align-items:flex-start;gap:8px">
          <div style="color:${color};font-size:14px;flex-shrink:0;line-height:18px">${html(icon)}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:4px">
              <a href="${buildProjectPageHref(agent.project_id)}/agents" style="font-weight:600;font-size:13px;color:var(--fg);text-decoration:none">${agent.name}</a>
              ${html(controllerBadge)}${html(pausedBadge)}${html(remoteBadge)}
            </div>
            <div style="font-size:11px;color:var(--text-secondary)">
              <a href="${buildProjectPageHref(agent.project_id)}" style="color:var(--link)">${agent.project_name}</a>
              · <span style="color:${color}">${agent.status}</span>
            </div>
            ${html(issueInfo)}
          </div>
        </div>`;
      }).join(''))}
    </div>`;
  } catch (e) {
    console.error('Failed to load agent board', e);
  }
}

function filterAgentBoard(status) {
  _agentBoardFilter = status;
  document.querySelectorAll('.agent-filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  loadAgentBoard();
}

function bindProjectsEvents() {
  document.body.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (actionEl.closest('a')) return;
    if (action === 'stop-card-open') {
      event.stopPropagation();
      return;
    }
    if (action === 'open-project-card') {
      openProjectCard(actionEl.dataset.projectId || '');
    } else if (action === 'toggle-project-status') {
      event.stopPropagation();
      toggleProjectStatus(actionEl.dataset.projectId || '', actionEl.dataset.projectStatus || '');
    } else if (action === 'send-quick-cmd') {
      event.stopPropagation();
      sendQuickCmd(actionEl.dataset.projectId || '');
    } else if (action === 'filter-agent-board') {
      filterAgentBoard(actionEl.dataset.status || 'running');
    } else if (action === 'toggle-activity-stream') {
      toggleActivityStream();
    }
  });
  document.body.addEventListener('input', (event) => {
    const input = event.target.closest('[data-action="quick-cmd-input"]');
    if (input) toggleQuickCmdBody(input.dataset.projectId || '');
  });
  document.body.addEventListener('keydown', (event) => {
    const input = event.target.closest('[data-action="quick-cmd-input"]');
    if (input && event.key === 'Enter' && event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendQuickCmd(input.dataset.projectId || '');
    }
  });
  document.getElementById('activity-project-filter')?.addEventListener('change', loadActivityStream);
}

async function refreshProjectsPage() {
  await Promise.all([loadDashboardSummary(), loadProjects({ force: true }), loadAgentBoard(), loadActivityStream()]);
}

function startProjectsPolling() {
  return setInterval(refreshProjectsPage, 30000);
}

window.addEventListener('haico:user-ready', (event) => {
  _currentUser = event.detail || null;
});

async function initProjectsPage() {
  bindProjectsEvents();
  await initDashboardPage('projects');
  await refreshProjectsPage();
  startProjectsPolling();
  setupDashboardWS(refreshProjectsPage);
}

initProjectsPage().catch((error) => {
  console.error('Failed to initialize projects dashboard', error);
});
