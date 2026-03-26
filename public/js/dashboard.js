// Cache for last activity data from summary endpoint
let _lastActivityMap = {};
let _notificationsCollapsed = false;
let _notifFilter = 'all'; // 'all' or 'action'
let _inboxSearchQuery = '';
let _inboxAllItems = []; // cached items for search filtering

// Track known action-required issue IDs to detect new ones
let _knownActionIssueIds = null; // null = first load (don't ring on first load)

async function loadDashboardSummary() {
  try {
    const res = await fetch('/api/dashboard/summary', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('stat-running').textContent = data.agents.running;
    document.getElementById('stat-open-issues').textContent = data.issues.open;
    document.getElementById('stat-cost').textContent = '$' + data.total_cost_usd.toFixed(2);

    const errCard = document.getElementById('stat-errors-card');
    if (data.agents.error_count > 0) {
      document.getElementById('stat-errors').textContent = data.agents.error_count;
      errCard.style.display = '';
    } else {
      errCard.style.display = 'none';
    }

    document.getElementById('dashboard-stats').style.display = '';
    _lastActivityMap = data.last_activity || {};
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
    const comments = (data.recent_comments || []).slice(0, 5);
    const totalCount = issues.length;

    // Detect new action-required issues and play notification sound
    const currentIds = new Set(issues.map(i => i.id || i.number));
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
      badge.textContent = totalCount;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }

    // Build items: action-required issues first, then comments
    const items = [];
    for (const issue of issues) {
      items.push({ type: 'issue', time: issue.updated_at, data: issue, actionRequired: true });
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
    // Apply filter
    if (_notifFilter === 'action' && !item.actionRequired) continue;

    if (item.type === 'issue') {
      const issue = item.data;
      // Apply search
      if (query && !matchesSearch(query, '#' + issue.number, issue.title, issue.body || '')) continue;
      const isAction = item.actionRequired;
      html += `<div class="notif-item${isAction ? ' notif-action-required' : ''}" id="notif-issue-${issue.id}" onclick="openIssuePanel('${issue.id}')" style="cursor:pointer">
        <span class="notif-icon" style="color:${isAction ? 'var(--error)' : 'var(--text-secondary)'}">&#9679;</span>
        <span class="notif-text">
          <span style="color:var(--text-secondary);font-size:10px">[${esc(issue.project_name || '')}]</span>
          <a href="/projects/${issue.project_id}/issues/${issue.number}" onclick="event.stopPropagation()">#${issue.number}</a>
          ${esc(issue.title)}
        </span>
        <button class="notif-ack-btn" onclick="event.stopPropagation();acknowledgeIssue('${issue.id}')" title="标记已阅">✓</button>
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
    html = '<div style="padding:12px 16px;color:var(--text-secondary);font-size:12px;text-align:center">无匹配结果</div>';
  } else if (!html) {
    html = '<div style="padding:12px 16px;color:var(--text-secondary);font-size:12px;text-align:center">暂无通知</div>';
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
  // Re-render with current filter + search
  if (_inboxSearchQuery.trim()) {
    searchInboxIssues(_inboxSearchQuery.trim());
  } else {
    renderInboxItems(_inboxAllItems);
  }
}

async function acknowledgeIssue(issueId) {
  try {
    const res = await fetch(`/api/issues/${issueId}/acknowledge`, { method: 'POST' });
    if (res.ok) {
      const el = document.getElementById('notif-issue-' + issueId);
      if (el) el.remove();
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
      container.innerHTML = '<div class="empty-state">Failed to load projects.</div>';
      return;
    }
    const projects = await res.json();
    if (!projects.length) {
      container.innerHTML = '<div class="empty-state">No projects yet. Create one to get started.</div>';
      return;
    }

    // Preserve quick-cmd input values before re-render
    const savedInputs = {};
    container.querySelectorAll('.quick-cmd-input').forEach(input => {
      if (input.value) savedInputs[input.id] = input.value;
    });
    const focusedId = document.activeElement?.classList.contains('quick-cmd-input') ? document.activeElement.id : null;

    container.innerHTML = projects.map(p => {
      const s = p.stats || { agents: 0, running: 0, agentError: 0, issues: 0, openIssues: 0, userIssues: [] };
      const link = `/projects/${p.id}`;
      const userCount = s.userIssues?.length || 0;
      const notifBadge = userCount > 0
        ? `<span onclick="event.stopPropagation();window.location='${link}#issues'" style="background:var(--error);color:#fff;font-size:11px;padding:1px 8px;border-radius:10px;cursor:pointer;margin-left:6px" title="${userCount} issue(s) need your attention">${userCount}</span>`
        : '';
      const lastAct = _lastActivityMap[p.id];
      const activityText = lastAct ? timeAgo(lastAct) : null;
      const activityLine = activityText
        ? `<div class="last-activity">Last activity: ${activityText}</div>`
        : '';
      return `
      <div class="card" style="cursor:pointer" onclick="window.location='${link}'">
        <div class="flex-between">
          <strong style="font-size:15px">${esc(p.name)}${notifBadge}</strong>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="status-badge status-${p.status}">${p.status}</span>
            <button onclick="event.stopPropagation();toggleProjectStatus('${p.id}','${p.status}')" title="${p.status === 'active' ? 'Pause' : 'Resume'}" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:14px;padding:2px 6px;line-height:1">${p.status === 'active' ? '⏸' : '▶'}</button>
          </div>
        </div>
        <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;margin-bottom:12px">${esc(p.description || '')}</p>
        <div style="display:flex;gap:16px;font-size:12px">
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
        <div class="quick-cmd-bar" onclick="event.stopPropagation()">
          <input type="text" class="quick-cmd-input" id="quick-cmd-${p.id}" placeholder="Quick command..." onkeydown="if(event.key==='Enter')sendQuickCmd('${p.id}')">
          <button class="quick-cmd-btn" onclick="sendQuickCmd('${p.id}')" title="Send">&#9654;</button>
        </div>
      </div>
    `}).join('');

    // Restore quick-cmd input values after re-render
    for (const [id, value] of Object.entries(savedInputs)) {
      const input = document.getElementById(id);
      if (input) input.value = value;
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
    if (!task) { alert('Please describe what you want to do'); return; }

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
      controller_interval_min: 0,
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
      showToast(err.error || '创建失败', 'error');
    }
  });
}

async function toggleProjectStatus(projectId, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'paused' : 'active';
  try {
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) { showToast('状态已更新', 'success'); loadProjects(); }
    else showToast('状态更新失败', 'error');
  } catch { showToast('网络错误', 'error'); }
}

async function sendQuickCmd(projectId) {
  const input = document.getElementById('quick-cmd-' + projectId);
  const msg = input.value.trim();
  if (!msg) return;
  const btn = input.nextElementSibling;
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
      body: JSON.stringify({ title: msg, body: msg, created_by: 'user', assigned_to: controller.id })
    });
    if (res.ok) {
      input.value = '';
      showToast('Issue created', 'success');
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '&#9654;';
  }
}

// Initial load: summary + notifications + projects in parallel
async function loadDashboard() {
  await Promise.all([loadDashboardSummary(), loadNotifications(), loadProjects()]);
}

loadDashboard();
// Polling: 10s for lightweight data, 30s for full project list
setInterval(() => { loadDashboardSummary(); loadNotifications(); }, 10000);
setInterval(loadProjects, 30000);

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
  document.getElementById('issueDetailContent').innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary)">Loading...</div>';
  try {
    const res = await fetch(`/api/projects/${projectId}/issues/number/${issueNumber}`, { headers: apiHeaders() });
    if (!res.ok) { document.getElementById('issueDetailContent').innerHTML = '<div style="padding:20px;color:var(--error)">Issue not found</div>'; return; }
    const data = await res.json();
    _panelIssueId = data.id;
    loadIssuePanel(data.id);
  } catch (e) {
    document.getElementById('issueDetailContent').innerHTML = '<div style="padding:20px;color:var(--error)">加载失败</div>';
  }
}

function closeIssuePanel() {
  document.getElementById('issueDetailModal').classList.remove('active');
  _panelIssueId = null;
}

async function loadIssuePanel(issueId) {
  try {
    const res = await fetch(`/api/issues/${issueId}`, { headers: apiHeaders() });
    if (!res.ok) { document.getElementById('issueDetailContent').innerHTML = '<div style="padding:20px;color:var(--error)">Issue not found</div>'; return; }
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
    document.getElementById('issueDetailContent').innerHTML = '<div style="padding:20px;color:var(--error)">加载失败</div>';
  }
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
      });
    }
  } catch {}
})();
