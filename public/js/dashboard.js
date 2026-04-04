// Cache for last activity data from summary endpoint
let _lastActivityMap = {};
let _notificationsCollapsed = false;
let _notifFilter = 'all'; // 'all' or 'action'
let _inboxScope = 'user'; // 'user' (default: user-related only) or 'all'
let _inboxProject = ''; // '' = all projects, or a specific project_id
let _inboxSearchQuery = '';
let _inboxAllItems = []; // cached items for search filtering
let _selectedMailIdx = -1; // currently selected mail index
let _renderedMailItems = []; // currently rendered (filtered) items
let _currentReplyIssueId = null; // issue ID for the currently visible reply box
let _dashboardProjectsById = {};

// Inbox issue detail caches
const _issueDetailCache = {}; // issueId -> { data, timestamp }
const _projectAgentsCache = {}; // projectId -> { data, timestamp }
const ISSUE_CACHE_TTL = 30000; // 30s - background refresh after this

// Track known action-required issue IDs to detect new ones
let _knownActionIssueIds = null; // null = first load (don't ring on first load)

// Track locally acknowledged issue IDs so they survive inbox refresh
let _acknowledgedIds = new Set();
// Track in-flight acknowledge requests to prevent sync from reverting them
let _pendingAcks = new Set();

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
    const _t = performance.now();
    const res = await fetch('/api/dashboard/summary', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const _d = performance.now() - _t; if (_d > 1000) console.warn(`[perf] loadDashboardSummary: ${Math.round(_d)}ms`);

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
    const _nt0 = performance.now();
    const res = await fetch('/api/notifications?scope=' + encodeURIComponent(_inboxScope), { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const _nt1 = performance.now();
    if (_nt1 - _nt0 > 1000) console.warn(`[perf] loadNotifications: ${Math.round(_nt1-_nt0)}ms`);

    const issues = data.user_issues || [];
    const comments = (data.recent_comments || []).slice(0, 50);
    // Only count actionable (assigned_to=user) + unacknowledged issues for badge/notifications
    const actionableUnacknowledged = issues.filter(i => i.is_actionable && !i.acknowledged_at);
    const totalCount = actionableUnacknowledged.length;

    // Detect new action-required issues and play notification sound (only actionable)
    const currentIds = new Set(actionableUnacknowledged.map(i => i.id || i.number));
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
      } else if (!_pendingAcks.has(issue.id)) {
        // Only remove from local set if there's no in-flight acknowledge request
        _acknowledgedIds.delete(issue.id);
      }
    }
    // Group comments by issue_id, keeping only the latest comment per issue
    const latestCommentByIssue = {};
    for (const c of comments) {
      const existing = latestCommentByIssue[c.issue_id];
      if (!existing || c.created_at > existing.created_at) {
        latestCommentByIssue[c.issue_id] = c;
      }
    }

    const items = [];
    for (const issue of issues) {
      const isAcknowledged = !!issue.acknowledged_at || _acknowledgedIds.has(issue.id);
      const latestComment = latestCommentByIssue[issue.id];
      // Use latest comment's time/body if it's newer than the issue's updated_at
      let displayTime = issue.updated_at;
      let latestPreview = null;
      if (latestComment && latestComment.created_at > issue.updated_at) {
        displayTime = latestComment.created_at;
        latestPreview = latestComment.body;
      }
      // Only actionable issues (assigned_to=user) can be action-required; created-only issues are always "read"
      const isActionable = !!issue.is_actionable;
      items.push({ type: 'issue', time: displayTime, data: issue, actionRequired: isActionable && !isAcknowledged, latestPreview });
    }
    // Sort: action-required first, then by time desc
    items.sort((a, b) => {
      if (a.actionRequired !== b.actionRequired) return a.actionRequired ? -1 : 1;
      return (b.time || '') > (a.time || '') ? 1 : -1;
    });

    // Invalidate issue caches for issues whose updated_at changed
    for (const issue of issues) {
      const cached = _issueDetailCache[issue.id];
      if (cached && cached.data.updated_at !== issue.updated_at) {
        delete _issueDetailCache[issue.id];
      }
    }

    _inboxAllItems = items;
    renderInboxItems(items);
  } catch (e) {
    console.error('Failed to load notifications', e);
  }
}

