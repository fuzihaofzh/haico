// Cache for last activity data from summary endpoint
let _lastActivityMap = {};
let _notificationsCollapsed = false;
let _notifFilter = 'all'; // 'all' or 'action'
let _inboxScope = 'user'; // 'user' (default: user-related only) or 'all'
let _inboxProject = ''; // '' = all projects, or a specific project_id
let _inboxSearchQuery = '';
let _inboxAllItems = []; // cached items for search filtering
let _inboxLastUpdatedAt = ''; // cursor for background incremental inbox refresh
let _inboxMobilePane = 'list';
let _selectedMailIdx = -1; // currently selected mail index
let _selectedMailIssueId = null; // currently selected issue ID (stable across re-renders)
let _renderedMailItems = []; // currently rendered (filtered) items
let _currentReplyIssueId = null; // issue ID for the currently visible reply box
let _dashboardProjectsById = {};
let _remoteInstances = [];
let _editingRemoteInstanceId = '';
let _globalComposeAgentsByProject = {};
let _dashboardProjectsLoadPromise = null;
let _createProjectReadiness = null;
let _createProjectReadinessRequestId = 0;
let _createProjectTargetOptions = [];
let _createProjectDirectoryRoots = [];
let _createProjectDirectoryRootId = '';
let _createProjectDirectoryRelativePath = '';
const INBOX_ITEM_LIMIT = 20;
let _inboxPagination = { limit: INBOX_ITEM_LIMIT, offset: 0, total: 0, hasMore: false, loading: false };
let _inboxUnreadCount = 0;
const DASHBOARD_NAV_VIEWS = new Set(['inbox', 'projects', 'usage', 'settings']);

function isRemoteProject(project) {
  return Boolean(project && project.is_remote);
}

function isRemoteInboxIssue(issue) {
  return Boolean(issue && issue.is_remote && issue.remote_instance_id);
}

function parseRemoteIssueCompositeId(value) {
  const match = /^remote-issue:([^:]+):(.+)$/.exec(String(value || ''));
  if (!match) return null;
  return {
    instanceId: match[1],
    remoteIssueId: match[2],
  };
}

function escapeJsString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getInboxIssueById(issueId) {
  return _renderedMailItems.find((item) => item.data && item.data.id === issueId)?.data
    || _inboxAllItems.find((item) => item.data && item.data.id === issueId)?.data
    || null;
}

function buildRemoteIssueApiPath(issue) {
  return issue?.id ? buildIssueApiPath(issue.id) : '';
}

function buildRemoteProjectAgentsApiPath(issue) {
  return issue?.project_id ? buildProjectApiPath(issue.project_id, '/agents') : '';
}

function syncNotifFilterButtons() {
  document.querySelectorAll('.notif-filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === _notifFilter);
  });
}

function syncInboxScopeButtons() {
  document.querySelectorAll('.inbox-scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scope === _inboxScope);
  });
}

function syncInboxProjectFilterControl() {
  const filter = document.getElementById('inbox-project-filter');
  if (filter) filter.value = _inboxProject || '';
}

function openProjectCard(projectId) {
  const project = _dashboardProjectsById[projectId];
  if (!project) return;
  window.location.href = buildProjectPageHref(project.id);
}

function getLocalDashboardProjects() {
  return Object.values(_dashboardProjectsById || {}).filter((project) => project && !isRemoteProject(project));
}

function normalizeDashboardView(view) {
  return DASHBOARD_NAV_VIEWS.has(view) ? view : 'inbox';
}

function getInitialDashboardView() {
  const params = new URLSearchParams(window.location.search);
  return normalizeDashboardView(params.get('view'));
}

let _dashboardView = getInitialDashboardView();

async function ensureDashboardProjectsLoaded() {
  if (Object.keys(_dashboardProjectsById || {}).length > 0) {
    return Object.values(_dashboardProjectsById);
  }
  await loadProjects();
  return Object.values(_dashboardProjectsById || {});
}

function setSidebarActive(view) {
  document.querySelectorAll('.sidebar-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sidebarView === view);
  });
}

function isMobileInboxViewport() {
  return window.innerWidth <= MOBILE_INBOX_BREAKPOINT;
}

function getInboxNotificationsPanel() {
  return document.getElementById('notifications-panel');
}

function getMailDetailContent() {
  return document.getElementById('mail-detail-content') || document.getElementById('mail-detail-pane');
}

function syncInboxMobilePane() {
  const panel = getInboxNotificationsPanel();
  if (!panel) return;
  if (_dashboardView !== 'inbox' || !isMobileInboxViewport()) {
    delete panel.dataset.mobilePane;
    return;
  }
  panel.dataset.mobilePane = _inboxMobilePane;
}

function setInboxMobilePane(pane) {
  _inboxMobilePane = pane === 'detail' ? 'detail' : 'list';
  syncInboxMobilePane();
}

function showInboxListPane() {
  setInboxMobilePane('list');
}

function applyDashboardViewState(view) {
  setSidebarActive(view);
  document.body.dataset.dashboardView = view;
  syncInboxMobilePane();
}

function updateDashboardViewUrl(view) {
  const url = new URL(window.location.href);
  url.searchParams.set('view', view);
  window.history.replaceState({}, '', url);
}

function switchView(view) {
  const nextView = normalizeDashboardView(view);

  _dashboardView = nextView;
  applyDashboardViewState(nextView);
  updateDashboardViewUrl(nextView);
  if (typeof closeDrawer === 'function') closeDrawer();
  loadDashboard(nextView);
}

if (typeof window !== 'undefined') {
  window.switchView = switchView;
  window.showInboxListPane = showInboxListPane;
  window.addEventListener('resize', syncInboxMobilePane);
}

// Inbox issue detail caches
const _issueDetailCache = {}; // issueId -> { data, timestamp }
const _projectAgentsCache = {}; // projectId -> { data, timestamp }
const ISSUE_CACHE_TTL = 30000; // 30s - background refresh after this
const MOBILE_INBOX_BREAKPOINT = 768;

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
  } catch (e) {
    console.error('Failed to load dashboard summary', e);
  }
}

function updateInboxBadge(count) {
  _inboxUnreadCount = Math.max(0, count || 0);
  const badge = document.getElementById('notif-count');
  if (!badge) return;
  if (_inboxUnreadCount > 0) {
    const prevCount = parseInt(badge.textContent, 10) || 0;
    badge.textContent = _inboxUnreadCount;
    badge.style.display = '';
    if (_inboxUnreadCount > prevCount) {
      badge.classList.remove('pulse');
      void badge.offsetWidth;
      badge.classList.add('pulse');
    }
  } else {
    badge.style.display = 'none';
  }
}

function resetInboxPagination() {
  _inboxPagination = { limit: INBOX_ITEM_LIMIT, offset: 0, total: 0, hasMore: false, loading: false };
  _inboxAllItems = [];
  _inboxLastUpdatedAt = '';
}

async function loadNotifications(options) {
  const opts = options || {};
  const append = opts.append === true;
  if (_inboxPagination.loading) return;
  if (opts.reset) resetInboxPagination();

  try {
    _inboxPagination.loading = true;
    if (append) renderInboxItems(_inboxAllItems);

    const incremental = !append && !opts.reset && opts.incremental !== false && _inboxAllItems.length > 0 && !!_inboxLastUpdatedAt && !_inboxSearchQuery.trim() && _notifFilter !== 'my';
    const desiredCount = incremental
      ? INBOX_ITEM_LIMIT
      : (append ? _inboxAllItems.length + INBOX_ITEM_LIMIT : Math.max(INBOX_ITEM_LIMIT, _inboxAllItems.length || 0));
    const params = new URLSearchParams();
    params.set('scope', _inboxScope);
    params.set('limit', String(desiredCount));
    params.set('offset', '0');
    if (_inboxProject) params.set('project_id', _inboxProject);
    if (incremental) params.set('since_updated_at', _inboxLastUpdatedAt);

    const [localRes, remoteRes] = await Promise.all([
      fetch('/api/notifications?' + params.toString(), { headers: apiHeaders() }),
      fetch('/api/remote-notifications?' + params.toString(), { headers: apiHeaders() }).catch(() => null),
    ]);
    if (!localRes.ok) return;

    const localData = await localRes.json().catch(() => ({}));
    const remoteData = remoteRes && remoteRes.ok ? await remoteRes.json().catch(() => ({})) : {};
    const data = {
      user_issues: []
        .concat(Array.isArray(localData.user_issues) ? localData.user_issues : [])
        .concat(Array.isArray(remoteData.user_issues) ? remoteData.user_issues : []),
      recent_comments: []
        .concat(Array.isArray(localData.recent_comments) ? localData.recent_comments : [])
        .concat(Array.isArray(remoteData.recent_comments) ? remoteData.recent_comments : []),
      removed_issue_ids: []
        .concat(Array.isArray(localData.removed_issue_ids) ? localData.removed_issue_ids : [])
        .concat(Array.isArray(remoteData.removed_issue_ids) ? remoteData.removed_issue_ids : []),
      unread_count: Number(localData.unread_count || 0) + Number(remoteData.unread_count || 0),
      pagination: {
        limit: desiredCount,
        offset: incremental ? 0 : 0,
        total: Number(localData.pagination?.total || localData.user_issues?.length || 0)
          + Number(remoteData.pagination?.total || remoteData.user_issues?.length || 0),
      },
    };

    const issues = data.user_issues || [];
    const comments = (data.recent_comments || []).slice(0, 50);
    // Only count actionable (assigned_to=user) + unacknowledged issues for badge/notifications
    const actionableUnacknowledged = issues.filter(i => i.is_actionable && !i.acknowledged_at);
    const totalCount = typeof data.unread_count === 'number' ? data.unread_count : actionableUnacknowledged.length;

    // Always show the Inbox panel
    document.getElementById('notifications-panel').style.display = '';
    updateInboxBadge(totalCount);

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
    sortInboxItems(items);

    // Invalidate issue caches for issues whose updated_at changed
    for (const issue of issues) {
      const cached = _issueDetailCache[issue.id];
      if (cached && cached.data.updated_at !== issue.updated_at) {
        delete _issueDetailCache[issue.id];
      }
    }

    if (incremental) {
      const removedIds = new Set(data.removed_issue_ids || []);
      const byId = new Map();
      for (const existing of _inboxAllItems) {
        const id = existing.data && existing.data.id;
        if (id && !removedIds.has(id)) byId.set(id, existing);
      }
      for (const item of items) {
        const id = item.data && item.data.id;
        if (id) byId.set(id, item);
      }
      _inboxAllItems = sortInboxItems(Array.from(byId.values()));
    } else if (append) {
      const existingIds = new Set(_inboxAllItems.map(i => i.data && i.data.id).filter(Boolean));
      _inboxAllItems = sortInboxItems(_inboxAllItems.concat(items.filter(i => i.data && !existingIds.has(i.data.id)))).slice(0, desiredCount);
    } else {
      _inboxAllItems = items.slice(0, desiredCount);
    }

    const maxUpdatedAt = _inboxAllItems.reduce((max, item) => {
      const updatedAt = item.data && item.data.updated_at;
      return updatedAt && updatedAt > max ? updatedAt : max;
    }, _inboxLastUpdatedAt || '');
    if (maxUpdatedAt) _inboxLastUpdatedAt = maxUpdatedAt;

    // Detect new action-required issues after incremental merge, using the full loaded list.
    const currentIds = new Set(_inboxAllItems.filter(i => i.actionRequired && i.data).map(i => i.data.id || i.data.number));
    if (!append) {
      if (_knownActionIssueIds === null) {
        _knownActionIssueIds = currentIds;
      } else {
        const newItems = [];
        for (const id of currentIds) {
          if (!_knownActionIssueIds.has(id)) {
            const item = _inboxAllItems.find(i => i.data && (i.data.id || i.data.number) === id);
            if (item && item.data) newItems.push(item.data);
          }
        }
        _knownActionIssueIds = currentIds;
        if (newItems.length > 0) {
          if (typeof playNotificationSound === 'function') {
            playNotificationSound();
          }
          showBrowserNotification(newItems);
        }
      }
    }

    const page = data.pagination || {};
    const total = Number.isFinite(Number(page.total)) ? Number(page.total) : _inboxAllItems.length;
    _inboxPagination = {
      limit: page.limit || desiredCount,
      offset: _inboxAllItems.length,
      total,
      hasMore: _inboxAllItems.length < total,
      loading: false,
    };

    if (!_inboxSearchQuery.trim() && _notifFilter !== 'my') {
      renderInboxItems(_inboxAllItems);
    }
  } catch (e) {
    console.error('Failed to load notifications', e);
  } finally {
    _inboxPagination.loading = false;
  }
}

