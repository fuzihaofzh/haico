// Cache for last activity data from summary endpoint
let _lastActivityMap = {};
let _notificationsCollapsed = false;
let _notifFilter = 'all'; // 'all' or 'action'
let _inboxSearchQuery = '';
let _inboxAllItems = []; // cached items for search filtering
let _dashboardProjectsById = {};

// Track known action-required issue IDs to detect new ones
let _knownActionIssueIds = null; // null = first load (don't ring on first load)

// Track locally acknowledged issue IDs so they survive inbox refresh
let _acknowledgedIds = new Set();

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
  bypass: {
    badge: 'DEBUG',
    tone: 'debug',
    summary: 'Debug mode',
    detail: 'legacy / localhost bypass',
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

    document.getElementById('stat-running').textContent = data.agents.running;
    document.getElementById('stat-open-issues').textContent = data.issues.open;
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

    // Pending approvals stat
    const approvalCard = document.getElementById('stat-approvals-card');
    if (data.pending_approvals > 0) {
      document.getElementById('stat-approvals').textContent = data.pending_approvals;
      if (approvalCard) approvalCard.style.display = '';
    } else {
      if (approvalCard) approvalCard.style.display = 'none';
    }

    document.getElementById('dashboard-stats').style.display = '';
    _lastActivityMap = data.last_activity || {};
    loadDashboardApprovals();
  } catch (e) {
    console.error('Failed to load dashboard summary', e);
  }
}

async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const issues = data.user_issues || [];
    const comments = (data.recent_comments || []).slice(0, 50);
    const unacknowledgedIssues = issues.filter(i => !i.acknowledged_at);
    const totalCount = unacknowledgedIssues.length;

    // Detect new action-required issues and play notification sound
    const currentIds = new Set(unacknowledgedIssues.map(i => i.id || i.number));
    if (_knownActionIssueIds === null) {
      _knownActionIssueIds = currentIds;
    } else {
      let hasNew = false;
      for (const id of currentIds) {
        if (!_knownActionIssueIds.has(id)) { hasNew = true; break; }
      }
      _knownActionIssueIds = currentIds;
      if (hasNew && typeof playNotificationSound === 'function') {
        playNotificationSound();
      }
    }

    // Always show the Inbox panel
    document.getElementById('notifications-panel').style.display = '';
    const badge = document.getElementById('notif-count');
    if (totalCount > 0) {
      const prevCount = parseInt(badge.textContent, 10) || 0;
      badge.textContent = totalCount;
      badge.style.display = '';
      if (totalCount > prevCount) {
        badge.classList.remove('pulse');
        void badge.offsetWidth;
        badge.classList.add('pulse');
      }
    } else {
      badge.style.display = 'none';
    }

    // Build items: action-required (unacknowledged) issues first, then acknowledged, then comments
    // Sync local acknowledged set with server state:
    // - If server says acknowledged_at is set, keep in local set
    // - If server says acknowledged_at is NULL (e.g. new comment reset it), remove from local set
    for (const issue of issues) {
      if (issue.acknowledged_at) {
        _acknowledgedIds.add(issue.id);
      } else {
        _acknowledgedIds.delete(issue.id);
      }
    }
    const items = [];
    for (const issue of issues) {
      const isAcknowledged = !!issue.acknowledged_at || _acknowledgedIds.has(issue.id);
      items.push({ type: 'issue', time: issue.updated_at, data: issue, actionRequired: !isAcknowledged });
    }
    for (const c of comments) {
      items.push({ type: 'comment', time: c.created_at, data: c, actionRequired: false });
    }
    // Sort: action-required first, then by time desc
    items.sort((a, b) => {
      if (a.actionRequired !== b.actionRequired) return a.actionRequired ? -1 : 1;
      return (b.time || '') > (a.time || '') ? 1 : -1;
    });

    _inboxAllItems = items;
    renderInboxItems(items);
  } catch (e) {
    console.error('Failed to load notifications', e);
  }
}

