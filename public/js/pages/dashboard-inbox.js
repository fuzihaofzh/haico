import { initDashboardPage, loadDashboardProjects, setupDashboardWS } from './dashboard-core.js';

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
let _currentUser = null;
let _dashboardProjectsById = {};
let _globalComposeAgentsByProject = {};
let _dashboardChatMessages = [];
let _dashboardChatPending = false;
let _dashboardChatStatus = { message: '', type: '' };
let _dashboardChatProfileId = '';
let _dashboardChatProjectId = '';
let _panelIssueId = null;
let _panelAgents = [];
const DASHBOARD_CHAT_PROFILE_STORAGE_KEY = 'haico.dashboardChat.profileId';
const DASHBOARD_CHAT_PROJECT_STORAGE_KEY = 'haico.dashboardChat.projectId';
const INBOX_ITEM_LIMIT = 20;
const MOBILE_INBOX_BREAKPOINT = 768;
let _inboxPagination = { limit: INBOX_ITEM_LIMIT, offset: 0, total: 0, hasMore: false, loading: false };
let _inboxUnreadCount = 0;

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

function isMobileInboxViewport() {
  return window.innerWidth <= MOBILE_INBOX_BREAKPOINT;
}

function getInboxNotificationsPanel() {
  return document.getElementById('notifications-panel');
}

function getMailDetailContent() {
  return document.getElementById('mail-detail-content') || document.getElementById('mail-detail-pane');
}

function setInboxMobilePane(pane) {
  _inboxMobilePane = pane === 'detail' ? 'detail' : 'list';
  syncInboxMobilePane();
}