function renderInboxItems(items) {
  const body = document.getElementById('notifications-body');
  const query = _inboxSearchQuery.toLowerCase().trim();

  // Filter items
  const filtered = [];
  for (const item of items) {
    // Project filter
    if (_inboxProject) {
      const pid = item.data.project_id;
      if (pid && pid !== _inboxProject) continue;
    }
    const isLocallyAcked = item.data && _acknowledgedIds.has(item.data.id);
    if (_notifFilter === 'action' && !item.actionRequired && !isLocallyAcked) continue;
    const issue = item.data;
    if (query && !matchesSearch(query, '#' + issue.number, issue.title, issue.body || '')) continue;
    filtered.push(item);
  }
  _renderedMailItems = filtered;

  let html = '';
  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    const isSelected = i === _selectedMailIdx;
    const issue = item.data;
    const isUnread = item.actionRequired;
    const project = esc(issue.project_name || '');
    const previewText = (issue.latest_comment_body || item.latestPreview || issue.body || '').replace(/\n/g, ' ').slice(0, 100) + ((issue.latest_comment_body || item.latestPreview || issue.body || '').length > 100 ? '…' : '');
    const displayTime = item.time || issue.updated_at;
    // Avatar: show role-based avatar for latest comment author (sender), fallback to assigned agent
    const senderAuthorId = issue.latest_comment_author_id;
    const senderRole = issue.latest_comment_author_role || issue.assigned_agent_role;
    const senderName = issue.latest_comment_author_name || issue.assigned_agent_name;
    const senderIsUser = !senderAuthorId || senderAuthorId === 'user';
    const avatarHtml = senderIsUser || !senderRole
      ? avatarSvg(senderIsUser ? 'user' : (senderName || senderAuthorId || '?'), 32)
      : roleAvatarHtml(senderRole, 32, issue.project_color || '#4A90E2');
    html += `<div class="mail-item${isUnread ? ' mail-unread' : ''}${isSelected ? ' mail-selected' : ''}" onclick="selectMailItem(${i})" onmouseenter="prefetchIssueDetail('${issue.id}')" data-idx="${i}">
      <span class="mail-item-dot ${isUnread ? 'unread' : 'read'}"></span>
      <div class="mail-item-avatar">${avatarHtml}</div>
      <div class="mail-item-content">
        <div class="mail-item-top">
          <span class="mail-item-from">${project} #${issue.number}</span>
          <span class="mail-item-time">${timeAgo(displayTime) || ''}</span>
        </div>
        <div class="mail-item-subject">${isUnread ? '<span class="mail-item-badge action">!</span>' : (!issue.is_actionable ? '<span class="mail-item-badge sent">已发送</span>' : '')}${esc(issue.title)}</div>
        <div class="mail-item-preview">${esc(previewText)}</div>
      </div>
    </div>`;
  }

  if (!html && query) {
    html = '<div style="padding:20px;color:var(--text-secondary);font-size:12px;text-align:center">No results</div>';
  } else if (!html) {
    html = '<div style="padding:20px;color:var(--text-secondary);font-size:12px;text-align:center">No notifications</div>';
  }

  body.innerHTML = html;

  // Collapse state
  const mailBody = document.getElementById('mail-body');
  if (mailBody && _notificationsCollapsed) {
    mailBody.classList.add('collapsed');
  }
}