function renderInboxItems(items) {
  const body = document.getElementById('notifications-body');
  const query = _inboxSearchQuery.toLowerCase().trim();

  let html = '';
  for (const item of items) {
    // Apply filter — but keep recently-acknowledged issues visible (not red)
    const isLocallyAcked = item.type === 'issue' && item.data && _acknowledgedIds.has(item.data.id);
    if (_notifFilter === 'action' && !item.actionRequired && !isLocallyAcked) continue;

    if (item.type === 'issue') {
      const issue = item.data;
      // Apply search
      if (query && !matchesSearch(query, '#' + issue.number, issue.title, issue.body || '')) continue;
      const isAction = item.actionRequired;
      const isAcked = _acknowledgedIds.has(issue.id) || !!issue.acknowledged_at;
      const ackBtnHtml = isAcked ? '' : `<button class="notif-ack-btn" onclick="event.stopPropagation();acknowledgeIssue('${issue.id}')" title="Mark read">✓</button>`;
      html += `<div class="notif-item${isAction ? ' notif-action-required' : ''}" id="notif-issue-${issue.id}" onclick="openIssuePanel('${issue.id}')" style="cursor:pointer">
        <span class="notif-icon" style="color:${isAction ? 'var(--warning)' : 'var(--text-secondary)'}">&#9679;</span>
        <span class="notif-text">
          <span style="color:var(--text-secondary);font-size:10px">[${esc(issue.project_name || '')}]</span>
          <a href="/projects/${issue.project_id}/issues/${issue.number}" onclick="event.stopPropagation()">#${issue.number}</a>
          ${esc(issue.title)}
        </span>
        ${ackBtnHtml}
        <span class="notif-time">${timeAgo(issue.updated_at) || ''}</span>
      </div>`;
    } else {
      const c = item.data;
      if (query && !matchesSearch(query, '#' + c.issue_number, c.issue_title || '', c.body || '')) continue;
      const preview = (c.body || '').slice(0, 60) + ((c.body || '').length > 60 ? '...' : '');
      html += `<div class="notif-item notif-comment" onclick="openIssuePanelByProject('${c.project_id}', ${c.issue_number})" style="cursor:pointer">
        <span class="notif-icon" style="color:var(--text-secondary)">&#9998;</span>
        <span class="notif-text">
          <span style="color:var(--text-secondary);font-size:10px">[${esc(c.project_name || '')}]</span>
          <a href="/projects/${c.project_id}/issues/${c.issue_number}" onclick="event.stopPropagation()">#${c.issue_number}</a>
          <span style="color:var(--text-secondary)">${esc(preview)}</span>
        </span>
        <span class="notif-time">${timeAgo(c.created_at) || ''}</span>
      </div>`;
    }
  }

  if (!html && query) {
    html = '<div style="padding:12px 16px;color:var(--text-secondary);font-size:12px;text-align:center">No results</div>';
  } else if (!html) {
    html = '<div style="padding:12px 16px;color:var(--text-secondary);font-size:12px;text-align:center">No notifications</div>';
  }

  body.innerHTML = html;
  if (_notificationsCollapsed) {
    body.classList.add('collapsed');
    document.getElementById('notif-toggle-icon').classList.add('collapsed');
  }
}

function matchesSearch(query, ...fields) {
  for (const f of fields) {
    if (f.toLowerCase().includes(query)) return true;
  }
  return false;
}

function filterInbox(query) {
  _inboxSearchQuery = query;
  if (query.trim()) {
    // When searching, fetch all issues across projects
    searchInboxIssues(query.trim());
  } else {
    // No search query — show normal inbox items
    renderInboxItems(_inboxAllItems);
  }
}

async function searchInboxIssues(query) {
  try {
    const res = await fetch('/api/inbox/search?q=' + encodeURIComponent(query), { headers: apiHeaders() });
    if (!res.ok) return;
    const results = await res.json();
    // Only mark items as action-required if they are already in the inbox notifications
    const actionIds = new Set(_inboxAllItems.filter(i => i.actionRequired && i.data && i.data.id).map(i => i.data.id));
    const items = results.map(issue => ({
      type: 'issue',
      time: issue.updated_at,
      data: issue,
      actionRequired: actionIds.has(issue.id)
    }));
    // Sort: action-required first, then by time desc
    items.sort((a, b) => {
      if (a.actionRequired !== b.actionRequired) return a.actionRequired ? -1 : 1;
      return (b.time || '') > (a.time || '') ? 1 : -1;
    });
    renderInboxItems(items);
  } catch (e) {
    console.error('Failed to search inbox', e);
  }
}

function toggleNotifications() {
  const body = document.getElementById('notifications-body');
  const icon = document.getElementById('notif-toggle-icon');
  _notificationsCollapsed = !_notificationsCollapsed;
  body.classList.toggle('collapsed');
  icon.classList.toggle('collapsed');
}