function sortInboxItems(items) {
  return items.sort((a, b) => {
    if (a.actionRequired !== b.actionRequired) return a.actionRequired ? -1 : 1;
    return (b.time || '') > (a.time || '') ? 1 : -1;
  });
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
  const visibleItems = filtered;
  _renderedMailItems = visibleItems;

  // Re-map _selectedMailIdx to follow the selected issue across re-sorts
  if (_selectedMailIssueId) {
    const newIdx = visibleItems.findIndex(function(i) { return i.data && i.data.id === _selectedMailIssueId; });
    if (newIdx >= 0) {
      _selectedMailIdx = newIdx;
    } else {
      _selectedMailIdx = -1;
      _selectedMailIssueId = null;
      _currentReplyIssueId = null;
      const detail = getMailDetailContent();
      if (detail) detail.innerHTML = renderMailDetailEmpty();
      setInboxMobilePane('list');
    }
  }

  let html = '';
  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const isSelected = _selectedMailIssueId ? (item.data && item.data.id === _selectedMailIssueId) : (i === _selectedMailIdx);
    const issue = item.data;
    const isUnread = item.actionRequired;
    const project = esc(issue.project_name || '');
    const previewText = (issue.latest_comment_body || item.latestPreview || issue.body || '').replace(/\n/g, ' ').slice(0, 100) + ((issue.latest_comment_body || item.latestPreview || issue.body || '').length > 100 ? '…' : '');
    const displayTime = item.time || issue.updated_at;
    // Avatar: show role-based avatar for latest comment author (sender), fallback to assigned agent
    const senderAuthorId = issue.latest_comment_author_id;
    const senderName = issue.latest_comment_author_name;
    const projColor = issue.project_color || '#4A90E2';
    let avatarHtml;
    if (senderName && senderAuthorId !== 'user') {
      // Agent comment author with known name
      avatarHtml = roleAvatarHtml(senderName, 32, projColor);
    } else if (issue.assigned_agent_name && (!senderAuthorId || senderAuthorId === 'user')) {
      // No comment or user comment — show assigned agent's letter avatar
      avatarHtml = roleAvatarHtml(issue.assigned_agent_name, 32, projColor);
    } else {
      avatarHtml = avatarSvg(senderAuthorId === 'user' || !senderAuthorId ? 'user' : (senderName || senderAuthorId || '?'), 32);
    }
    html += `<div class="mail-item${isUnread ? ' mail-unread' : ''}${isSelected ? ' mail-selected' : ''}" onclick="selectMailItem(${i})" onmouseenter="prefetchIssueDetail('${issue.id}')" data-idx="${i}">
      <span class="mail-item-dot ${isUnread ? 'unread' : 'read'}"></span>
      <div class="mail-item-avatar">${avatarHtml}</div>
      <div class="mail-item-content">
        <div class="mail-item-top">
          <span class="mail-item-from">${project} #${issue.number}</span>
          <span class="mail-item-time">${timeAgo(displayTime) || ''}</span>
        </div>
        <div class="mail-item-subject">${isUnread ? '<span class="mail-item-badge action">!</span>' : (!issue.is_actionable ? '<span class="mail-item-badge sent">Sent</span>' : '')}${esc(issue.title)}</div>
        <div class="mail-item-preview">${esc(previewText)}</div>
      </div>
    </div>`;
  }

  if (!html && query) {
    html = '<div style="padding:20px;color:var(--text-secondary);font-size:12px;text-align:center">No results</div>';
  } else if (!html) {
    html = '<div style="padding:20px;color:var(--text-secondary);font-size:12px;text-align:center">No notifications</div>';
  }

  if (!query && _notifFilter !== 'my' && (_inboxPagination.hasMore || _inboxPagination.loading)) {
    const loaded = Math.min(_inboxAllItems.length, _inboxPagination.total || _inboxAllItems.length);
    const total = _inboxPagination.total || loaded;
    html += `<div class="mail-list-footer">
      <button class="btn btn-sm" onclick="loadMoreInbox()" ${_inboxPagination.loading ? 'disabled' : ''}>
        ${_inboxPagination.loading ? 'Loading...' : 'Load more'}
      </button>
      <span>${loaded} / ${total}</span>
    </div>`;
  }

  body.innerHTML = html;

  // Collapse state
  const mailBody = document.getElementById('mail-body');
  if (mailBody && _notificationsCollapsed) {
    mailBody.classList.add('collapsed');
  }
}

function loadMoreInbox() {
  if (_inboxSearchQuery.trim() || _notifFilter === 'my' || !_inboxPagination.hasMore || _inboxPagination.loading) return;
  loadNotifications({ append: true });
}

function selectMailItem(idx) {
  _selectedMailIdx = idx;
  // Highlight selected in list
  document.querySelectorAll('.mail-item').forEach((el, i) => {
    el.classList.toggle('mail-selected', i === idx);
  });

  const item = _renderedMailItems[idx];
  const detail = getMailDetailContent();
  _currentReplyIssueId = null;
  if (!item) {
    _selectedMailIssueId = null;
    detail.innerHTML = renderMailDetailEmpty();
    setInboxMobilePane('list');
    return;
  }

  const issue = item.data;
  _selectedMailIssueId = issue.id;
  // Mark as read (acknowledge)
  if (item.actionRequired && !_acknowledgedIds.has(issue.id)) {
    acknowledgeIssue(issue);
  }
  _currentReplyIssueId = issue.id;
  detail.innerHTML = '<div style="padding:20px;color:var(--text-secondary);font-size:12px;">Loading issue...</div>';
  setInboxMobilePane('detail');
  loadInboxIssueDetail(issue.id, idx);
}

async function loadRemoteInboxIssueDetail(issueId, expectedIdx, forceRefresh) {
  const detail = getMailDetailContent();
  const now = Date.now();
  const cached = _issueDetailCache[issueId];

  function isStale() { return _selectedMailIssueId !== issueId; }
  function getProjectColor() {
    var item = _renderedMailItems.find(function(i) { return i.data && i.data.id === issueId; });
    return (item && item.data && item.data.project_color) || null;
  }

  const inboxItem = _renderedMailItems[expectedIdx];
  const remoteIssue = inboxItem && inboxItem.data;
  if (!remoteIssue || !isRemoteInboxIssue(remoteIssue)) {
    if (detail) detail.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">Remote issue not found</div>';
    return;
  }

  if (cached && !forceRefresh) {
    if (isStale()) return;
    const agentsCached = _projectAgentsCache[cached.data.project_id];
    const agents = agentsCached ? agentsCached.data : [];
    _currentReplyIssueId = cached.data.id;
    setInboxMobilePane('detail');
    IssueRenderer.render(cached.data, agents, detail, {
      reload: function() { loadRemoteInboxIssueDetail(issueId, _selectedMailIdx, true); },
      onAfterAction: function() { loadNotifications(); },
      refreshComments: function(seedComment) { refreshInboxIssueComments(issueId, seedComment); },
      projectColor: getProjectColor(),
    });
    if (now - cached.timestamp > ISSUE_CACHE_TTL) {
      loadRemoteInboxIssueDetail(issueId, expectedIdx, true);
    }
    return;
  }

  try {
    const issuePath = buildRemoteIssueApiPath(remoteIssue);
    const agentsPath = buildRemoteProjectAgentsApiPath(remoteIssue);
    const [issueRes, agentsRes] = await Promise.all([
      fetch(issuePath, { headers: apiHeaders() }),
      agentsPath ? fetch(agentsPath, { headers: apiHeaders() }) : Promise.resolve(null),
    ]);
    if (!issueRes.ok || isStale()) return;

    const issue = await issueRes.json();
    _issueDetailCache[issueId] = { data: issue, timestamp: now };

    let agents = [];
    if (agentsRes && agentsRes.ok) {
      agents = await agentsRes.json();
      _projectAgentsCache[issue.project_id] = { data: agents, timestamp: now };
    } else {
      const agentsCached = _projectAgentsCache[issue.project_id];
      if (agentsCached) agents = agentsCached.data;
    }

    if (isStale()) return;
    _currentReplyIssueId = issue.id;
    setInboxMobilePane('detail');
    IssueRenderer.render(issue, agents, detail, {
      reload: function() { loadRemoteInboxIssueDetail(issueId, _selectedMailIdx, true); },
      onAfterAction: function() { loadNotifications(); },
      refreshComments: function(seedComment) { refreshInboxIssueComments(issueId, seedComment); },
      projectColor: getProjectColor(),
    });
  } catch (e) {
    if (isStale()) return;
    detail.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">Failed to load remote issue</div>';
  }
}

