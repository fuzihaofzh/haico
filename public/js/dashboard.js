// Cache for last activity data from summary endpoint
let _lastActivityMap = {};
let _notificationsCollapsed = false;
let _notifFilter = 'all'; // 'all' or 'action'

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
      // First load — just record, don't ring
      _knownActionIssueIds = currentIds;
    } else {
      // Check for any new IDs not in previous set
      let hasNew = false;
      for (const id of currentIds) {
        if (!_knownActionIssueIds.has(id)) { hasNew = true; break; }
      }
      _knownActionIssueIds = currentIds;
      if (hasNew && typeof playNotificationSound === 'function') {
        playNotificationSound();
      }
    }

    if (totalCount === 0 && comments.length === 0) {
      document.getElementById('notifications-panel').style.display = 'none';
      return;
    }

    document.getElementById('notifications-panel').style.display = '';
    const badge = document.getElementById('notif-count');
    if (totalCount > 0) {
      badge.textContent = totalCount;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }

    const body = document.getElementById('notifications-body');

    // Merge issues and comments into a single list, sorted newest first
    const items = [];
    for (const issue of issues) {
      items.push({ type: 'issue', time: issue.updated_at, data: issue });
    }
    for (const c of comments) {
      items.push({ type: 'comment', time: c.created_at, data: c });
    }
    items.sort((a, b) => (b.time || '') > (a.time || '') ? 1 : -1);

    let html = '';
    for (const item of items) {
      if (item.type === 'issue') {
        const issue = item.data;
        html += `<div class="notif-item notif-action-required">
          <span class="notif-icon" style="color:var(--error)">&#9679;</span>
          <span class="notif-text">
            <span style="color:var(--text-secondary);font-size:11px">[${esc(issue.project_name || '')}]</span>
            <a href="/projects/${issue.project_id}/issues/${issue.number}" onclick="event.stopPropagation()">#${issue.number}</a>
            ${esc(issue.title)}
          </span>
          <span class="notif-time">${timeAgo(issue.updated_at) || ''}</span>
        </div>`;
      } else {
        const c = item.data;
        const preview = (c.body || '').slice(0, 80) + ((c.body || '').length > 80 ? '...' : '');
        html += `<div class="notif-item notif-comment" style="${_notifFilter === 'action' ? 'display:none' : ''}">
          <span class="notif-icon" style="color:var(--text-secondary)">&#9998;</span>
          <span class="notif-text">
            <span style="color:var(--text-secondary);font-size:11px">[${esc(c.project_name || '')}]</span>
            <a href="/projects/${c.project_id}/issues/${c.issue_number}" onclick="event.stopPropagation()">#${c.issue_number}</a>
            <span style="color:var(--text-secondary)">${esc(preview)}</span>
          </span>
          <span class="notif-time">${timeAgo(c.created_at) || ''}</span>
        </div>`;
      }
    }

    body.innerHTML = html;
    // Restore collapsed state
    if (_notificationsCollapsed) {
      body.classList.add('collapsed');
      document.getElementById('notif-toggle-icon').classList.add('collapsed');
    }
  } catch (e) {
    console.error('Failed to load notifications', e);
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
  // Update active button
  document.querySelectorAll('.notif-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  // Show/hide items based on filter
  const body = document.getElementById('notifications-body');
  body.querySelectorAll('.notif-item').forEach(item => {
    if (filter === 'all') {
      item.style.display = '';
    } else {
      // 'action' filter: only show action-required items
      item.style.display = item.classList.contains('notif-action-required') ? '' : 'none';
    }
  });
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
          <span class="status-badge status-${p.status}">${p.status}</span>
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
      </div>
    `}).join('');
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

// Initial load: summary + notifications + projects in parallel
async function loadDashboard() {
  await Promise.all([loadDashboardSummary(), loadNotifications(), loadProjects()]);
}

loadDashboard();
// Polling: 10s for lightweight data, 30s for full project list
setInterval(() => { loadDashboardSummary(); loadNotifications(); }, 10000);
setInterval(loadProjects, 30000);

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