function toggleNotifFilter(filter) {
  _notifFilter = filter;
  document.querySelectorAll('.notif-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  if (filter === 'my') {
    loadMyIssues();
  } else if (_inboxSearchQuery.trim()) {
    searchInboxIssues(_inboxSearchQuery.trim());
  } else {
    renderInboxItems(_inboxAllItems);
  }
}

async function loadMyIssues() {
  try {
    const res = await fetch('/api/my-issues', { headers: apiHeaders() });
    if (!res.ok) return;
    const issues = await res.json();
    const items = issues.map(issue => ({
      type: 'issue',
      time: issue.updated_at,
      data: issue,
      actionRequired: issue.assigned_to === 'user' && ['open', 'in_progress'].includes(issue.status)
    }));
    renderInboxItems(items);
  } catch (e) {
    console.error('Failed to load my issues', e);
  }
}

async function acknowledgeIssue(issueId) {
  try {
    const res = await fetch(`/api/issues/${issueId}/acknowledge`, { method: 'POST' });
    if (res.ok) {
      // Track locally so the item survives inbox refresh
      _acknowledgedIds.add(issueId);
      const el = document.getElementById('notif-issue-' + issueId);
      if (el) {
        el.classList.remove('notif-action-required');
        const dot = el.querySelector('.notif-icon');
        if (dot) dot.style.color = 'var(--text-secondary)';
        const ackBtn = el.querySelector('.notif-ack-btn');
        if (ackBtn) ackBtn.style.display = 'none';
      }
      // Update cached items
      const cached = _inboxAllItems.find(i => i.data && i.data.id === issueId);
      if (cached) cached.actionRequired = false;
      // Update badge count
      const remaining = document.querySelectorAll('.notif-action-required').length;
      const badge = document.getElementById('notif-count');
      if (badge) {
        badge.textContent = remaining;
        if (remaining === 0) badge.style.display = 'none';
      }
    }
  } catch (e) {
    console.error('Failed to acknowledge issue', e);
  }
}

async function loadProjects() {
  const container = document.getElementById('projects');
  try {
    const res = await fetch('/api/projects?with_stats=1', { headers: apiHeaders() });
    if (!res.ok) {
      container.innerHTML = renderError(null, 'loadProjects()');
      return;
    }
    const projects = await res.json();
    _dashboardProjectsById = Object.fromEntries(projects.map((project) => [project.id, project]));
    populateActivityProjectFilter();
    if (!projects.length) {
      container.innerHTML = '<div class="empty-state">No projects yet. Create one to get started.</div>';
      return;
    }

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
      const link = `/projects/${p.id}`;
      const access = getProjectAccessMeta(p);
      const ownerName = displayProjectUser(p.owner);
      const ownerRole = p.owner?.role === 'admin' ? 'Global Admin' : 'Project Member';
      const memberCount = Number.isFinite(p.member_count) ? p.member_count : 0;
      const toggleButton = p.can_manage
        ? `<button onclick="event.stopPropagation();toggleProjectStatus('${p.id}','${p.status}')" title="${p.status === 'active' ? 'Pause' : 'Resume'}" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:14px;padding:2px 6px;line-height:1">${p.status === 'active' ? '⏸' : '▶'}</button>`
        : '';
      const userCount = s.userIssues?.length || 0;
      const notifBadge = userCount > 0
        ? `<span onclick="event.stopPropagation();window.location='${link}#issues'" style="background:var(--error);color:#fff;font-size:11px;padding:1px 8px;border-radius:10px;cursor:pointer;margin-left:6px" title="${userCount} issue(s) need your attention">${userCount}</span>`
        : '';
      const lastAct = _lastActivityMap[p.id];
      const activityText = lastAct ? timeAgo(lastAct) : null;
      const activityLine = activityText
        ? `<div class="last-activity">Last activity: ${activityText}</div>`
        : '';
      const quickCmdBar = p.can_manage ? `
        <div class="quick-cmd-bar" onclick="event.stopPropagation()">
          <div class="quick-cmd-row">
            <input type="text" class="quick-cmd-input" id="quick-cmd-${p.id}" placeholder="Quick command..." oninput="toggleQuickCmdBody('${p.id}')" onkeydown="if(event.key==='Enter'&&event.shiftKey&&!event.isComposing){event.preventDefault();sendQuickCmd('${p.id}')}">
            <button class="quick-cmd-btn" onclick="sendQuickCmd('${p.id}')" title="Send">&#9654;</button>
          </div>
          <textarea class="quick-cmd-body" id="quick-cmd-body-${p.id}" placeholder="Details (optional)..." rows="3" data-collapsed></textarea>
        </div>
      ` : '';
      return `
      <div class="card project-card" style="cursor:pointer" onclick="window.location='${link}'">
        <div class="project-card-head">
          <div class="project-card-main">
            <strong class="project-card-title">${esc(p.name)}${notifBadge}</strong>
            <div class="project-card-tags">
              <span class="permission-badge permission-${access.tone}" title="${esc(access.summary)}">${access.badge}</span>
              <span class="meta-chip" title="Project owner">
                <span class="meta-chip-label">Owner</span>
                <span>${esc(ownerName)}</span>
              </span>
              <span class="meta-chip" title="Project member count">
                <span class="meta-chip-label">Members</span>
                <span>${memberCount}</span>
              </span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="status-badge status-${p.status}">${p.status}</span>
            ${toggleButton}
          </div>
        </div>
        <div class="project-card-note">
          <span>${esc(access.detail)}</span>
          <span>·</span>
          <span>${esc(ownerRole)}</span>
        </div>
        <p class="project-card-desc">${esc(p.description || '')}</p>
        <div class="project-card-stats">
          <div style="display:flex;align-items:center;gap:4px;color:var(--text-secondary)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm5 7c0-2.8-2.2-5-5-5s-5 2.2-5 5h10z"/></svg>
            <span>${s.running} running</span>
            <span style="opacity:0.5">/ ${s.agents}</span>
            ${s.agentError > 0 ? `<span style="color:var(--error)">${s.agentError} error</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:4px;color:var(--text-secondary)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            <span>${s.openIssues} open</span>
            <span style="opacity:0.5">/ ${s.issues}</span>
          </div>
        </div>
        ${activityLine}
        ${quickCmdBar}
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
  } catch (e) {
    container.innerHTML = '<div class="empty-state"></div>';
    container.querySelector('.empty-state').textContent = 'Error loading projects: ' + e.message;
  }
}