function showInboxListPane() {
  setInboxMobilePane('list');
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

    // Pending approvals stat
    const approvalCard = document.getElementById('stat-approvals-card');
    if (data.pending_approvals > 0) {
      document.getElementById('stat-approvals').textContent = data.pending_approvals;
      if (approvalCard) approvalCard.style.display = '';
    } else {
      if (approvalCard) approvalCard.style.display = 'none';
    }

    document.getElementById('dashboard-stats').style.display = '';
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
    html += `<div class="mail-item${isUnread ? ' mail-unread' : ''}${isSelected ? ' mail-selected' : ''}" data-action="select-mail-item" data-idx="${i}" data-issue-id="${issue.id}" data-idx="${i}">
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
      <button class="btn btn-sm" data-action="load-more-inbox" ${_inboxPagination.loading ? 'disabled' : ''}>
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

async function loadInboxIssueDetail(issueId, expectedIdx, forceRefresh) {
  const inboxItem = _renderedMailItems[expectedIdx];
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

function getInboxIssueById(issueId) {
  const id = String(issueId || '');
  if (!id) return null;
  const rendered = _renderedMailItems.find((item) => item.data && item.data.id === id);
  if (rendered) return rendered.data;
  const cached = _inboxAllItems.find((item) => item.data && item.data.id === id);
  return cached ? cached.data : null;
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

function syncNotifFilterButtons() {
  document.querySelectorAll('.notif-filter-btn[data-filter]').forEach((btn) => {
    const active = btn.dataset.filter === _notifFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncInboxScopeButtons() {
  document.querySelectorAll('.inbox-scope-btn[data-scope]').forEach((btn) => {
    const active = btn.dataset.scope === _inboxScope;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncInboxProjectFilterControl() {
  const filter = document.getElementById('inbox-project-filter');
  if (!filter) return;
  filter.value = _inboxProject || '';
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
  syncInboxProjectFilterControl();
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


async function loadProjects(options = {}) {
  const projects = await loadDashboardProjects(options);
  _dashboardProjectsById = Object.fromEntries(projects.map((project) => [project.id, project]));
  populateInboxProjectFilter();
  if (document.getElementById('dashboard-chat-project')) {
    populateDashboardChatProjectOptions();
    renderDashboardChatTranscript();
  }
  return projects;
}

async function ensureDashboardProjectsLoaded() {
  if (Object.keys(_dashboardProjectsById || {}).length > 0) return Object.values(_dashboardProjectsById);
  return loadProjects();
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

function saveDashboardChatPreferences() {
  try {
    localStorage.setItem(DASHBOARD_CHAT_PROFILE_STORAGE_KEY, _dashboardChatProfileId || '');
    localStorage.setItem(DASHBOARD_CHAT_PROJECT_STORAGE_KEY, _dashboardChatProjectId || '');
  } catch (_) {}
}

function setDashboardChatStatus(message, type) {
  _dashboardChatStatus = {
    message: message || '',
    type: type || '',
  };
  const status = document.getElementById('dashboard-chat-status');
  if (!status) return;
  status.textContent = _dashboardChatStatus.message;
  status.className = 'compose-status dashboard-chat-status' + (_dashboardChatStatus.type ? ' compose-status-' + _dashboardChatStatus.type : '');
}

function formatDashboardChatMessage(content) {
  return esc(content || '').replace(/\n/g, '<br>');
}

function renderDashboardChatEmptyState() {
  const projectCount = Object.keys(_dashboardProjectsById || {}).length;
  return `<div class="dashboard-chat-empty">
    <div class="dashboard-chat-empty-icon">&#128172;</div>
    <div class="dashboard-chat-empty-title">Ask HAICO</div>
    <div class="dashboard-chat-empty-copy">I can look up project progress, inspect issues, update records, and delegate longer work as a new issue.</div>
    <div class="dashboard-chat-empty-meta">${projectCount} project${projectCount === 1 ? '' : 's'} currently in scope</div>
  </div>`;
}

function renderDashboardChatTranscriptHtml() {
  const messages = _dashboardChatMessages || [];
  if (!messages.length && !_dashboardChatPending) {
    return renderDashboardChatEmptyState();
  }

  const rows = messages.map((message) => {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const label = role === 'user' ? 'You' : 'HAICO';
    return `<div class="dashboard-chat-row dashboard-chat-row-${role}">
      <div class="dashboard-chat-avatar">${label.slice(0, 1)}</div>
      <div class="dashboard-chat-bubble-wrap">
        <div class="dashboard-chat-label">${label}</div>
        <div class="dashboard-chat-bubble dashboard-chat-bubble-${role}">${formatDashboardChatMessage(message.content)}</div>
      </div>
    </div>`;
  });

  if (_dashboardChatPending) {
    rows.push(`<div class="dashboard-chat-row dashboard-chat-row-assistant">
      <div class="dashboard-chat-avatar">H</div>
      <div class="dashboard-chat-bubble-wrap">
        <div class="dashboard-chat-label">HAICO</div>
        <div class="dashboard-chat-bubble dashboard-chat-bubble-assistant dashboard-chat-bubble-thinking">
          <span class="dashboard-chat-dot"></span>
          <span class="dashboard-chat-dot"></span>
          <span class="dashboard-chat-dot"></span>
        </div>
      </div>
    </div>`);
  }

  return rows.join('');
}

function renderDashboardChatPane() {
  return `<div class="compose-pane dashboard-chat-pane">
    <div class="compose-header">
      <h3>Chat</h3>
      <button class="compose-close" type="button" data-action="close-inline-compose">&times;</button>
    </div>
    <div class="dashboard-chat-toolbar">
      <div class="dashboard-chat-control">
        <label>Agent Tool</label>
        <select id="dashboard-chat-profile" data-action="dashboard-chat-profile">
          <option value="">Loading Agent Tools...</option>
        </select>
      </div>
      <div class="dashboard-chat-control">
        <label>Scope</label>
        <select id="dashboard-chat-project" data-action="dashboard-chat-project">
          <option value="">Loading projects...</option>
        </select>
      </div>
    </div>
    <div class="compose-status dashboard-chat-status" id="dashboard-chat-status"></div>
    <div class="dashboard-chat-transcript" id="dashboard-chat-transcript">${renderDashboardChatTranscriptHtml()}</div>
    <div class="dashboard-chat-composer">
      <textarea id="dashboard-chat-input" rows="4" placeholder="Ask about progress, issues, or delegate work..." data-action="dashboard-chat-input"></textarea>
      <div class="dashboard-chat-actions">
        <div class="dashboard-chat-note">Long-running work will be delegated as an issue instead of being done inline.</div>
        <button class="btn btn-primary" id="dashboard-chat-send" data-action="send-dashboard-chat">Send</button>
      </div>
    </div>
  </div>`;
}

function renderDashboardChatTranscript() {
  const transcript = document.getElementById('dashboard-chat-transcript');
  if (!transcript) return;
  transcript.innerHTML = renderDashboardChatTranscriptHtml();
  transcript.scrollTop = transcript.scrollHeight;
}

function populateDashboardChatProjectOptions() {
  const select = document.getElementById('dashboard-chat-project');
  if (!select) return;
  const projects = Object.values(_dashboardProjectsById || {}).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (_dashboardChatProjectId && !_dashboardProjectsById[_dashboardChatProjectId]) {
    _dashboardChatProjectId = '';
    saveDashboardChatPreferences();
  }
  select.innerHTML = '<option value="">All projects</option>' + projects.map((project) => {
    const remoteSuffix = project.is_remote ? ` · ${project.remote_instance_name || 'remote'}` : '';
    return `<option value="${esc(project.id)}">${esc(project.name)}${esc(remoteSuffix)}</option>`;
  }).join('');
  select.value = _dashboardChatProjectId || '';
}

async function populateDashboardChatProfileOptions() {
  const select = document.getElementById('dashboard-chat-profile');
  if (!select) return;
  const manager = window.HAICOCommandProfiles || null;
  if (manager && typeof manager.ensureLoaded === 'function') {
    await manager.ensureLoaded();
  }
  const profiles = manager && typeof manager.getProfiles === 'function'
    ? manager.getProfiles()
    : [];

  if (profiles.length === 0) {
    _dashboardChatProfileId = '';
    select.innerHTML = '<option value="">Default CLI</option>';
    select.value = '';
    saveDashboardChatPreferences();
    return;
  }

  if (!_dashboardChatProfileId || !profiles.find((profile) => profile.id === _dashboardChatProfileId)) {
    _dashboardChatProfileId = profiles[0].id;
    saveDashboardChatPreferences();
  }

  select.innerHTML = profiles.map((profile) => {
    const label = manager?.formatLabel ? manager.formatLabel(profile) : `${profile.name} (${profile.type})`;
    return `<option value="${esc(profile.id)}">${esc(label)}</option>`;
  }).join('');
  select.value = _dashboardChatProfileId;
}

async function initDashboardChatPane() {
  await Promise.all([
    ensureDashboardProjectsLoaded(),
    populateDashboardChatProfileOptions(),
  ]);
  populateDashboardChatProjectOptions();
  renderDashboardChatTranscript();
  setDashboardChatStatus(_dashboardChatStatus.message, _dashboardChatStatus.type);
  const input = document.getElementById('dashboard-chat-input');
  const sendButton = document.getElementById('dashboard-chat-send');
  if (sendButton) sendButton.disabled = _dashboardChatPending;
  if (input && !_dashboardChatPending) input.focus();
}

async function openDashboardChat() {
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
  detail.innerHTML = renderDashboardChatPane();
  setInboxMobilePane('detail');
  await initDashboardChatPane();
}

function handleDashboardChatProfileChange(value) {
  _dashboardChatProfileId = value || '';
  saveDashboardChatPreferences();
  setDashboardChatStatus('', '');
}

function handleDashboardChatProjectChange(value) {
  _dashboardChatProjectId = value || '';
  saveDashboardChatPreferences();
  setDashboardChatStatus('', '');
}

function handleDashboardChatInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendDashboardChat();
  }
}

function dashboardChatTouchedMutableData(toolCalls) {
  const mutableTools = new Set([
    'create_issue',
    'update_issue',
    'add_issue_comment',
    'delete_issue',
    'create_project_from_request',
    'update_project',
    'delete_project',
    'delegate_task',
  ]);
  return Array.isArray(toolCalls) && toolCalls.some((toolCall) => mutableTools.has(toolCall.tool));
}

async function sendDashboardChat() {
  if (_dashboardChatPending) return;
  const input = document.getElementById('dashboard-chat-input');
  const sendButton = document.getElementById('dashboard-chat-send');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;

  _dashboardChatMessages.push({ role: 'user', content: message });
  _dashboardChatPending = true;
  setDashboardChatStatus('', '');
  input.value = '';
  if (sendButton) sendButton.disabled = true;
  renderDashboardChatTranscript();

  try {
    const res = await fetch('/api/dashboard-chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        message,
        messages: _dashboardChatMessages,
        project_id: _dashboardChatProjectId || null,
        command_profile_id: _dashboardChatProfileId || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Chat request failed');
    }
    if (data.message) {
      _dashboardChatMessages.push({ role: 'assistant', content: data.message });
    }
    if (dashboardChatTouchedMutableData(data.tool_calls)) {
      Promise.allSettled([
        loadDashboardSummary(),
        loadProjects(),
        loadNotifications({ reset: true }),
      ]).catch(() => {});
    }
    setDashboardChatStatus('', '');
  } catch (error) {
    const messageText = error.message || 'Chat request failed';
    _dashboardChatMessages.push({ role: 'assistant', content: messageText });
    setDashboardChatStatus(messageText, 'error');
  } finally {
    _dashboardChatPending = false;
    if (sendButton) sendButton.disabled = false;
    renderDashboardChatTranscript();
    input.focus();
  }
}

function renderMailDetailEmpty() {
  return '<div class="mail-detail-empty"><div class="mail-detail-empty-icon">&#9993;</div><div>Select a message to read</div></div>';
}

function renderInlineComposePane() {
  return `<div class="compose-pane">
    <div class="compose-header">
      <h3>Compose</h3>
      <button class="compose-close" type="button" data-action="close-inline-compose">&times;</button>
    </div>
    <div class="compose-form">
      <div class="compose-field">
        <label>Project</label>
        <select id="global-compose-project" data-action="global-compose-project">
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
      <button class="btn" data-action="close-inline-compose">Cancel</button>
      <button class="btn btn-primary" id="global-compose-send" data-action="send-global-compose">Send</button>
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
      await Promise.all([loadNotifications({ reset: true }), loadProjects({ force: true })]);
    } else {
      const err = await res.json().catch(() => ({}));
      setGlobalComposeStatus(err.error || 'Failed to send message', 'error');
    }
  });
}