function selectMailItem(idx) {
  _selectedMailIdx = idx;
  // Highlight selected in list
  document.querySelectorAll('.mail-item').forEach((el, i) => {
    el.classList.toggle('mail-selected', i === idx);
  });

  const item = _renderedMailItems[idx];
  const detail = document.getElementById('mail-detail-pane');
  _currentReplyIssueId = null;
  if (!item) {
    detail.innerHTML = '<div class="mail-detail-empty"><div class="mail-detail-empty-icon">&#9993;</div><div>Select a message to read</div></div>';
    return;
  }

  const issue = item.data;
  // Mark as read (acknowledge)
  if (item.actionRequired && !_acknowledgedIds.has(issue.id)) {
    acknowledgeIssue(issue.id);
  }
  _currentReplyIssueId = issue.id;
  detail.innerHTML = '<div style="padding:20px;color:var(--text-secondary);font-size:12px;">Loading issue...</div>';
  loadInboxIssueDetail(issue.id, idx);
}

async function loadInboxIssueDetail(issueId, expectedIdx, forceRefresh) {
  const detail = document.getElementById('mail-detail-pane');
  const now = Date.now();
  const cached = _issueDetailCache[issueId];

  // Show cached data instantly if available
  if (cached && !forceRefresh) {
    if (_selectedMailIdx !== expectedIdx) return;
    const agentsCached = _projectAgentsCache[cached.data.project_id];
    const agents = agentsCached ? agentsCached.data : [];
    _currentReplyIssueId = cached.data.id;
    IssueRenderer.render(cached.data, agents, detail, {
      reload: function() { loadInboxIssueDetail(issueId, _selectedMailIdx, true); },
      onAfterAction: function() { loadNotifications(); },
    });

    // Background refresh if cache is stale
    if (now - cached.timestamp > ISSUE_CACHE_TTL) {
      loadInboxIssueDetail(issueId, expectedIdx, true);
    }
    return;
  }

  // Determine project_id from inbox item data for parallel agents fetch
  let knownProjectId = null;
  const inboxItem = _renderedMailItems[expectedIdx];
  if (inboxItem && inboxItem.data) {
    knownProjectId = inboxItem.data.project_id;
  }

  try {
    // Fetch issue and agents in parallel when project_id is known
    const _t0 = performance.now();
    const issuePromise = fetch(`/api/issues/${issueId}`, { headers: apiHeaders() });
    let agentsPromise = null;
    if (knownProjectId) {
      const agentsCached = _projectAgentsCache[knownProjectId];
      if (!agentsCached || now - agentsCached.timestamp >= 60000) {
        agentsPromise = fetch(`/api/projects/${knownProjectId}/agents`, { headers: apiHeaders() });
      }
    }

    const [issueRes, agentsRes] = await Promise.all([
      issuePromise,
      agentsPromise || Promise.resolve(null),
    ]);
    const _t1 = performance.now();

    if (!issueRes.ok || _selectedMailIdx !== expectedIdx) return;
    const issue = await issueRes.json();
    const _t2 = performance.now();
    console.log(`[perf] loadInboxIssueDetail: fetch=${Math.round(_t1-_t0)}ms parse=${Math.round(_t2-_t1)}ms total=${Math.round(_t2-_t0)}ms id=${issueId}`);

    // Cache issue data
    _issueDetailCache[issueId] = { data: issue, timestamp: now };

    // Process agents result
    let agents = [];
    if (agentsRes && agentsRes.ok) {
      agents = await agentsRes.json();
      _projectAgentsCache[issue.project_id] = { data: agents, timestamp: now };
    } else {
      const agentsCached = _projectAgentsCache[issue.project_id];
      if (agentsCached) {
        agents = agentsCached.data;
      } else if (!agentsPromise) {
        // project_id wasn't known before, fetch agents now
        try {
          const res2 = await fetch(`/api/projects/${issue.project_id}/agents`, { headers: apiHeaders() });
          if (res2.ok) {
            agents = await res2.json();
            _projectAgentsCache[issue.project_id] = { data: agents, timestamp: now };
          }
        } catch {}
      }
    }

    if (_selectedMailIdx !== expectedIdx) return;
    _currentReplyIssueId = issue.id;
    IssueRenderer.render(issue, agents, detail, {
      reload: function() { loadInboxIssueDetail(issueId, _selectedMailIdx, true); },
      onAfterAction: function() { loadNotifications(); },
    });
  } catch (e) {
    if (!cached) {
      detail.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">Failed to load issue</div>';
    }
  }
}