function showCreateModal() { document.getElementById('createModal').classList.add('active'); }
function hideCreateModal() { document.getElementById('createModal').classList.remove('active'); }

async function createProject() {
  const btn = document.querySelector('#createModal button[onclick="createProject()"]');
  await withLoading(btn, async () => {
    const task = document.getElementById('proj-task').value.trim();
    const toolPath = document.getElementById('proj-cmd').value.trim() || 'cld';
    if (!task) { showToast('Please describe the task to execute', 'error'); return; }

    // Step 1: Call AI to generate project metadata
    btn.textContent = 'Generating...';
    const genRes = await fetch('/api/generate-project', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ description: task, tool_path: toolPath }),
    });

    let name, description, taskDesc, workDir, ctrlRole;
    if (genRes.ok) {
      const gen = await genRes.json();
      name = gen.name || 'project';
      description = gen.description || task.slice(0, 100);
      taskDesc = gen.task_description || task;
      workDir = gen.working_directory || null;
      ctrlRole = gen.controller_role || null;
    } else {
      // Fallback if AI fails
      name = task.slice(0, 30).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'project';
      description = task.slice(0, 100);
      taskDesc = task;
    }

    // Step 2: Create the project
    btn.textContent = 'Creating...';
    const body = {
      name,
      description,
      task_description: taskDesc,
      command_template: toolPath,
      working_directory: workDir,
      controller_role: ctrlRole,
    };

    const res = await fetch('/api/projects', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) {
      const proj = await res.json();
      hideCreateModal();
      window.location.href = '/projects/' + proj.id;
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed to create', 'error');
    }
  });
}

