import { initDashboardPage, loadDashboardProjects, setupDashboardWS } from './dashboard-core.js';
import { playNotificationSound } from '../components/notification-sound.js';

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
    const actionableUnacknowledged = issues.filter(i => i.is_actionable && !i.acknowledged_at);
    const totalCount = typeof data.unread_count === 'number' ? data.unread_count : actionableUnacknowledged.length;

    // Always show the Inbox panel
    document.getElementById('notifications-panel').style.display = '';
    updateInboxBadge(totalCount);

    for (const issue of issues) {
      if (issue.acknowledged_at) {
        _acknowledgedIds.add(issue.id);
      } else if (!_pendingAcks.has(issue.id)) {
        _acknowledgedIds.delete(issue.id);
      }
    }
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
      let displayTime = issue.updated_at;
      let latestPreview = null;
      if (latestComment && latestComment.created_at > issue.updated_at) {
        displayTime = latestComment.created_at;
        latestPreview = latestComment.body;
      }
      const isActionable = !!issue.is_actionable;
      items.push({ type: 'issue', time: displayTime, data: issue, actionRequired: isActionable && !isAcknowledged, latestPreview });
    }
    sortInboxItems(items);

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
          playNotificationSound();
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

  const filtered = [];
  for (const item of items) {
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

  let markup = '';
  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const isSelected = _selectedMailIssueId ? (item.data && item.data.id === _selectedMailIssueId) : (i === _selectedMailIdx);
    const issue = item.data;
    const isUnread = item.actionRequired;
    const project = issue.project_name || '';
    const previewText = (issue.latest_comment_body || item.latestPreview || issue.body || '').replace(/\n/g, ' ').slice(0, 100) + ((issue.latest_comment_body || item.latestPreview || issue.body || '').length > 100 ? '…' : '');
    const displayTime = item.time || issue.updated_at;
    const senderAuthorId = issue.latest_comment_author_id;
    const senderName = issue.latest_comment_author_name;
    const projColor = issue.project_color || '#4A90E2';
    let avatarHtml;
    if (senderName && senderAuthorId !== 'user') {
      avatarHtml = roleAvatarHtml(senderName, 32, projColor);
    } else if (issue.assigned_agent_name && (!senderAuthorId || senderAuthorId === 'user')) {
      avatarHtml = roleAvatarHtml(issue.assigned_agent_name, 32, projColor);
    } else {
      avatarHtml = avatarSvg(senderAuthorId === 'user' || !senderAuthorId ? 'user' : (senderName || senderAuthorId || '?'), 32);
    }
    const stateClass = (isUnread ? ' mail-unread' : '') + (isSelected ? ' mail-selected' : '');
    const subjectBadge = isUnread
      ? h`<span class="mail-item-badge action">!</span>`
      : (!issue.is_actionable ? h`<span class="mail-item-badge sent">Sent</span>` : '');
    markup += h`<div class="mail-item${stateClass}" data-action="select-mail-item" data-idx="${i}" data-issue-id="${issue.id}">
      <span class="mail-item-dot ${isUnread ? 'unread' : 'read'}"></span>
      <div class="mail-item-avatar">${html(avatarHtml)}</div>
      <div class="mail-item-content">
        <div class="mail-item-top">
          <span class="mail-item-from">${project} #${issue.number}</span>
          <span class="mail-item-time">${timeAgo(displayTime) || ''}</span>
        </div>
        <div class="mail-item-subject">${html(subjectBadge)}${issue.title}</div>
        <div class="mail-item-preview">${previewText}</div>
      </div>
    </div>`;
  }

  if (!markup && query) {
    markup = h`<div style="padding:20px;color:var(--text-secondary);font-size:12px;text-align:center">No results</div>`;
  } else if (!markup) {
    markup = h`<div style="padding:20px;color:var(--text-secondary);font-size:12px;text-align:center">No notifications</div>`;
  }

  if (!query && _notifFilter !== 'my' && (_inboxPagination.hasMore || _inboxPagination.loading)) {
    const loaded = Math.min(_inboxAllItems.length, _inboxPagination.total || _inboxAllItems.length);
    const total = _inboxPagination.total || loaded;
    const disabledAttr = _inboxPagination.loading ? h` disabled` : '';
    markup += h`<div class="mail-list-footer">
      <button class="btn btn-sm" data-action="load-more-inbox"${html(disabledAttr)}>
        ${_inboxPagination.loading ? 'Loading...' : 'Load more'}
      </button>
      <span>${loaded} / ${total}</span>
    </div>`;
  }

  body.innerHTML = markup;

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
  if (item.actionRequired && !_acknowledgedIds.has(issue.id)) {
    acknowledgeIssue(issue);
  }
  _currentReplyIssueId = issue.id;
  detail.innerHTML = h`<div style="padding:20px;color:var(--text-secondary);font-size:12px;">Loading issue...</div>`;
  setInboxMobilePane('detail');
  loadInboxIssueDetail(issue.id, idx);
}