function initMailResizer() {
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
}

let _pollInFlight = false;
function startInboxPolling() {
  return setInterval(refreshInboxPage, 10000);
}

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

function showBrowserNotification(newItems) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const titles = newItems.map(i => i.title || `#${i.number}`).slice(0, 3);
  let body = titles.join('\n');
  if (newItems.length > 3) body += `\n...and ${newItems.length - 3} more`;
  try {
    new Notification('HAICO', { body, icon: '/public/brand/haico-mark-square-192.png' });
  } catch (_) { /* silent */ }
}

function syncInboxMobilePane() {
  const panel = getInboxNotificationsPanel();
  if (!panel) return;
  if (!isMobileInboxViewport()) {
    delete panel.dataset.mobilePane;
    return;
  }
  panel.dataset.mobilePane = _inboxMobilePane;
}

function bindInboxEvents() {
  window.addEventListener('resize', syncInboxMobilePane);
  window.addEventListener('haico:command-profiles-changed', () => {
    if (document.getElementById('dashboard-chat-profile')) {
      populateDashboardChatProfileOptions().catch((error) => console.error('Failed to refresh dashboard chat profiles', error));
    }
  });
  document.body.addEventListener('click', (event) => {
    if (event.target === document.getElementById('issueDetailModal')) closeIssuePanel();
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'notif-filter') toggleNotifFilter(actionEl.dataset.filter || 'all');
    else if (action === 'inbox-scope') toggleInboxScope(actionEl.dataset.scope || 'user');
    else if (action === 'open-global-compose') openGlobalCompose();
    else if (action === 'open-dashboard-chat') openDashboardChat();
    else if (action === 'toggle-notifications') toggleNotifications();
    else if (action === 'show-inbox-list') showInboxListPane();
    else if (action === 'close-issue-panel') closeIssuePanel();
    else if (action === 'select-mail-item') selectMailItem(Number(actionEl.dataset.idx || 0));
    else if (action === 'load-more-inbox') loadMoreInbox();
    else if (action === 'close-inline-compose') closeInlineCompose();
    else if (action === 'send-dashboard-chat') sendDashboardChat();
    else if (action === 'send-global-compose') sendGlobalCompose();
  });
  document.body.addEventListener('mouseover', (event) => {
    const item = event.target.closest('[data-action="select-mail-item"]');
    if (item?.dataset.issueId) prefetchIssueDetail(item.dataset.issueId);
  });
  document.getElementById('inbox-project-filter')?.addEventListener('change', (event) => toggleInboxProject(event.target.value));
  document.getElementById('inbox-search')?.addEventListener('input', (event) => filterInbox(event.target.value));
  document.body.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('[data-action="dashboard-chat-profile"]')) handleDashboardChatProfileChange(target.value);
    if (target.matches('[data-action="dashboard-chat-project"]')) handleDashboardChatProjectChange(target.value);
    if (target.matches('[data-action="global-compose-project"]')) updateGlobalComposeRecipients();
  });
  document.body.addEventListener('keydown', (event) => {
    if (event.target.matches('[data-action="dashboard-chat-input"]')) handleDashboardChatInputKeydown(event);
  });
}

async function refreshInboxPage() {
  await Promise.all([loadDashboardSummary(), loadNotifications(), ensureDashboardProjectsLoaded()]);
}

window.addEventListener('haico:user-ready', (event) => {
  _currentUser = event.detail || null;
  ensureDashboardProjectsLoaded().catch(() => {});
});

async function initInboxPage() {
  bindInboxEvents();
  await initDashboardPage('inbox');
  await refreshInboxPage();
  initMailResizer();
  startInboxPolling();
  setupDashboardWS(refreshInboxPage);
}

initInboxPage().catch((error) => {
  console.error('Failed to initialize inbox dashboard', error);
});