async function toggleProjectStatus(projectId, currentStatus) {
  if (!_dashboardProjectsById[projectId]?.can_manage) {
    showToast('Insufficient permission to update project status', 'error');
    return;
  }
  const newStatus = currentStatus === 'active' ? 'paused' : 'active';
  try {
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) { showToast('Status updated', 'success'); loadProjects(); }
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
    // Find controller agent for this project
    const agentsRes = await fetch(`/api/projects/${projectId}/agents`, { headers: apiHeaders() });
    if (!agentsRes.ok) { showToast('Failed to find controller', 'error'); return; }
    const agents = await agentsRes.json();
    const controller = agents.find(a => a.is_controller);
    if (!controller) { showToast('No controller agent found', 'error'); return; }

    // Create issue assigned to controller
    const res = await fetch(`/api/projects/${projectId}/issues`, {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ title: msg, body: bodyText || msg, created_by: 'user', assigned_to: controller.id })
    });
    if (res.ok) {
      // Re-query DOM elements: loadProjects() may have re-rendered during await,
      // replacing the original elements with new ones
      const curInput = document.getElementById('quick-cmd-' + projectId);
      const curBody = document.getElementById('quick-cmd-body-' + projectId);
      if (curInput) curInput.value = '';
      if (curBody) { curBody.value = ''; curBody.setAttribute('data-collapsed', ''); }
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

// ─── Usage by Project Chart ───

let _usagePeriod = 'day';
const _projectColors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#39d2c0','#ff7b72','#79c0ff','#7ee787','#e3b341'];

function switchUsagePeriod(period) {
  _usagePeriod = period;
  document.querySelectorAll('.usage-period-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === period);
  });
  loadUsageByProject();
}