async function loadInboxIssueDetail(issueId, expectedIdx, forceRefresh) {
  const inboxItem = _renderedMailItems[expectedIdx];
  const detail = getMailDetailContent();
  const now = Date.now();
  const cached = _issueDetailCache[issueId];

  function isStale() { return _selectedMailIssueId !== issueId; }

  function getProjectColor() {
    var item = _renderedMailItems.find(function(i) { return i.data && i.data.id === issueId; });
    return (item && item.data && item.data.project_color) || null;
  }

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

    if (now - cached.timestamp > ISSUE_CACHE_TTL) {
      loadInboxIssueDetail(issueId, expectedIdx, true);
    }
    return;
  }

  let knownProjectId = null;
  if (inboxItem && inboxItem.data) {
    knownProjectId = inboxItem.data.project_id;
  }

  try {
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

    _issueDetailCache[issueId] = { data: issue, timestamp: now };

    let agents = [];
    if (agentsRes && agentsRes.ok) {
      agents = await agentsRes.json();
      _projectAgentsCache[issue.project_id] = { data: agents, timestamp: now };
    } else {
      const agentsCached = _projectAgentsCache[issue.project_id];
      if (agentsCached) {
        agents = agentsCached.data;
      } else if (!agentsPromise) {
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
    detail.innerHTML = h`<div style="padding:20px;color:var(--text-secondary)">Failed to load issue</div>`;
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
    searchInboxIssues(query.trim());
  } else {
    renderInboxItems(_inboxAllItems);
  }
}

async function searchInboxIssues(query) {
  try {
    const res = await fetch('/api/inbox/search?q=' + encodeURIComponent(query), { headers: apiHeaders() });
    if (!res.ok) return;
    const results = await res.json();
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
  let options = h`<option value="">All Projects</option>`;
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
    const selectedAttr = id === current ? h` selected` : '';
    options += h`<option value="${id}"${html(selectedAttr)}>${label}</option>`;
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
  _acknowledgedIds.add(issueId);
  _pendingAcks.add(issueId);
  const cached = _inboxAllItems.find(i => i.data && i.data.id === issueId);
  if (cached) cached.actionRequired = false;
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
  updateInboxBadge(_inboxUnreadCount - 1);
  try {
    const ackUrl = buildIssueApiPath(issueId, '/acknowledge');
    const res = await fetch(ackUrl, { method: 'POST' });
    if (!res.ok) {
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
  return projects;
}

async function ensureDashboardProjectsLoaded() {
  if (Object.keys(_dashboardProjectsById || {}).length > 0) return Object.values(_dashboardProjectsById);
  return loadProjects();
}

function renderMailDetailEmpty() {
  return h`<div class="mail-detail-empty"><div class="mail-detail-empty-icon">&#9993;</div><div>Select a message to read</div></div>`;
}

function initMailResizer() {
  const resizer = document.getElementById('mail-resizer');
  const listPane = document.getElementById('mail-list-pane');
  const container = document.querySelector('.mail-container');
  if (!resizer || !listPane || !container) return;

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

function startInboxPolling() {
  return setInterval(refreshInboxPage, 10000);
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
  document.body.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'notif-filter') toggleNotifFilter(actionEl.dataset.filter || 'all');
    else if (action === 'inbox-scope') toggleInboxScope(actionEl.dataset.scope || 'user');
    else if (action === 'toggle-notifications') toggleNotifications();
    else if (action === 'show-inbox-list') showInboxListPane();
    else if (action === 'select-mail-item') selectMailItem(Number(actionEl.dataset.idx || 0));
    else if (action === 'load-more-inbox') loadMoreInbox();
  });
  document.body.addEventListener('mouseover', (event) => {
    const item = event.target.closest('[data-action="select-mail-item"]');
    if (item?.dataset.issueId) prefetchIssueDetail(item.dataset.issueId);
  });
  document.getElementById('inbox-project-filter')?.addEventListener('change', (event) => toggleInboxProject(event.target.value));
  document.getElementById('inbox-search')?.addEventListener('input', (event) => filterInbox(event.target.value));
}

async function refreshInboxPage() {
  await Promise.all([loadNotifications(), ensureDashboardProjectsLoaded()]);
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
  console.error('Failed to initialize inbox page', error);
});