// Prefetch issue detail on hover for faster click response
function prefetchIssueDetail(issueId) {
  if (_issueDetailCache[issueId]) return;
  fetch(`/api/issues/${issueId}`, { headers: apiHeaders() })
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data && !_issueDetailCache[issueId]) {
        _issueDetailCache[issueId] = { data, timestamp: Date.now() };
      }
    })
    .catch(() => {});
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
  const mailBody = document.getElementById('mail-body');
  if (!mailBody) return;
  _notificationsCollapsed = !_notificationsCollapsed;
  mailBody.classList.toggle('collapsed');
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

function toggleInboxScope(scope) {
  _inboxScope = scope;
  document.querySelectorAll('.inbox-scope-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scope === scope);
  });
  // Reload notifications with new scope
  loadNotifications();
}

function toggleInboxProject(projectId) {
  _inboxProject = projectId;
  if (_notifFilter === 'my') {
    loadMyIssues();
  } else if (_inboxSearchQuery.trim()) {
    searchInboxIssues(_inboxSearchQuery.trim());
  } else {
    renderInboxItems(_inboxAllItems);
  }
}

function populateInboxProjectFilter() {
  const filter = document.getElementById('inbox-project-filter');
  if (!filter) return;
  const current = filter.value;
  let options = '<option value="">All Projects</option>';
  for (const id in _dashboardProjectsById) {
    const p = _dashboardProjectsById[id];
    options += '<option value="' + id + '"' + (id === current ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  }
  filter.innerHTML = options;
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
  // Optimistically update state before server response to prevent race with polling
  _acknowledgedIds.add(issueId);
  _pendingAcks.add(issueId);
  // Update cached items
  const cached = _inboxAllItems.find(i => i.data && i.data.id === issueId);
  if (cached) cached.actionRequired = false;
  // Update the mail list item visually
  const idx = _renderedMailItems.findIndex(i => i.data && i.data.id === issueId);
  if (idx >= 0) {
    const el = document.querySelector(`.mail-item[data-idx="${idx}"]`);
    if (el) {
      el.classList.remove('mail-unread');
      const dot = el.querySelector('.mail-item-dot');
      if (dot) { dot.classList.remove('unread'); dot.classList.add('read'); }
      const actionBadge = el.querySelector('.mail-item-badge.action');
      if (actionBadge) actionBadge.remove();
    }
  }
  // Update badge count
  const remaining = _inboxAllItems.filter(i => i.actionRequired).length;
  const badge = document.getElementById('notif-count');
  if (badge) {
    badge.textContent = remaining;
    if (remaining === 0) badge.style.display = 'none';
  }
  try {
    const res = await fetch(`/api/issues/${issueId}/acknowledge`, { method: 'POST' });
    if (!res.ok) {
      // Revert on failure
      _acknowledgedIds.delete(issueId);
      if (cached) cached.actionRequired = true;
    }
  } catch (e) {
    console.error('Failed to acknowledge issue', e);
    _acknowledgedIds.delete(issueId);
    if (cached) cached.actionRequired = true;
  } finally {
    _pendingAcks.delete(issueId);
  }
}

async function loadProjects() {
  const container = document.getElementById('projects');
  try {
    const _t = performance.now();
    const res = await fetch('/api/projects?with_stats=1', { headers: apiHeaders() });
    const _d = performance.now() - _t; if (_d > 1000) console.warn(`[perf] loadProjects: ${Math.round(_d)}ms`);
    if (!res.ok) {
      container.innerHTML = renderError(null, 'loadProjects()');
      return;
    }
    const projects = await res.json();
    _dashboardProjectsById = Object.fromEntries(projects.map((project) => [project.id, project]));
    populateActivityProjectFilter();
    populateInboxProjectFilter();
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
    // Use cached controller agent ID from project stats (avoids extra API call)
    const controllerId = _dashboardProjectsById[projectId]?.stats?.controllerAgentId;
    if (!controllerId) { showToast('No controller agent found', 'error'); return; }

    // Create issue assigned to controller
    const res = await fetch(`/api/projects/${projectId}/issues`, {
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

// ─── Inbox resizer drag logic ───
(function initMailResizer() {
  const resizer = document.getElementById('mail-resizer');
  const listPane = document.getElementById('mail-list-pane');
  const container = document.querySelector('.mail-container');
  if (!resizer || !listPane || !container) return;

  // Restore saved width from localStorage
  const savedWidth = localStorage.getItem('inbox-list-width');
  if (savedWidth) {
    const pct = parseFloat(savedWidth);
    if (pct >= 10 && pct <= 60) {
      listPane.style.width = pct + '%';
    }
  }

  let dragging = false;
  resizer.addEventListener('mousedown', function(e) {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.max(10, Math.min(60, pct));
    listPane.style.width = pct + '%';
  });
  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const pct = (listPane.offsetWidth / container.offsetWidth) * 100;
    localStorage.setItem('inbox-list-width', pct.toFixed(1));
  });
})();

// Polling with in-flight guards to prevent request piling
let _pollInFlight = false;
let _pollSlowInFlight = false;
setInterval(async () => {
  if (_pollInFlight) { console.warn('[perf] skipping poll cycle — previous still in-flight'); return; }
  _pollInFlight = true;
  try { await Promise.all([loadDashboardSummary(), loadNotifications(), loadActivityStream()]); }
  finally { _pollInFlight = false; }
}, 10000);
setInterval(async () => {
  if (_pollSlowInFlight) return;
  _pollSlowInFlight = true;
  try { await Promise.all([loadProjects(), loadAgentBoard()]); }
  finally { _pollSlowInFlight = false; }
}, 30000);
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
    const _t = performance.now();
    const filter = document.getElementById('activity-project-filter');
    const projectId = filter ? filter.value : '';
    const url = '/api/dashboard/activity-stream?limit=50' + (projectId ? '&project_id=' + projectId : '');
    const res = await fetch(url, { headers: apiHeaders() });
    const _d = performance.now() - _t; if (_d > 1000) console.warn(`[perf] loadActivityStream: ${Math.round(_d)}ms`);
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
          detail = '<a href="/agents/' + ev.object_id + '">' + esc(ev.agent_name) + '</a>';
          break;
        case 'agent_stopped':
          icon = '<span style="color:var(--text-secondary)">&#9632;</span>';
          label = 'Agent Stopped';
          detail = '<a href="/agents/' + ev.object_id + '">' + esc(ev.agent_name) + '</a>';
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
              '<a href="/agents/' + agent.id + '" style="font-weight:600;font-size:13px;color:var(--fg);text-decoration:none">' + esc(agent.name) + '</a>' +
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
// Debounced: coalesce rapid-fire WS events into a single refresh cycle
let _wsRefreshTimer = null;
function scheduleWSRefresh() {
  if (_wsRefreshTimer) return; // already scheduled
  _wsRefreshTimer = setTimeout(async () => {
    _wsRefreshTimer = null;
    if (_pollInFlight) return; // skip if polling is already running
    _pollInFlight = true;
    try {
      await Promise.all([loadDashboardSummary(), loadNotifications(), loadActivityStream(), loadProjects(), loadAgentBoard()]);
    } finally { _pollInFlight = false; }
  }, 2000); // 2s debounce
}
(async function setupDashboardWS() {
  try {
    const res = await fetch('/api/projects', { headers: apiHeaders() });
    if (!res.ok) return;
    const projects = await res.json();
    for (const p of projects) {
      const ev = connectProjectEvents(p.id);
      ev.on('*', scheduleWSRefresh);
    }
  } catch {}
})();