async function loadInboxIssueDetail(issueId, expectedIdx, forceRefresh) {
  const inboxItem = _renderedMailItems[expectedIdx];
  if (inboxItem?.data && isRemoteInboxIssue(inboxItem.data)) {
    return loadRemoteInboxIssueDetail(issueId, expectedIdx, forceRefresh);
  }

  const detail = getMailDetailContent();
  const now = Date.now();
  const cached = _issueDetailCache[issueId];

  // Use issue ID for stale checks — immune to index shifts from re-sorting
  function isStale() { return _selectedMailIssueId !== issueId; }

  // Helper: find project color from current inbox items for this issue
  function getProjectColor() {
    var item = _renderedMailItems.find(function(i) { return i.data && i.data.id === issueId; });
    return (item && item.data && item.data.project_color) || null;
  }

  // Show cached data instantly if available
  if (cached && !forceRefresh) {
    if (isStale()) return;
    const agentsCached = _projectAgentsCache[cached.data.project_id];
    const agents = agentsCached ? agentsCached.data : [];
    _currentReplyIssueId = cached.data.id;
    setInboxMobilePane('detail');
    IssueRenderer.render(cached.data, agents, detail, {
      reload: function() { loadInboxIssueDetail(issueId, _selectedMailIdx, true); },
      onAfterAction: function() { loadNotifications(); },
      refreshComments: function(seedComment) { refreshInboxIssueComments(issueId, seedComment); },
      projectColor: getProjectColor(),
    });

    // Background refresh if cache is stale
    if (now - cached.timestamp > ISSUE_CACHE_TTL) {
      loadInboxIssueDetail(issueId, expectedIdx, true);
    }
    return;
  }

  // Determine project_id from inbox item data for parallel agents fetch
  let knownProjectId = null;
  if (inboxItem && inboxItem.data) {
    knownProjectId = inboxItem.data.project_id;
  }

  try {
    // Fetch issue and agents in parallel when project_id is known
    const issuePromise = fetch(buildIssueApiPath(issueId), { headers: apiHeaders() });
    let agentsPromise = null;
    if (knownProjectId) {
      const agentsCached = _projectAgentsCache[knownProjectId];
      if (!agentsCached || now - agentsCached.timestamp >= 60000) {
        agentsPromise = fetch(buildProjectApiPath(knownProjectId, '/agents'), { headers: apiHeaders() });
      }
    }

    const [issueRes, agentsRes] = await Promise.all([
      issuePromise,
      agentsPromise || Promise.resolve(null),
    ]);

    if (!issueRes.ok || isStale()) return;
    const issue = await issueRes.json();

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
          const res2 = await fetch(buildProjectApiPath(issue.project_id, '/agents'), { headers: apiHeaders() });
          if (res2.ok) {
            agents = await res2.json();
            _projectAgentsCache[issue.project_id] = { data: agents, timestamp: now };
          }
        } catch {}
      }
    }

    if (isStale()) return;
    _currentReplyIssueId = issue.id;
    setInboxMobilePane('detail');
    IssueRenderer.render(issue, agents, detail, {
      reload: function() { loadInboxIssueDetail(issueId, _selectedMailIdx, true); },
      onAfterAction: function() { loadNotifications(); },
      refreshComments: function(seedComment) { refreshInboxIssueComments(issueId, seedComment); },
      projectColor: getProjectColor(),
    });
  } catch (e) {
    if (isStale()) return;
    detail.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">Failed to load issue</div>';
  }
}

function mergeIssueComments(issue, comments) {
  if (!issue || !Array.isArray(comments) || comments.length === 0) return false;
  const byId = new Map((issue.comments || []).map(function(comment) { return [comment.id, comment]; }));
  let changed = false;
  for (const comment of comments) {
    if (!comment || !comment.id) continue;
    if (!byId.has(comment.id)) changed = true;
    byId.set(comment.id, Object.assign({ reactions: [] }, comment));
  }
  if (!changed) return false;
  issue.comments = Array.from(byId.values()).sort(function(a, b) {
    return (a.created_at || '') > (b.created_at || '') ? 1 : -1;
  });
  return true;
}

function getIssueLastCommentCreatedAt(issue) {
  return (issue && issue.comments || []).reduce(function(max, comment) {
    const createdAt = comment && comment.created_at;
    return createdAt && createdAt > max ? createdAt : max;
  }, '');
}

async function refreshInboxIssueComments(issueId, seedComment) {
  const cached = _issueDetailCache[issueId];
  if (!cached || !cached.data) {
    return loadInboxIssueDetail(issueId, _selectedMailIdx, true);
  }
  let changed = mergeIssueComments(cached.data, seedComment ? [seedComment] : []);
  const sinceCreatedAt = getIssueLastCommentCreatedAt(cached.data);
  try {
    const params = new URLSearchParams();
    if (sinceCreatedAt) params.set('since_created_at', sinceCreatedAt);
    const commentsPath = buildIssueApiPath(issueId, '/comments');
    if (!commentsPath) throw new Error('Missing issue comments path');
    const res = await fetch(`${commentsPath}${params.toString() ? `?${params.toString()}` : ''}`, { headers: apiHeaders() });
    if (res.ok) {
      const comments = await res.json();
      changed = mergeIssueComments(cached.data, comments) || changed;
    }
  } catch (e) {
    console.error('Failed to refresh inbox issue comments', e);
  }
  if (!changed || _selectedMailIssueId !== issueId) return;
  cached.timestamp = Date.now();
  const agentsCached = _projectAgentsCache[cached.data.project_id];
  IssueRenderer.render(cached.data, agentsCached ? agentsCached.data : [], getMailDetailContent(), {
    reload: function() { loadInboxIssueDetail(issueId, _selectedMailIdx, true); },
    onAfterAction: function() { loadNotifications(); },
    refreshComments: function(nextSeedComment) { refreshInboxIssueComments(issueId, nextSeedComment); },
    projectColor: (cached.data && cached.data.project_color) || null,
  });
}

// Prefetch issue detail on hover for faster click response
function prefetchIssueDetail(issueId) {
  if (_issueDetailCache[issueId]) return;
  const issue = getInboxIssueById(issueId);
  const prefetchUrl = buildIssueApiPath(issueId);
  if (!prefetchUrl) return;
  fetch(prefetchUrl, { headers: apiHeaders() })
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
    const remoteItems = _inboxAllItems.filter((item) =>
      item.data
      && isRemoteInboxIssue(item.data)
      && matchesSearch(query, '#' + item.data.number, item.data.title, item.data.body || '')
    );
    const seenIds = new Set(items.map((item) => item.data && item.data.id));
    remoteItems.forEach((item) => {
      if (item.data && !seenIds.has(item.data.id)) items.push(item);
    });
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
  syncNotifFilterButtons();
  if (filter === 'my') {
    loadMyIssues();
  } else if (_inboxSearchQuery.trim()) {
    searchInboxIssues(_inboxSearchQuery.trim());
  } else {
    if (filter === 'all' || filter === 'action') loadNotifications({ reset: true });
    else renderInboxItems(_inboxAllItems);
  }
}

function toggleInboxScope(scope) {
  _inboxScope = scope;
  syncInboxScopeButtons();
  // Reload notifications with new scope
  loadNotifications({ reset: true });
}

function toggleInboxProject(projectId) {
  _inboxProject = projectId;
  syncInboxProjectFilterControl();
  if (_notifFilter === 'my') {
    loadMyIssues();
  } else if (_inboxSearchQuery.trim()) {
    searchInboxIssues(_inboxSearchQuery.trim());
  } else {
    loadNotifications({ reset: true });
  }
}