async function loadUsageByProject() {
  try {
    const res = await fetch(`/api/dashboard/usage-by-project?period=${_usagePeriod}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const panel = document.getElementById('usage-by-project-panel');
    const container = document.getElementById('usage-by-project-chart');
    if (!data.time_buckets || !data.time_buckets.length) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';

    const projects = data.projects;
    const buckets = data.time_buckets;
    const chartData = data.data;

    // Calculate max stacked cost per bucket
    let maxCost = 0.001;
    for (const t of buckets) {
      let sum = 0;
      for (const p of projects) {
        sum += (chartData[t] && chartData[t][p.id]) ? chartData[t][p.id].cost : 0;
      }
      if (sum > maxCost) maxCost = sum;
    }

    const W = 600, H = 200;
    const PAD_L = 50, PAD_R = 16, PAD_T = 12, PAD_B = 32;
    const cw = W - PAD_L - PAD_R, ch = H - PAD_T - PAD_B;
    const n = buckets.length;
    const barW = Math.max(2, (cw / n) * 0.7);
    const gap = cw / n;

    // Y-axis
    const yLabels = [0, maxCost / 2, maxCost].map(v => {
      const y = PAD_T + ch - (v / maxCost) * ch;
      return `<text x="${PAD_L - 6}" y="${y + 3}" text-anchor="end" fill="var(--text-secondary)" font-size="9">$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}</text>
      <line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="var(--border)" stroke-width="0.5" opacity="0.5"/>`;
    }).join('');

    // X-axis
    const step = Math.max(1, Math.floor(n / 6));
    const xLabels = buckets.map((d, i) => {
      if (i % step !== 0 && i !== n - 1) return '';
      const x = PAD_L + i * gap + gap / 2;
      const label = d.length > 10 ? d.slice(5) : d.slice(5);
      return `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--text-secondary)" font-size="8">${label}</text>`;
    }).join('');

    // Stacked bars
    let bars = '';
    for (let i = 0; i < n; i++) {
      const t = buckets[i];
      const x = PAD_L + i * gap + (gap - barW) / 2;
      let yOffset = 0;
      for (let j = 0; j < projects.length; j++) {
        const p = projects[j];
        const entry = chartData[t] && chartData[t][p.id];
        const cost = entry ? entry.cost : 0;
        if (cost <= 0) continue;
        const barH = (cost / maxCost) * ch;
        const y = PAD_T + ch - yOffset - barH;
        const color = _projectColors[j % _projectColors.length];
        bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" opacity="0.85" rx="1">
          <title>${esc(p.name)} ${t}: $${cost.toFixed(4)}</title>
        </rect>`;
        yOffset += barH;
      }
    }

    // Legend
    const legend = projects.map((p, i) => {
      const color = _projectColors[i % _projectColors.length];
      const name = p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name;
      return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary)">
        <span style="width:10px;height:10px;background:${color};border-radius:2px;display:inline-block"></span>${esc(name)}
      </span>`;
    }).join('');

    container.innerHTML = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">
      ${yLabels}${xLabels}${bars}
    </svg>
    <div style="margin-top:6px;line-height:1.8">${legend}</div>`;
  } catch (e) {
    console.error('Failed to load usage by project', e);
  }
}

// Initial load: summary + notifications + projects + usage chart + new panels in parallel
async function loadDashboard() {
  await Promise.all([loadDashboardSummary(), loadNotifications(), loadProjects(), loadUsageByProject(), loadAgentBoard(), loadActivityStream(), checkCostAlert()]);
  populateActivityProjectFilter();
}

loadDashboard();
// Polling: 10s for lightweight data, 30s for full project list, 60s for usage chart
setInterval(() => { loadDashboardSummary(); loadNotifications(); loadActivityStream(); }, 10000);
setInterval(() => { loadProjects(); loadAgentBoard(); }, 30000);
setInterval(() => { loadUsageByProject(); checkCostAlert(); }, 60000);
window.addEventListener('agentopia:user-ready', () => { loadProjects(); populateActivityProjectFilter(); });

// ─── Floating Issue Panel ───

let _panelIssueId = null;
let _panelAgents = [];

function openIssuePanel(issueId) {
  _panelIssueId = issueId;
  document.getElementById('issueDetailModal').classList.add('active');
  loadIssuePanel(issueId);
}

async function openIssuePanelByProject(projectId, issueNumber) {
  document.getElementById('issueDetailModal').classList.add('active');
  document.getElementById('issueDetailContent').innerHTML = renderLoading('Loading issue...');
  try {
    const res = await fetch(`/api/projects/${projectId}/issues/number/${issueNumber}`, { headers: apiHeaders() });
    if (!res.ok) { document.getElementById('issueDetailContent').innerHTML = renderError({ status: res.status }); return; }
    const data = await res.json();
    _panelIssueId = data.id;
    loadIssuePanel(data.id);
  } catch (e) {
    document.getElementById('issueDetailContent').innerHTML = renderError(e, 'openIssuePanelByProject(\'' + projectId + '\',' + issueNumber + ')');
  }
}

function closeIssuePanel() {
  document.getElementById('issueDetailModal').classList.remove('active');
  _panelIssueId = null;
}

async function loadIssuePanel(issueId) {
  try {
    const res = await fetch(`/api/issues/${issueId}`, { headers: apiHeaders() });
    if (!res.ok) { document.getElementById('issueDetailContent').innerHTML = renderError({ status: res.status }); return; }
    const issue = await res.json();

    // Load agents for this project
    try {
      const agentsRes = await fetch(`/api/projects/${issue.project_id}/agents`, { headers: apiHeaders() });
      if (agentsRes.ok) _panelAgents = await agentsRes.json();
    } catch {}

    IssueRenderer.render(issue, _panelAgents, document.getElementById('issueDetailContent'), {
      reload: function() { loadIssuePanel(_panelIssueId); },
      onAfterAction: function() { loadNotifications(); },
    });
  } catch (e) {
    document.getElementById('issueDetailContent').innerHTML = renderError(e, 'loadIssuePanel(\'' + issueId + '\')');
  }
}

// ─── Dashboard Approvals (#616) ───

async function loadDashboardApprovals() {
  const panel = document.getElementById('dashboard-approvals-panel');
  const listEl = document.getElementById('dashboard-approvals-list');
  const countEl = document.getElementById('dashboard-approval-count');
  if (!panel || !listEl) return;

  try {
    const res = await fetch('/api/approvals/pending-count', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    if (data.count === 0) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = '';
    if (countEl) countEl.textContent = data.count;

    // Load actual approvals from all projects
    const projectsRes = await fetch('/api/projects', { headers: apiHeaders() });
    if (!projectsRes.ok) return;
    const projects = await projectsRes.json();

    let allApprovals = [];
    for (const p of projects) {
      try {
        const aRes = await fetch('/api/projects/' + p.id + '/approvals?status=pending&limit=10', { headers: apiHeaders() });
        if (aRes.ok) {
          const items = await aRes.json();
          items.forEach(function(item) { item._project_name = p.name; item._project_id = p.id; });
          allApprovals = allApprovals.concat(items);
        }
      } catch {}
    }

    if (allApprovals.length === 0) {
      panel.style.display = 'none';
      return;
    }

    listEl.innerHTML = allApprovals.map(function(a) {
      const riskColors = { low: 'var(--success)', medium: 'var(--warning)', high: 'var(--error)', critical: 'var(--error)' };
      const riskColor = riskColors[a.risk_level] || 'var(--warning)';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<div>' +
          '<strong>' + esc(a.title) + '</strong>' +
          '<div style="font-size:11px;color:var(--text-secondary)">' +
            '<a href="/projects/' + a._project_id + '#workflow" style="color:var(--link)">' + esc(a._project_name) + '</a>' +
            ' \u00b7 Agent: ' + esc(a.agent_name || 'unknown') +
            ' \u00b7 Risk: <span style="color:' + riskColor + '">' + a.risk_level + '</span>' +
            ' \u00b7 ' + timeAgo(a.created_at) +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:4px;flex-shrink:0">' +
          '<button class="btn btn-sm btn-primary" onclick="dashboardDecideApproval(\'' + a.id + '\', \'approved\')">Approve</button>' +
          '<button class="btn btn-sm" onclick="dashboardDecideApproval(\'' + a.id + '\', \'rejected\')" style="color:var(--error)">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    console.error('Failed to load approvals', e);
    if (panel) panel.style.display = 'none';
  }
}

async function dashboardDecideApproval(approvalId, decision) {
  let note = '';
  if (decision === 'rejected') {
    note = prompt('Reason for rejection (optional):') || '';
  }
  try {
    const res = await fetch('/api/approvals/' + approvalId, {
      method: 'PUT',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: decision, decision_note: note, decided_by: 'user' })
    });
    if (res.ok) {
      showToast('Approval ' + decision, 'success');
      loadDashboardSummary();
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed', 'error');
    }
  } catch (e) {
    showToast('Failed to submit decision', 'error');
  }
}

// ─── Activity Stream (#618) ───

let _activityStreamData = [];

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
          icon = '<span style="color:var(--success)">&#9679;</span>';
          label = 'New Issue';
          detail = '<a href="/projects/' + ev.project_id + '/issues/' + ev.number + '" onclick="event.stopPropagation()">#' + ev.number + '</a> ' + esc(ev.title);
          break;
        case 'issue_status_change':
          icon = '<span style="color:var(--accent)">&#8635;</span>';
          label = ev.status;
          detail = '<a href="/projects/' + ev.project_id + '/issues/' + ev.number + '" onclick="event.stopPropagation()">#' + ev.number + '</a> ' + esc(ev.title);
          break;
        case 'comment':
          icon = '<span style="color:var(--text-secondary)">&#9998;</span>';
          label = 'Comment';
          var preview = (ev.body || '').slice(0, 50) + ((ev.body || '').length > 50 ? '...' : '');
          detail = '<a href="/projects/' + ev.project_id + '/issues/' + ev.issue_number + '" onclick="event.stopPropagation()">#' + ev.issue_number + '</a> ' + esc(preview);
          break;
        case 'agent_started':
          icon = '<span style="color:var(--success)">&#9654;</span>';
          label = 'Agent Started';
          detail = '<a href="/projects/' + ev.project_id + '/agents/' + ev.object_id + '">' + esc(ev.agent_name) + '</a>';
          break;
        case 'agent_stopped':
          icon = '<span style="color:var(--text-secondary)">&#9632;</span>';
          label = 'Agent Stopped';
          detail = '<a href="/projects/' + ev.project_id + '/agents/' + ev.object_id + '">' + esc(ev.agent_name) + '</a>';
          break;
        case 'approval_created':
          icon = '<span style="color:var(--warning)">&#9888;</span>';
          label = 'Approval Needed';
          detail = esc(ev.title);
          break;
        case 'approval_decided':
          icon = '<span style="color:var(--success)">&#10003;</span>';
          label = 'Approval ' + (ev.approval_status || '');
          detail = esc(ev.title);
          break;
        default:
          icon = '<span style="color:var(--text-secondary)">&#183;</span>';
          label = ev.event_type;
          detail = '';
      }

      return '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:flex-start">' +
        '<div style="flex-shrink:0;width:16px;text-align:center;line-height:18px">' + icon + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;justify-content:space-between;gap:8px">' +
            '<span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">[' + esc(ev.project_name || '') + ']</span>' +
            '<span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">' + timeAgo(ev.time) + '</span>' +
          '</div>' +
          '<div><span class="status-badge status-' + (label.toLowerCase().replace(/\s+/g,'-')) + '" style="font-size:10px;padding:1px 4px;margin-right:4px">' + esc(label) + '</span>' + detail + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    console.error('Failed to load activity stream', e);
  }
}

function populateActivityProjectFilter() {
  var filter = document.getElementById('activity-project-filter');
  if (!filter) return;
  var current = filter.value;
  var options = '<option value="">All Projects</option>';
  for (var id in _dashboardProjectsById) {
    var p = _dashboardProjectsById[id];
    options += '<option value="' + id + '"' + (id === current ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  }
  filter.innerHTML = options;
}

let _activityStreamCollapsed = false;
function toggleActivityStream() {
  _activityStreamCollapsed = !_activityStreamCollapsed;
  var list = document.getElementById('activity-stream-list');
  var btn = document.getElementById('activity-toggle-btn');
  if (list) list.style.display = _activityStreamCollapsed ? 'none' : '';
  if (btn) btn.textContent = _activityStreamCollapsed ? 'Expand' : 'Collapse';
  var panel = document.getElementById('activity-stream-panel');
  if (panel) panel.style.maxHeight = _activityStreamCollapsed ? 'none' : '400px';
}

// ─── Agent Status Board (#618) ───

let _agentBoardFilter = 'running';
let _agentBoardData = [];

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
      list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:12px">No agents with status: ' + esc(_agentBoardFilter) + '</div>';
      return;
    }

    list.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px">' +
      agents.map(function(agent) {
        var statusColors = { running: 'var(--success)', error: 'var(--error)', waiting: 'var(--warning)', idle: 'var(--text-secondary)' };
        var statusIcons = { running: '&#9654;', error: '&#9888;', waiting: '&#8987;', idle: '&#9679;' };
        var color = statusColors[agent.status] || 'var(--text-secondary)';
        var icon = statusIcons[agent.status] || '&#9679;';
        var issueInfo = agent.current_issue
          ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">#' + agent.current_issue.number + ' ' + esc(agent.current_issue.title) + '</div>'
          : '';
        var controllerBadge = agent.is_controller ? '<span style="font-size:9px;background:var(--accent);color:#fff;padding:0 4px;border-radius:3px;margin-left:4px">CTRL</span>' : '';
        var pausedBadge = agent.paused ? '<span style="font-size:9px;background:var(--warning);color:#000;padding:0 4px;border-radius:3px;margin-left:4px">PAUSED</span>' : '';

        return '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:10px 12px;display:flex;align-items:flex-start;gap:8px">' +
          '<div style="color:' + color + ';font-size:14px;flex-shrink:0;line-height:18px">' + icon + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:center;gap:4px">' +
              '<a href="/projects/' + agent.project_id + '/agents/' + agent.id + '" style="font-weight:600;font-size:13px;color:var(--fg);text-decoration:none">' + esc(agent.name) + '</a>' +
              controllerBadge + pausedBadge +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-secondary)">' +
              '<a href="/projects/' + agent.project_id + '" style="color:var(--link)">' + esc(agent.project_name) + '</a>' +
              ' · <span style="color:' + color + '">' + agent.status + '</span>' +
            '</div>' +
            issueInfo +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
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

// ─── Cost Alert (#618) ───

let _costAlertDismissed = false;
const COST_ALERT_THRESHOLD = parseFloat(localStorage.getItem('agentopia-cost-threshold') || '10');

async function checkCostAlert() {
  if (_costAlertDismissed) return;
  try {
    const res = await fetch('/api/dashboard/today-cost', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const banner = document.getElementById('cost-alert-banner');
    const text = document.getElementById('cost-alert-text');
    if (!banner || !text) return;

    if (data.today_cost_usd > COST_ALERT_THRESHOLD) {
      var projectBreakdown = Object.values(data.by_project).map(function(p) {
        return esc(p.name) + ': $' + p.cost.toFixed(2);
      }).join(', ');
      text.textContent = "Today's spending: $" + data.today_cost_usd.toFixed(2) + ' (threshold: $' + COST_ALERT_THRESHOLD.toFixed(2) + ')' + (projectBreakdown ? ' — ' + projectBreakdown : '');
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  } catch (e) {
    console.error('Failed to check cost alert', e);
  }
}

function dismissCostAlert() {
  _costAlertDismissed = true;
  var banner = document.getElementById('cost-alert-banner');
  if (banner) banner.style.display = 'none';
}

// Listen for events from all projects and refresh dashboard on changes
(async function setupDashboardWS() {
  try {
    const res = await fetch('/api/projects', { headers: apiHeaders() });
    if (!res.ok) return;
    const projects = await res.json();
    for (const p of projects) {
      const ev = connectProjectEvents(p.id);
      ev.on('*', function() {
        loadDashboardSummary();
        loadNotifications();
        loadProjects();
        loadActivityStream();
        loadAgentBoard();
      });
    }
  } catch {}
})();