function populateInboxProjectFilter() {
  const filter = document.getElementById('inbox-project-filter');
  if (!filter) return;
  const current = _inboxProject || filter.value;
  let options = '<option value="">All Projects</option>';
  const projects = Object.values(_dashboardProjectsById || {})
    .filter((project) => project)
    .sort((a, b) => {
      if (isRemoteProject(a) !== isRemoteProject(b)) return isRemoteProject(a) ? 1 : -1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  for (const p of projects) {
    const id = p.id;
    const label = isRemoteProject(p)
      ? `${p.name} · ${p.remote_instance_name || p.remote_base_url || 'Remote'}`
      : p.name;
    options += '<option value="' + id + '"' + (id === current ? ' selected' : '') + '>' + esc(label) + '</option>';
  }
  filter.innerHTML = options;
  filter.value = current || '';
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

async function acknowledgeIssue(issueOrId) {
  const issue = typeof issueOrId === 'string' ? getInboxIssueById(issueOrId) : issueOrId;
  const issueId = issue?.id || String(issueOrId || '');
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
  updateInboxBadge(_inboxUnreadCount - 1);
  try {
    const ackUrl = buildIssueApiPath(issueId, '/acknowledge');
    const res = await fetch(ackUrl, { method: 'POST' });
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
  if (_dashboardProjectsLoadPromise) return _dashboardProjectsLoadPromise;

  const container = document.getElementById('projects');
  _dashboardProjectsLoadPromise = (async () => {
    try {
      const [localRes, remoteRes] = await Promise.all([
        fetch('/api/projects?with_stats=1', { headers: apiHeaders() }),
        fetch('/api/remote-projects', { headers: apiHeaders() }).catch(() => null),
      ]);
      if (!localRes.ok) {
        container.innerHTML = renderError(null, 'loadProjects()');
        return;
      }
      const localProjects = await localRes.json();
      const remotePayload = remoteRes && remoteRes.ok ? await remoteRes.json().catch(() => ({ projects: [] })) : { projects: [] };
      const remoteProjects = Array.isArray(remotePayload.projects) ? remotePayload.projects : [];
      const projects = localProjects.concat(remoteProjects);
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
      const remote = isRemoteProject(p);
      const link = buildProjectPageHref(p.id);
      const openAction = `openProjectCard('${escapeJsString(p.id)}')`;
        const access = remote
          ? { badge: 'REMOTE', tone: 'remote', summary: 'Remote instance', detail: `Connected via ${p.remote_instance_name || p.remote_base_url || 'remote instance'}` }
          : getProjectAccessMeta(p);
        const ownerName = remote ? (p.remote_instance_name || 'Remote instance') : displayProjectUser(p.owner);
        const ownerRole = remote ? 'Remote HAICO' : (p.owner?.role === 'admin' ? 'Global Admin' : 'Project Member');
        const memberCount = Number.isFinite(p.member_count) ? p.member_count : 0;
        const toggleButton = !remote && p.can_manage
          ? `<button onclick="event.stopPropagation();toggleProjectStatus('${p.id}','${p.status}')" title="${p.status === 'active' ? 'Pause' : 'Resume'}" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:14px;padding:2px 6px;line-height:1">${p.status === 'active' ? '⏸' : '▶'}</button>`
          : '';
        const userCount = remote ? 0 : (s.userIssues?.length || 0);
        const notifBadge = userCount > 0
          ? `<span onclick="event.stopPropagation();window.location='${link}#issues'" style="background:var(--error);color:#fff;font-size:11px;padding:1px 8px;border-radius:10px;cursor:pointer;margin-left:6px" title="${userCount} issue(s) need your attention">${userCount}</span>`
          : '';
        const lastAct = remote ? p.updated_at : _lastActivityMap[p.id];
        const activityText = lastAct ? timeAgo(lastAct) : null;
        const activityLine = activityText
          ? `<div class="last-activity">Last activity: ${activityText}</div>`
          : '';
        const remoteSource = remote
          ? `<div class="project-card-source">Source: ${esc(p.remote_instance_name || p.remote_base_url || 'Remote instance')}</div>`
          : '';
        const quickCmdBar = !remote && p.can_manage ? `
          <div class="quick-cmd-bar" onclick="event.stopPropagation()">
            <div class="quick-cmd-row">
              <input type="text" class="quick-cmd-input" id="quick-cmd-${p.id}" placeholder="Quick command..." oninput="toggleQuickCmdBody('${p.id}')" onkeydown="if(event.key==='Enter'&&event.shiftKey&&!event.isComposing){event.preventDefault();sendQuickCmd('${p.id}')}">
              <button class="quick-cmd-btn" onclick="sendQuickCmd('${p.id}')" title="Send">&#9654;</button>
            </div>
            <textarea class="quick-cmd-body" id="quick-cmd-body-${p.id}" placeholder="Details (optional)..." rows="3" data-collapsed></textarea>
          </div>
        ` : (remote
          ? `<div class="project-card-note"><span>Open this card to view the remote project locally. Terminal and file editing still stay on that machine.</span></div>`
          : '');
        return `
        <div class="card project-card" style="cursor:pointer" onclick="${openAction}">
          <div class="project-card-head">
            <div class="project-card-main">
              <strong class="project-card-title">${esc(p.name)}${notifBadge}</strong>
              ${remoteSource}
              <div class="project-card-tags">
                <span class="permission-badge permission-${access.tone}" title="${esc(access.summary)}">${access.badge}</span>
                <span class="meta-chip" title="Project owner">
                  <span class="meta-chip-label">Owner</span>
                  <span>${esc(ownerName)}</span>
                </span>
                ${remote ? `<span class="meta-chip meta-chip-remote" title="Remote instance URL">${esc(p.remote_base_url || '')}</span>` : ''}
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
    } finally {
      _dashboardProjectsLoadPromise = null;
    }
  })();

  return _dashboardProjectsLoadPromise;
}

function getGlobalComposeProjects() {
  return Object.values(_dashboardProjectsById || {}).filter((project) => project && project.can_manage);
}

async function ensureGlobalComposeProjects() {
  const projects = await ensureDashboardProjectsLoaded();
  if (!projects.length) {
    throw new Error('Failed to load projects');
  }
  return getGlobalComposeProjects();
}

function setGlobalComposeStatus(message, type) {
  const status = document.getElementById('global-compose-status');
  if (!status) return;
  status.textContent = message || '';
  status.className = 'compose-status' + (type ? ' compose-status-' + type : '');
}

function renderMailDetailEmpty() {
  return '<div class="mail-detail-empty"><div class="mail-detail-empty-icon">&#9993;</div><div>Select a message to read</div></div>';
}

function renderInlineComposePane() {
  return `<div class="compose-pane">
    <div class="compose-header">
      <h3>Compose</h3>
      <button class="compose-close" type="button" onclick="closeInlineCompose()">&times;</button>
    </div>
    <div class="compose-form">
      <div class="compose-field">
        <label>Project</label>
        <select id="global-compose-project" onchange="updateGlobalComposeRecipients()">
          <option value="">Loading projects...</option>
        </select>
      </div>
      <div class="compose-field">
        <label>To</label>
        <select id="global-compose-to">
          <option value="">Select a project first</option>
        </select>
      </div>
      <div class="compose-field compose-subject-field">
        <label>Subject</label>
        <input type="text" id="global-compose-subject" placeholder="Subject">
      </div>
      <div class="compose-field compose-body-field">
        <label>Message</label>
        <textarea id="global-compose-body" rows="10" placeholder="Write a message..."></textarea>
      </div>
      <div class="compose-status" id="global-compose-status"></div>
    </div>
    <div class="compose-actions">
      <button class="btn" onclick="closeInlineCompose()">Cancel</button>
      <button class="btn btn-primary" id="global-compose-send" onclick="sendGlobalCompose()">Send</button>
    </div>
  </div>`;
}

function closeInlineCompose() {
  const detail = getMailDetailContent();
  if (!detail) return;
  _selectedMailIdx = -1;
  _selectedMailIssueId = null;
  _currentReplyIssueId = null;
  document.querySelectorAll('.mail-item').forEach((el) => el.classList.remove('mail-selected'));
  detail.innerHTML = renderMailDetailEmpty();
  setInboxMobilePane('list');
}

async function openGlobalCompose(defaults) {
  const opts = defaults || {};
  const detail = getMailDetailContent();
  const mailBody = document.getElementById('mail-body');
  if (!detail) return;

  _selectedMailIdx = -1;
  _selectedMailIssueId = null;
  _currentReplyIssueId = null;
  document.querySelectorAll('.mail-item').forEach((el) => el.classList.remove('mail-selected'));
  if (mailBody && _notificationsCollapsed) {
    _notificationsCollapsed = false;
    mailBody.classList.remove('collapsed');
  }
  detail.innerHTML = renderInlineComposePane();
  setInboxMobilePane('detail');

  const projectSelect = document.getElementById('global-compose-project');
  const toSelect = document.getElementById('global-compose-to');
  const subjectInput = document.getElementById('global-compose-subject');
  const bodyInput = document.getElementById('global-compose-body');
  const sendButton = document.getElementById('global-compose-send');
  if (!projectSelect || !toSelect || !subjectInput || !bodyInput) return;

  subjectInput.value = opts.subject || '';
  bodyInput.value = opts.body || '';
  projectSelect.innerHTML = '<option value="">Loading projects...</option>';
  projectSelect.disabled = true;
  toSelect.innerHTML = '<option value="">Select a project first</option>';
  toSelect.disabled = true;
  if (sendButton) sendButton.disabled = true;
  setGlobalComposeStatus('', '');

  try {
    const projects = await ensureGlobalComposeProjects();
    if (!projects.length) {
      projectSelect.innerHTML = '<option value="">No writable projects</option>';
      setGlobalComposeStatus('You need editor or owner access to a project before composing.', 'error');
      return;
    }

    const preferredProjectId = opts.projectId || _inboxProject;
    const selectedProject = preferredProjectId
      ? projects.find((project) => project.id === preferredProjectId) || null
      : null;
    projectSelect.innerHTML = '<option value="">— Select a project —</option>' + projects.map((project) =>
      `<option value="${esc(project.id)}">${esc(project.name)}</option>`
    ).join('');
    projectSelect.value = selectedProject?.id || '';
    projectSelect.disabled = false;
    const recipientsLoaded = await updateGlobalComposeRecipients(opts.assignedTo);
    if (sendButton) sendButton.disabled = !recipientsLoaded;
    if (selectedProject) subjectInput.focus();
    else projectSelect.focus();
  } catch (e) {
    projectSelect.innerHTML = '<option value="">Failed to load projects</option>';
    setGlobalComposeStatus(e.message || 'Failed to load compose data', 'error');
  }
}

async function updateGlobalComposeRecipients(selectedTo) {
  const projectSelect = document.getElementById('global-compose-project');
  const toSelect = document.getElementById('global-compose-to');
  const sendButton = document.getElementById('global-compose-send');
  if (!projectSelect || !toSelect) return;

  const selectedProjectId = projectSelect.value;
  if (!selectedProjectId) {
    toSelect.innerHTML = '<option value="">Select a project first</option>';
    toSelect.disabled = true;
    if (sendButton) sendButton.disabled = true;
    return false;
  }

  toSelect.innerHTML = '<option value="">Loading recipients...</option>';
  toSelect.disabled = true;
  if (sendButton) sendButton.disabled = true;
  setGlobalComposeStatus('', '');

  try {
    let agents = _globalComposeAgentsByProject[selectedProjectId];
    if (!agents) {
      const res = await fetch(buildProjectApiPath(selectedProjectId, '/agents'), { headers: apiHeaders() });
      if (!res.ok) throw new Error('Failed to load recipients');
      agents = await res.json();
      _globalComposeAgentsByProject[selectedProjectId] = agents;
    }

    const controllerId = agents.find((agent) => agent.is_controller)?.id
      || _dashboardProjectsById[selectedProjectId]?.stats?.controllerAgentId
      || '';
    const selectedValue = selectedTo !== undefined ? selectedTo : controllerId;
    toSelect.innerHTML = '<option value="">Select a recipient</option><option value="all">All (broadcast)</option><option value="user">User (me)</option>' +
      agents.map((agent) =>
        `<option value="${esc(agent.id)}">${esc(agent.name)}${agent.is_controller ? ' [controller]' : ''}</option>`
      ).join('');
    toSelect.value = selectedValue || '';
    toSelect.disabled = false;
    if (sendButton) sendButton.disabled = false;
    return true;
  } catch (e) {
    toSelect.innerHTML = '<option value="">Failed to load recipients</option>';
    setGlobalComposeStatus(e.message || 'Failed to load recipients', 'error');
    return false;
  }
}

async function sendGlobalCompose() {
  const projectSelect = document.getElementById('global-compose-project');
  const toSelect = document.getElementById('global-compose-to');
  const subjectInput = document.getElementById('global-compose-subject');
  const bodyInput = document.getElementById('global-compose-body');
  const btn = document.getElementById('global-compose-send');
  if (!projectSelect || !toSelect || !subjectInput || !bodyInput) return;

  await withLoading(btn, async () => {
    const targetProjectId = projectSelect.value;
    const subject = subjectInput.value.trim();
    const body = bodyInput.value.trim();
    const assignedTo = toSelect.value.trim();

    if (!targetProjectId) { setGlobalComposeStatus('Project is required.', 'error'); return; }
    if (!assignedTo) { setGlobalComposeStatus('To is required.', 'error'); toSelect.focus(); return; }
    if (!subject) { setGlobalComposeStatus('Subject is required.', 'error'); subjectInput.focus(); return; }
    if (!_dashboardProjectsById[targetProjectId]?.can_manage) {
      setGlobalComposeStatus('Insufficient permission to create issues in this project.', 'error');
      return;
    }

    const res = await fetch(buildProjectApiPath(targetProjectId, '/issues'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ title: subject, body, created_by: 'user', assigned_to: assignedTo }),
    });

    if (res.ok) {
      closeInlineCompose();
      subjectInput.value = '';
      bodyInput.value = '';
      showToast('Message sent', 'success');
      await Promise.all([loadNotifications({ reset: true }), loadProjects()]);
    } else {
      const err = await res.json().catch(() => ({}));
      setGlobalComposeStatus(err.error || 'Failed to send message', 'error');
    }
  });
}

function hideModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

function getCreateProjectCommandProfileManager() {
  return window.HAICOCommandProfiles || null;
}

function getSelectedCreateProjectProfile() {
  const manager = getCreateProjectCommandProfileManager();
  const select = document.getElementById('proj-cmd-profile');
  return manager?.getById(select?.value || '') || null;
}

function getCreateProjectTargetSelect() {
  return document.getElementById('proj-target-instance');
}

function getCreateProjectTargetId() {
  return getCreateProjectTargetSelect()?.value || 'localhost';
}

function getCreateProjectTargetMeta(targetId) {
  const resolvedId = String(targetId || getCreateProjectTargetId() || 'localhost').trim() || 'localhost';
  if (resolvedId === 'localhost') {
    return {
      id: 'localhost',
      label: 'localhost',
      detail: 'This machine',
      isLocal: true,
      instance: null,
    };
  }

  const instance = (_createProjectTargetOptions || []).find((item) => item.id === resolvedId) || null;
  return {
    id: resolvedId,
    label: instance?.name || instance?.base_url || 'remote machine',
    detail: instance?.base_url || instance?.name || 'Remote HAICO instance',
    isLocal: false,
    instance,
  };
}

function updateCreateProjectWorkdirControls() {
  const target = getCreateProjectTargetMeta();
  const input = document.getElementById('proj-workdir');
  const browseButton = document.getElementById('proj-workdir-browse');
  const hint = document.getElementById('proj-workdir-hint');

  if (input) {
    input.placeholder = target.isLocal
      ? 'Optional absolute path'
      : 'Optional absolute path on the selected machine';
  }
  if (browseButton) {
    browseButton.disabled = !target.isLocal;
    browseButton.title = target.isLocal
      ? 'Browse local folders'
      : 'Remote folder browsing is not available';
  }
  if (hint) {
    hint.textContent = target.isLocal
      ? 'Optional. If empty, HAICO will use the path inferred from your prompt or leave it unset.'
      : `Optional. Enter an absolute path on ${target.label} manually. Folder browsing only works for localhost.`;
  }
}

function renderCreateProjectTargetOptions(selectedTargetId) {
  const select = getCreateProjectTargetSelect();
  const hint = document.getElementById('proj-target-instance-hint');
  if (!select) return;

  const remoteOptions = Array.isArray(_createProjectTargetOptions) ? _createProjectTargetOptions : [];
  const desiredTargetId = String(selectedTargetId || select.value || 'localhost').trim() || 'localhost';

  select.innerHTML = [
    '<option value="localhost">localhost</option>',
    ...remoteOptions.map((instance) => {
      const statusSuffix = !instance.available
        ? ' · setup required'
        : (instance.last_status === 'error' ? ' · connection issue' : '');
      const label = `${instance.name} · ${instance.base_url}${statusSuffix}`;
      return `<option value="${esc(instance.id)}">${esc(label)}</option>`;
    }),
  ].join('');

  const validTargetId = desiredTargetId === 'localhost' || remoteOptions.some((instance) => instance.id === desiredTargetId)
    ? desiredTargetId
    : 'localhost';
  select.value = validTargetId;

  const target = getCreateProjectTargetMeta(validTargetId);
  if (hint) {
    hint.textContent = target.isLocal
      ? 'New projects run on localhost by default.'
      : `HAICO will prepare and create this project on ${target.label}.`;
  }
  updateCreateProjectWorkdirControls();
}

async function hydrateCreateProjectTargetOptions() {
  const select = getCreateProjectTargetSelect();
  if (!select) return;

  const currentTargetId = select.value || 'localhost';
  select.disabled = true;

  try {
    let instances = [];

    const optionsRes = await fetch('/api/remote-instance-options', { headers: apiHeaders() });
    if (optionsRes.ok) {
      const data = await optionsRes.json().catch(() => ({}));
      instances = Array.isArray(data.instances) ? data.instances : [];
    } else {
      const remoteProjectsRes = await fetch('/api/remote-projects', { headers: apiHeaders() });
      const remoteProjectsData = remoteProjectsRes.ok ? await remoteProjectsRes.json().catch(() => ({})) : {};
      const remoteInstances = Array.isArray(remoteProjectsData.instances) ? remoteProjectsData.instances : [];
      const byId = new Map();
      for (const instance of remoteInstances) {
        if (!instance || !instance.id) continue;
        byId.set(instance.id, {
          id: instance.id,
          name: instance.name || instance.base_url || instance.id,
          base_url: instance.base_url || '',
          enabled: instance.enabled !== false,
          last_status: instance.last_status || instance.runtime_status || 'unknown',
          last_error: instance.last_error || instance.runtime_error || '',
          available: instance.enabled !== false,
        });
      }
      instances = Array.from(byId.values());
    }

    _createProjectTargetOptions = instances;
  } catch (error) {
    console.error('Failed to load create project machine options', error);
    _createProjectTargetOptions = [];
  } finally {
    select.disabled = false;
    renderCreateProjectTargetOptions(currentTargetId);
  }
}

function handleCreateProjectTargetChange() {
  renderCreateProjectTargetOptions(getCreateProjectTargetId());
  refreshCreateProjectReadiness().catch((error) => {
    console.error('Failed to refresh create project readiness after machine change', error);
  });
}

function getRemoteInstancesSettingsRoot() {
  return document.getElementById('remote-instances-settings');
}

function getRemoteStatusLabel(instance) {
  if (instance?.last_status === 'ok') return 'Connected';
  if (instance?.last_status === 'error') return 'Needs Review';
  return 'Unchecked';
}

function deriveRemoteInstanceName(baseUrl, fallback) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return String(fallback || '').trim();
  try {
    const normalized = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
    const url = new URL(normalized);
    return url.host || String(fallback || '').trim() || raw;
  } catch {
    return String(fallback || '').trim() || raw;
  }
}

function renderRemoteInstancesSettings() {
  const root = getRemoteInstancesSettingsRoot();
  if (!root) return;

  if (!_currentUser) {
    root.innerHTML = '<div class="empty-state">Loading remote instance settings...</div>';
    return;
  }

  if (_currentUser.role !== 'admin') {
    root.innerHTML = `
      <div class="remote-settings-shell">
        <div class="remote-settings-note">Remote instance configuration is only available to workspace admins.</div>
      </div>
    `;
    return;
  }

  const editing = _remoteInstances.find((instance) => instance.id === _editingRemoteInstanceId) || null;
  const primaryAction = editing ? 'Save' : 'Add';

  root.innerHTML = `
    <div class="remote-settings-shell">
      <div class="remote-settings-note">
        Add another HAICO machine here. HAICO will sign in once, store the remote session token on the server, and merge that machine's projects into this dashboard.
      </div>
      <div class="command-profiles-table-wrap">
        <table class="command-profiles-table remote-instances-table">
          <thead>
            <tr>
              <th>Instance</th>
              <th>URL</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${_remoteInstances.length ? _remoteInstances.map((instance) => `
              <tr>
                <td>
                  <div class="remote-table-instance">
                    <span class="remote-server-dot" data-status="${esc(instance.last_status || 'unknown')}"></span>
                    <div>
                      <div class="remote-server-label">${esc(instance.name)}</div>
                      <div class="remote-server-meta-inline">${instance.has_api_token ? 'Signed in' : 'No saved login'}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="remote-server-url">${esc(instance.base_url)}</div>
                </td>
                <td>
                  <div class="remote-table-status">
                    <span class="remote-status-badge" data-status="${esc(instance.last_status || 'unknown')}">${esc(getRemoteStatusLabel(instance))}</span>
                    <div class="remote-server-meta-inline">${instance.last_checked_at ? `Checked ${timeAgo(instance.last_checked_at)}` : 'Never checked'}</div>
                    ${instance.last_error ? `<div class="remote-server-meta-inline">${esc(instance.last_error)}</div>` : ''}
                  </div>
                </td>
                <td>
                  <div class="command-profile-actions">
                    <button type="button" class="btn btn-sm" onclick="editRemoteInstance(${JSON.stringify(instance.id)})">Edit</button>
                    <button type="button" class="btn btn-sm" onclick="checkRemoteInstance(${JSON.stringify(instance.id)})">Check</button>
                    <button type="button" class="btn btn-sm btn-danger" onclick="deleteRemoteInstance(${JSON.stringify(instance.id)})">Delete</button>
                  </div>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="4" class="command-profiles-empty">No remote HAICO instances yet.</td></tr>'}
            <tr data-remote-instance-row="${editing ? esc(editing.id) : '__new__'}">
              <td colspan="2">
                <div class="remote-inline-form">
                  <input class="command-profile-input remote-inline-url" type="text" id="remote-instance-base-url" value="${esc(editing?.base_url || '')}" placeholder="URL">
                  <input class="command-profile-input remote-inline-username" type="text" id="remote-instance-username" value="" placeholder="Username">
                  <input class="command-profile-input remote-inline-password" type="password" id="remote-instance-password" value="" placeholder="Password">
                </div>
              </td>
              <td>
                <div class="remote-table-status">
                  <div class="remote-server-meta-inline">${editing ? `Editing ${esc(editing.name)}` : 'URL / Username / Password'}</div>
                  ${editing?.has_api_token ? `<div class="remote-server-meta-inline">Saved login: ${esc(editing.api_token_preview || '')}</div>` : ''}
                </div>
              </td>
              <td>
                <div class="command-profile-actions">
                  <button type="button" class="btn btn-sm btn-primary" onclick="saveRemoteInstance()">${primaryAction}</button>
                  ${editing ? '<button type="button" class="btn btn-sm" onclick="cancelRemoteInstanceEdit()">Cancel</button>' : ''}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function loadRemoteInstancesSettings() {
  const root = getRemoteInstancesSettingsRoot();
  if (!root) return;

  if (!_currentUser) {
    renderRemoteInstancesSettings();
    return;
  }

  if (_currentUser.role !== 'admin') {
    _remoteInstances = [];
    _editingRemoteInstanceId = '';
    renderRemoteInstancesSettings();
    return;
  }

  root.innerHTML = '<div class="empty-state">Loading remote instance settings...</div>';
  try {
    const res = await fetch('/api/remote-instances', { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load remote instances');
    _remoteInstances = Array.isArray(data.instances) ? data.instances : [];
    if (_editingRemoteInstanceId && !_remoteInstances.some((instance) => instance.id === _editingRemoteInstanceId)) {
      _editingRemoteInstanceId = '';
    }
    renderRemoteInstancesSettings();
  } catch (error) {
    root.innerHTML = renderError(error, 'loadRemoteInstancesSettings()');
  }
}

function editRemoteInstance(id) {
  _editingRemoteInstanceId = id;
  renderRemoteInstancesSettings();
}

function cancelRemoteInstanceEdit() {
  _editingRemoteInstanceId = '';
  renderRemoteInstancesSettings();
}

async function saveRemoteInstance() {
  const baseUrl = document.getElementById('remote-instance-base-url')?.value.trim() || '';
  const remoteUsername = document.getElementById('remote-instance-username')?.value.trim() || '';
  const remotePassword = document.getElementById('remote-instance-password')?.value.trim() || '';
  if (!baseUrl) {
    showToast('Remote instance URL is required', 'error');
    return;
  }

  const editing = _remoteInstances.find((instance) => instance.id === _editingRemoteInstanceId) || null;
  const name = deriveRemoteInstanceName(baseUrl, editing?.name || '');
  const method = editing ? 'PUT' : 'POST';
  const url = editing ? `/api/remote-instances/${editing.id}` : '/api/remote-instances';
  const body = {
    name,
    base_url: baseUrl,
  };
  if (remoteUsername) {
    body.remote_username = remoteUsername;
  }
  if (remotePassword) {
    body.remote_password = remotePassword;
  }

  try {
    const res = await fetch(url, {
      method,
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save remote instance');
    _editingRemoteInstanceId = '';
    await loadRemoteInstancesSettings();
    await loadProjects();
    showToast(editing ? 'Remote instance updated' : 'Remote instance added', 'success');
  } catch (error) {
    showToast(error.message || 'Failed to save remote instance', 'error');
  }
}

async function checkRemoteInstance(id) {
  try {
    const res = await fetch(`/api/remote-instances/${id}/check`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to check remote instance');
    await loadRemoteInstancesSettings();
    await loadProjects();
    showToast('Remote instance checked', 'success');
  } catch (error) {
    showToast(error.message || 'Failed to check remote instance', 'error');
  }
}

async function deleteRemoteInstance(id) {
  const confirmed = await showConfirm('Delete this remote HAICO instance from Settings?', {
    title: 'Remove remote instance?',
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/remote-instances/${id}`, {
      method: 'DELETE',
      headers: apiHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to delete remote instance');
    if (_editingRemoteInstanceId === id) {
      _editingRemoteInstanceId = '';
    }
    await loadRemoteInstancesSettings();
    await loadProjects();
    showToast('Remote instance deleted', 'success');
  } catch (error) {
    showToast(error.message || 'Failed to delete remote instance', 'error');
  }
}

function openCreateProjectSettings() {
  hideCreateModal();
  switchView('settings');
}

function renderCreateProjectCheck(input) {
  const tone = input.tone || 'warn';
  const detail = input.detail || '';
  const action = input.action || '';
  return `
    <div class="create-project-check create-project-check-${tone}">
      <div class="create-project-check-icon" aria-hidden="true"></div>
      <div class="create-project-check-copy">
        <div class="create-project-check-title">${esc(input.title || '')}</div>
        <div class="create-project-check-detail">${detail}</div>
        ${action ? `<div class="create-project-check-actions">${action}</div>` : ''}
      </div>
    </div>
  `;
}

function getCreateProjectAccountDetail() {
  if (_currentUser) {
    const name = _currentUser.display_name || _currentUser.username || 'Current user';
    return {
      tone: 'ok',
      title: 'Account',
      detail: `Signed in as <strong>${esc(name)}</strong> (${esc(_currentUser.role || 'member')}).`,
    };
  }

  return {
    tone: 'warn',
    title: 'Account',
    detail: 'Your session is required to create a project. If HAICO redirects you, sign in again and reopen this dialog.',
  };
}

function renderCreateProjectReadinessBody(content) {
  const body = document.getElementById('create-project-readiness-body');
  if (body) body.innerHTML = content;
}

function renderCreateProjectMissingProfileState() {
  const target = getCreateProjectTargetMeta();
  renderCreateProjectReadinessBody([
    renderCreateProjectCheck(getCreateProjectAccountDetail()),
    renderCreateProjectCheck({
      tone: 'error',
      title: 'Agent Tool',
      detail: 'No Agent Tool is configured yet. Open <strong>Settings</strong>, add one, then come back here.',
      action: '<button type="button" class="btn btn-sm" onclick="openCreateProjectSettings()">Open Settings</button>',
    }),
    renderCreateProjectCheck({
      tone: 'warn',
      title: 'First-time setup',
      detail: target.isLocal
        ? 'After adding the Agent Tool, make sure the CLI is installed locally and logged in. HAICO will re-check that here before project creation.'
        : `After adding the Agent Tool, make sure the CLI is installed and logged in on <strong>${esc(target.label)}</strong>. HAICO will re-check that here before project creation.`,
    }),
  ].join(''));
}

function renderCreateProjectReadiness(profile, readiness) {
  const target = getCreateProjectTargetMeta();
  const profileName = profile?.name || 'Selected profile';
  const commandType = readiness?.command_type || profile?.type || 'unknown';
  const binaryLabel = readiness?.binary || 'selected CLI';
  const binaryStatus = readiness?.binary_found
    ? {
        tone: 'ok',
        title: 'CLI availability',
        detail: `${esc(binaryLabel)} is available on <strong>${esc(target.label)}</strong> at <span class="create-project-inline-code">${esc(readiness.binary_path || '')}</span>.`,
      }
    : {
        tone: 'error',
        title: 'CLI availability',
        detail: `HAICO could not find <span class="create-project-inline-code">${esc(binaryLabel)}</span> on <strong>${esc(target.label)}</strong>. Install it there and make sure the shell can run it.`,
      };
  const authTone = readiness?.auth?.status === 'configured'
    ? 'ok'
    : (readiness?.auth?.status === 'missing' ? 'warn' : 'warn');
  const authDetailParts = [esc(readiness?.auth?.message || 'HAICO cannot verify login state for this tool automatically.')];
  if (readiness?.auth?.action_command) {
    authDetailParts.push(`Suggested command: <span class="create-project-inline-code">${esc(readiness.auth.action_command)}</span>`);
  }

  const issueCards = (readiness?.issues || []).filter((issue) => issue.code !== 'auth_missing').map((issue) => renderCreateProjectCheck({
    tone: issue.severity === 'blocking' ? 'error' : 'warn',
    title: issue.title,
    detail: `${esc(issue.detail)}${issue.action_command ? ` Suggested command: <span class="create-project-inline-code">${esc(issue.action_command)}</span>` : ''}`,
    action: issue.action_label === 'Open Settings'
      ? '<button type="button" class="btn btn-sm" onclick="openCreateProjectSettings()">Open Settings</button>'
      : '',
  }));

  renderCreateProjectReadinessBody([
    renderCreateProjectCheck(getCreateProjectAccountDetail()),
    renderCreateProjectCheck({
      tone: 'ok',
      title: 'Agent Tool',
      detail: `Using <strong>${esc(profileName)}</strong> on <strong>${esc(target.label)}</strong> (${esc(commandType)}): <span class="create-project-inline-code">${esc(profile?.command || '')}</span>`,
    }),
    renderCreateProjectCheck(binaryStatus),
    renderCreateProjectCheck({
      tone: authTone,
      title: 'CLI login',
      detail: authDetailParts.join(' '),
    }),
    ...issueCards,
  ].join(''));
}

async function refreshCreateProjectReadiness() {
  const modal = document.getElementById('createModal');
  if (!modal || !modal.classList.contains('active')) return null;

  const profile = getSelectedCreateProjectProfile();
  if (!profile?.command) {
    _createProjectReadiness = null;
    renderCreateProjectMissingProfileState();
    return null;
  }

  const requestId = ++_createProjectReadinessRequestId;
  const target = getCreateProjectTargetMeta();
  renderCreateProjectReadinessBody(`<div class="create-project-readiness-empty">Checking CLI setup on ${esc(target.label)}...</div>`);

  try {
    const res = await fetch('/api/command-profiles/check', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        command: profile.command,
        type: profile.type,
        target_instance_id: target.id,
      }),
    });
    const readiness = await res.json().catch(() => null);
    if (requestId !== _createProjectReadinessRequestId) return null;
    if (!res.ok) {
      _createProjectReadiness = null;
      renderCreateProjectReadinessBody(renderCreateProjectCheck({
        tone: 'warn',
        title: 'Setup check unavailable',
        detail: readiness?.error
          ? `HAICO could not inspect the CLI on <strong>${esc(target.label)}</strong>: ${esc(readiness.error)}`
          : `HAICO could not inspect the CLI on <strong>${esc(target.label)}</strong> right now.`,
      }));
      return null;
    }
    _createProjectReadiness = readiness;
    renderCreateProjectReadiness(profile, readiness || {});
    return readiness;
  } catch (error) {
    if (requestId !== _createProjectReadinessRequestId) return null;
    _createProjectReadiness = null;
    renderCreateProjectReadinessBody(renderCreateProjectCheck({
      tone: 'warn',
      title: 'Setup check unavailable',
      detail: `HAICO could not inspect your CLI right now${error?.message ? `: ${esc(error.message)}` : '.'}`,
    }));
    return null;
  }
}

function populateCreateProjectCommandProfileOptions(selectedProfileId) {
  const select = document.getElementById('proj-cmd-profile');
  const hiddenInput = document.getElementById('proj-cmd');
  const preview = document.getElementById('proj-cmd-preview');
  if (!select || !hiddenInput) return;

  const manager = getCreateProjectCommandProfileManager();
  const profiles = manager?.getProfiles() || [];

  if (!profiles.length) {
    select.innerHTML = '<option value="">No Agent Tools configured</option>';
    select.disabled = true;
    hiddenInput.value = '';
    if (preview) preview.innerHTML = 'No Agent Tool is configured yet. Open Settings and add one.';
    return;
  }

  const nextProfileId = selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : profiles[0].id;

  select.disabled = false;
  select.innerHTML = profiles.map((profile) =>
    `<option value="${profile.id}">${esc(profile.name)} (${esc(profile.type)})</option>`
  ).join('');
  select.value = nextProfileId;
  handleCreateProjectCommandProfileChange();
}

async function hydrateCreateProjectCommandProfileControls() {
  const select = document.getElementById('proj-cmd-profile');
  const hiddenInput = document.getElementById('proj-cmd');
  const preview = document.getElementById('proj-cmd-preview');
  if (!select || !hiddenInput) return;

  const manager = getCreateProjectCommandProfileManager();
  if (!manager) {
    select.innerHTML = '<option value="">Agent Tools unavailable</option>';
    select.disabled = true;
    hiddenInput.value = '';
    if (preview) preview.textContent = 'Open Settings and configure an Agent Tool first.';
    return;
  }

  await manager.ensureLoaded();
  const currentProfileId = select.value;
  populateCreateProjectCommandProfileOptions(currentProfileId);
  if (!(manager.getProfiles() || []).length) {
    _createProjectReadiness = null;
    renderCreateProjectMissingProfileState();
  }
}

function handleCreateProjectCommandProfileChange() {
  const select = document.getElementById('proj-cmd-profile');
  const hiddenInput = document.getElementById('proj-cmd');
  const preview = document.getElementById('proj-cmd-preview');
  if (!select || !hiddenInput) return;

  const manager = getCreateProjectCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  hiddenInput.value = selectedProfile?.command || '';
  if (preview) {
    preview.textContent = selectedProfile
      ? `Command: ${selectedProfile.command} (${selectedProfile.type})`
      : 'No Agent Tool is configured yet. Open Settings and add one first.';
  }
  refreshCreateProjectReadiness().catch((error) => {
    console.error('Failed to refresh create project readiness', error);
  });
}

function showCreateModal() {
  document.getElementById('createModal').classList.add('active');
  renderCreateProjectReadinessBody('<div class="create-project-readiness-empty">Loading setup checks...</div>');
  hydrateCreateProjectTargetOptions()
    .then(() => hydrateCreateProjectCommandProfileControls())
    .catch((error) => {
    console.error('Failed to load project command profile controls', error);
    renderCreateProjectMissingProfileState();
  });
}
function hideCreateModal() { document.getElementById('createModal').classList.remove('active'); }

function clearCreateProjectWorkdir() {
  const input = document.getElementById('proj-workdir');
  if (input) input.value = '';
}

async function ensureCreateProjectDirectoryRootsLoaded() {
  if (_createProjectDirectoryRoots.length > 0) return _createProjectDirectoryRoots;
  const res = await fetch('/api/projects/directory-roots', { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load directory roots');
  _createProjectDirectoryRoots = Array.isArray(data.roots) ? data.roots : [];
  return _createProjectDirectoryRoots;
}

function renderCreateProjectPathPicker(entries, currentPath) {
  const list = document.getElementById('path-picker-list');
  const current = document.getElementById('path-picker-current');
  if (current) current.textContent = currentPath || '/';
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div class="create-project-readiness-empty">No subdirectories here.</div>';
    return;
  }
  list.innerHTML = entries.map((entry) => `
    <button type="button" class="path-picker-entry" onclick="navigateCreateProjectPathPicker(${JSON.stringify(entry.relative_path || '')})">
      <div>
        <div class="path-picker-entry-name">${esc(entry.name)}</div>
        <div class="path-picker-entry-path">${esc(entry.absolute_path || '')}</div>
      </div>
      <div class="create-project-inline-code">dir</div>
    </button>
  `).join('');
}

async function loadCreateProjectPathPicker(pathValue) {
  const rootSelect = document.getElementById('path-picker-root');
  if (!rootSelect) return;
  const roots = await ensureCreateProjectDirectoryRootsLoaded();
  if (!roots.length) throw new Error('No browse roots available');

  const workdirValue = String(pathValue || document.getElementById('proj-workdir')?.value || '').trim();
  let matchedRoot = roots.find((root) => workdirValue && (workdirValue === root.path || workdirValue.startsWith(`${root.path}/`))) || roots[0];
  if (!_createProjectDirectoryRootId || !roots.some((root) => root.id === _createProjectDirectoryRootId)) {
    _createProjectDirectoryRootId = matchedRoot.id;
  }
  if (workdirValue && matchedRoot.id === _createProjectDirectoryRootId) {
    _createProjectDirectoryRelativePath = workdirValue === matchedRoot.path
      ? ''
      : workdirValue.slice(matchedRoot.path.length).replace(/^\/+/, '');
  }

  rootSelect.innerHTML = roots.map((root) =>
    `<option value="${esc(root.id)}">${esc(root.label)} · ${esc(root.path)}</option>`
  ).join('');
  rootSelect.value = _createProjectDirectoryRootId;

  const params = new URLSearchParams({
    root_id: _createProjectDirectoryRootId,
    path: _createProjectDirectoryRelativePath || '',
  });
  const res = await fetch(`/api/projects/browse-directories?${params.toString()}`, { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to browse directories');
  _createProjectDirectoryRelativePath = data.relative_path || '';
  renderCreateProjectPathPicker(Array.isArray(data.entries) ? data.entries : [], data.absolute_path || '');
}

function openCreateProjectPathPicker() {
  if (!getCreateProjectTargetMeta().isLocal) {
    showToast('Remote folder browsing is not available yet. Enter the path manually.', 'error');
    return;
  }
  document.getElementById('pathPickerModal')?.classList.add('active');
  const list = document.getElementById('path-picker-list');
  if (list) list.innerHTML = '<div class="create-project-readiness-empty">Loading directories...</div>';
  loadCreateProjectPathPicker().catch((error) => {
    if (list) list.innerHTML = `<div class="create-project-readiness-empty">${esc(error.message || 'Failed to load directories')}</div>`;
  });
}

function closeCreateProjectPathPicker() {
  document.getElementById('pathPickerModal')?.classList.remove('active');
}

function handlePathPickerRootChange() {
  _createProjectDirectoryRootId = document.getElementById('path-picker-root')?.value || '';
  _createProjectDirectoryRelativePath = '';
  loadCreateProjectPathPicker().catch((error) => {
    const list = document.getElementById('path-picker-list');
    if (list) list.innerHTML = `<div class="create-project-readiness-empty">${esc(error.message || 'Failed to load directories')}</div>`;
  });
}

function navigateCreateProjectPathPicker(relativePath) {
  _createProjectDirectoryRelativePath = relativePath || '';
  loadCreateProjectPathPicker().catch((error) => {
    const list = document.getElementById('path-picker-list');
    if (list) list.innerHTML = `<div class="create-project-readiness-empty">${esc(error.message || 'Failed to load directories')}</div>`;
  });
}

function navigatePathPickerUp() {
  if (!_createProjectDirectoryRelativePath) return;
  const parts = _createProjectDirectoryRelativePath.split('/').filter(Boolean);
  parts.pop();
  navigateCreateProjectPathPicker(parts.join('/'));
}

async function confirmPathPickerSelection() {
  const params = new URLSearchParams({
    root_id: _createProjectDirectoryRootId,
    path: _createProjectDirectoryRelativePath || '',
  });
  const res = await fetch(`/api/projects/browse-directories?${params.toString()}`, { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Failed to use this folder', 'error');
    return;
  }
  const input = document.getElementById('proj-workdir');
  if (input) input.value = data.absolute_path || '';
  closeCreateProjectPathPicker();
}

async function createProject() {
  const btn = document.querySelector('#createModal button[onclick="createProject()"]');
  await withLoading(btn, async () => {
    const task = document.getElementById('proj-task').value.trim();
    const selectedProfile = getSelectedCreateProjectProfile();
    const target = getCreateProjectTargetMeta();
    const toolPath = selectedProfile?.command || document.getElementById('proj-cmd').value.trim();
    const explicitWorkdir = document.getElementById('proj-workdir')?.value.trim() || '';
    if (!task) { showToast('Please describe the task to execute', 'error'); return; }
    if (!selectedProfile || !toolPath) {
      renderCreateProjectMissingProfileState();
      showToast('Please choose an Agent Tool configured in Settings first', 'error');
      return;
    }

    const readiness = await refreshCreateProjectReadiness();
    if (readiness && readiness.ready === false) {
      showToast('Finish the setup items in the dialog before creating the project', 'error');
      return;
    }

    // Step 1: Call AI to generate project metadata
    btn.textContent = 'Generating...';
    const genRes = await fetch('/api/generate-project', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({
        description: task,
        tool_path: toolPath,
        command_type: selectedProfile.type,
        target_instance_id: target.id,
      }),
    });

    let name, description, taskDesc, workDir, ctrlRole;
    if (genRes.ok) {
      const gen = await genRes.json();
      name = gen.name || 'project';
      description = gen.description || task.slice(0, 100);
      taskDesc = gen.task_description || task;
      workDir = explicitWorkdir || gen.working_directory || null;
      ctrlRole = gen.controller_role || null;
    } else {
      const err = await genRes.json().catch(() => ({}));
      if (err.readiness) {
        _createProjectReadiness = err.readiness;
        renderCreateProjectReadiness(selectedProfile, err.readiness);
      }
      if (err.error_code === 'missing_cli' || err.error_code === 'auth_required') {
        showToast(err.error || 'The selected CLI needs setup before project creation', 'error');
        return;
      }
      if (!target.isLocal) {
        showToast(err.error || `Failed to prepare the project on ${target.label}`, 'error');
        return;
      }
      // Fallback if AI fails
      name = task.slice(0, 30).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'project';
      description = task.slice(0, 100);
      taskDesc = task;
      workDir = explicitWorkdir || null;
    }

    // Step 2: Create the project
    btn.textContent = 'Creating...';
    const body = {
      name,
      description,
      task_description: taskDesc,
      command_template: toolPath,
      command_type: selectedProfile.type,
      working_directory: workDir,
      controller_role: ctrlRole,
      target_instance_id: target.id,
    };

    const res = await fetch('/api/projects', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) {
      const proj = await res.json();
      hideCreateModal();
      if (proj?.is_remote) {
        await loadProjects();
        switchView('projects');
        showToast(`Project created on ${target.label}`, 'success');
        return;
      }
      window.location.href = buildProjectPageHref(proj.id);
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed to create', 'error');
    }
  });
}

window.addEventListener('haico:user-ready', () => {
  const modal = document.getElementById('createModal');
    if (modal?.classList.contains('active')) {
      const profile = getSelectedCreateProjectProfile();
      if (profile && _createProjectReadiness) renderCreateProjectReadiness(profile, _createProjectReadiness);
      else if (profile) refreshCreateProjectReadiness().catch(() => {});
      else renderCreateProjectMissingProfileState();
  }
});

window.addEventListener('haico:command-profiles-changed', () => {
  const modal = document.getElementById('createModal');
  if (modal?.classList.contains('active')) {
    hydrateCreateProjectCommandProfileControls().catch((error) => {
      console.error('Failed to reload command profiles for create project modal', error);
    });
  }
});

if (typeof window !== 'undefined') {
  window.openCreateProjectSettings = openCreateProjectSettings;
  window.openCreateProjectPathPicker = openCreateProjectPathPicker;
  window.closeCreateProjectPathPicker = closeCreateProjectPathPicker;
  window.handlePathPickerRootChange = handlePathPickerRootChange;
  window.navigateCreateProjectPathPicker = navigateCreateProjectPathPicker;
  window.navigatePathPickerUp = navigatePathPickerUp;
  window.confirmPathPickerSelection = confirmPathPickerSelection;
  window.clearCreateProjectWorkdir = clearCreateProjectWorkdir;
  window.handleCreateProjectTargetChange = handleCreateProjectTargetChange;
  window.openProjectCard = openProjectCard;
  window.saveRemoteInstance = saveRemoteInstance;
  window.editRemoteInstance = editRemoteInstance;
  window.cancelRemoteInstanceEdit = cancelRemoteInstanceEdit;
  window.checkRemoteInstance = checkRemoteInstance;
  window.deleteRemoteInstance = deleteRemoteInstance;
  window.loadRemoteInstancesSettings = loadRemoteInstancesSettings;
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
  const panel = document.getElementById('usage-by-project-panel');
  const container = document.getElementById('usage-by-project-chart');
  if (!panel || !container) return;

  try {
    const res = await fetch(`/api/dashboard/usage-by-project?period=${_usagePeriod}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const emptyPeriodLabel = {
      hour: 'this hour',
      day: 'today',
      week: 'this week',
      month: 'this month',
    }[_usagePeriod] || 'this period';

    if (!data.time_buckets || !data.time_buckets.length || !data.projects || !data.projects.length) {
      panel.style.display = '';
      container.innerHTML = `<div class="empty-state" style="padding:32px 12px;text-align:center">
        <div style="font-size:14px;font-weight:600;margin-bottom:6px">No usage data for ${esc(emptyPeriodLabel)}.</div>
        <div style="font-size:12px;color:var(--text-secondary)">Usage and cost metrics will appear here after agents record activity. Try a broader period if you expected older data.</div>
      </div>`;
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
    panel.style.display = '';
    container.innerHTML = renderError(e, 'loadUsageByProject()');
  }
}

let _agentBoardFilter = 'running';
let _agentBoardData = [];
let _costAlertDismissed = false;
const COST_ALERT_THRESHOLD = parseFloat(localStorage.getItem('haico-cost-threshold') || '10');

function getDashboardViewLoaders(view) {
  const activeView = normalizeDashboardView(view || _dashboardView);
  if (activeView === 'projects') {
    return [loadDashboardSummary(), loadProjects(), loadAgentBoard(), loadActivityStream(), loadDashboardApprovals()];
  }
  if (activeView === 'usage') {
    return [loadUsageByProject(), checkCostAlert()];
  }
  if (activeView === 'settings') {
    const loaders = [loadRemoteInstancesSettings()];
    if (window.HAICOCommandProfiles && typeof window.HAICOCommandProfiles.ensureLoaded === 'function') {
      loaders.push(Promise.resolve(window.HAICOCommandProfiles.ensureLoaded()));
    }
    return loaders;
  }
  return [loadDashboardSummary(), loadNotifications(), ensureDashboardProjectsLoaded()];
}

async function loadDashboard(view) {
  await Promise.all(getDashboardViewLoaders(view));
}

applyDashboardViewState(_dashboardView);
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
  if (_dashboardView !== 'inbox') return;
  if (_pollInFlight) return;
  _pollInFlight = true;
  try { await loadDashboard('inbox'); }
  finally { _pollInFlight = false; }
}, 10000);
setInterval(async () => {
  if (_dashboardView !== 'projects') return;
  if (_pollSlowInFlight) return;
  _pollSlowInFlight = true;
  try { await loadDashboard('projects'); }
  finally { _pollSlowInFlight = false; }
}, 30000);
setInterval(() => {
  if (_dashboardView !== 'usage') return;
  loadDashboard('usage');
}, 60000);
window.addEventListener('haico:user-ready', () => {
  ensureDashboardProjectsLoaded();
  if (_dashboardView === 'settings') {
    loadRemoteInstancesSettings().catch((error) => {
      console.error('Failed to load remote instances settings', error);
    });
  }
});
window.addEventListener('haico:command-profiles-changed', () => {
  hydrateCreateProjectCommandProfileControls().catch((error) => {
    console.error('Failed to refresh project command profile controls', error);
  });
});

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
    const res = await fetch(buildProjectIssueLookupApiPath(projectId, issueNumber), { headers: apiHeaders() });
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
    const res = await fetch(buildIssueApiPath(issueId), { headers: apiHeaders() });
    if (!res.ok) { document.getElementById('issueDetailContent').innerHTML = renderError({ status: res.status }); return; }
    const issue = await res.json();

    // Load agents for this project
    try {
      const agentsRes = await fetch(buildProjectApiPath(issue.project_id, '/agents'), { headers: apiHeaders() });
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

    // Reuse the already loaded project index when available.
    const projects = await ensureDashboardProjectsLoaded();

    let allApprovals = [];
    for (const p of projects) {
      try {
        const approvalsPath = `${buildProjectApiPath(p.id, '/approvals')}?status=pending&limit=10`;
        const aRes = await fetch(approvalsPath, { headers: apiHeaders() });
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
            '<a href="' + buildProjectPageHref(a._project_id) + '#workflow" style="color:var(--link)">' + esc(a._project_name) + '</a>' +
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
    const res = await fetch(buildApprovalApiPath(approvalId), {
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
          detail = '<a href="' + buildIssuePageHref({ issueId: ev.id, projectId: ev.project_id, issueNumber: ev.number }) + '" onclick="event.stopPropagation()">#' + ev.number + '</a> ' + esc(ev.title);
          break;
        case 'issue_status_change':
          icon = '<span style="color:var(--accent)">&#8635;</span>';
          label = ev.status;
          detail = '<a href="' + buildIssuePageHref({ issueId: ev.id, projectId: ev.project_id, issueNumber: ev.number }) + '" onclick="event.stopPropagation()">#' + ev.number + '</a> ' + esc(ev.title);
          break;
        case 'comment':
          icon = '<span style="color:var(--text-secondary)">&#9998;</span>';
          label = 'Comment';
          var preview = (ev.body || '').slice(0, 50) + ((ev.body || '').length > 50 ? '...' : '');
          detail = '<a href="' + buildIssuePageHref({ issueId: ev.id, projectId: ev.project_id, issueNumber: ev.issue_number }) + '" onclick="event.stopPropagation()">#' + ev.issue_number + '</a> ' + esc(preview);
          break;
        case 'agent_started':
          icon = '<span style="color:var(--success)">&#9654;</span>';
          label = 'Agent Started';
          detail = '<a href="' + buildProjectPageHref(ev.project_id) + '#agents">' + esc(ev.agent_name) + '</a>';
          break;
        case 'agent_stopped':
          icon = '<span style="color:var(--text-secondary)">&#9632;</span>';
          label = 'Agent Stopped';
          detail = '<a href="' + buildProjectPageHref(ev.project_id) + '#agents">' + esc(ev.agent_name) + '</a>';
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
  for (var p of getLocalDashboardProjects()) {
    var id = p.id;
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
              '<a href="' + buildProjectPageHref(agent.project_id) + '#agents" style="font-weight:600;font-size:13px;color:var(--fg);text-decoration:none">' + esc(agent.name) + '</a>' +
              controllerBadge + pausedBadge +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-secondary)">' +
              '<a href="' + buildProjectPageHref(agent.project_id) + '" style="color:var(--link)">' + esc(agent.project_name) + '</a>' +
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
  if (_dashboardView === 'settings') return;
  if (_wsRefreshTimer) return; // already scheduled
  _wsRefreshTimer = setTimeout(async () => {
    _wsRefreshTimer = null;
    if (_dashboardView === 'settings') return;
    if (_pollInFlight) return; // skip if polling is already running
    _pollInFlight = true;
    try {
      await loadDashboard(_dashboardView);
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

// --- Browser Notifications (Web Notifications API) ---

function showBrowserNotification(newItems) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const titles = newItems.map(i => i.title || `#${i.number}`).slice(0, 3);
  let body = titles.join('\n');
  if (newItems.length > 3) body += `\n...and ${newItems.length - 3} more`;
  try {
    new Notification('HAICO', { body, icon: '/public/brand/haico-mark-square-192.png' });
  } catch (_) { /* silent */ }
}

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  Notification.requestPermission().then(function () {
    updateNotifPermissionBtn();
  });
}

function updateNotifPermissionBtn() {
  const btn = document.getElementById('notif-permission-btn');
  if (!btn) return;
  if (!('Notification' in window)) {
    btn.style.display = 'none';
    return;
  }
  if (Notification.permission === 'granted') {
    btn.textContent = '🔔 Notifications On';
    btn.disabled = true;
    btn.title = 'Browser notifications enabled';
    btn.classList.add('notif-perm-granted');
  } else if (Notification.permission === 'denied') {
    btn.textContent = '🔕 Blocked';
    btn.disabled = true;
    btn.title = 'Browser notifications blocked — enable in browser settings';
    btn.classList.add('notif-perm-denied');
  } else {
    btn.textContent = '🔔 Enable Notifications';
    btn.disabled = false;
    btn.title = 'Click to enable browser notifications';
    btn.classList.remove('notif-perm-granted', 'notif-perm-denied');
  }
}

// Inject the permission button into the inbox toolbar on load
(function initNotifPermissionBtn() {
  if (!('Notification' in window)) return;
  const toolbarRight = document.querySelector('#notifications-panel .mail-toolbar-right');
  if (!toolbarRight) return;
  const btn = document.createElement('button');
  btn.id = 'notif-permission-btn';
  btn.className = 'btn btn-sm';
  btn.style.marginRight = '4px';
  btn.onclick = requestNotificationPermission;
  toolbarRight.insertBefore(btn, toolbarRight.firstChild);
  updateNotifPermissionBtn();
})();
