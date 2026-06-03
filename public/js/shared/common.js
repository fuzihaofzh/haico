// ─── User Menu ───

let _currentUser = null;
let _notificationSoundModulePromise = null;

function loadNotificationSoundModule() {
  if (window.HAICONotificationSound) {
    return Promise.resolve(window.HAICONotificationSound);
  }
  if (!_notificationSoundModulePromise) {
    _notificationSoundModulePromise = import('/public/js/components/notification-sound.js');
  }
  return _notificationSoundModulePromise;
}

function clearHeaderUserSkeleton(root) {
  (root || document).querySelectorAll('.header-user-skeleton').forEach(function(el) {
    el.remove();
  });
}

async function initUserMenu() {
  const headerRight = document.querySelector('.header-right') || document.querySelector('header');
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-cache' });
    if (!res.ok) {
      console.warn('[HAICO] initUserMenu: /api/auth/me returned', res.status, '— avatar will not show');
      clearHeaderUserSkeleton(headerRight || document);
      return;
    }
    _currentUser = await res.json();
    window.dispatchEvent(new CustomEvent('haico:user-ready', { detail: _currentUser }));
  } catch (e) {
    console.warn('[HAICO] initUserMenu: fetch failed —', e.message || e);
    clearHeaderUserSkeleton(headerRight || document);
    return;
  }

  // Append user menu to .header-right if it exists, otherwise to header
  if (!headerRight) {
    clearHeaderUserSkeleton();
    return;
  }
  clearHeaderUserSkeleton(headerRight);

  try {
    const notificationSound = await loadNotificationSoundModule();
    const soundToggle = notificationSound.createNotificationSoundToggle();
    headerRight.appendChild(soundToggle);
    notificationSound.syncNotificationSoundToggles();
  } catch (error) {
    console.warn('[HAICO] initUserMenu: notification sound controls failed —', error.message || error);
  }

  const menu = document.createElement('div');
  menu.className = 'user-menu';
  const initials = (_currentUser.display_name || _currentUser.username || '?').charAt(0).toUpperCase();
  const adminLink = _currentUser.role === 'admin' ? h`<a href="/admin/users">User Management</a>` : '';
  menu.innerHTML = h`
    <button class="user-menu-btn" title="${_currentUser.display_name || _currentUser.username}">${initials}</button>
    <div class="user-menu-dropdown" id="user-menu-dropdown">
      <div class="user-menu-info">
        <div class="name">${_currentUser.display_name || _currentUser.username}</div>
        <div class="role">${_currentUser.role}</div>
      </div>
      ${html(adminLink)}
      <a href="/change-password">Change Password</a>
      <div class="divider"></div>
      <button class="menu-item" onclick="doLogout()">Logout</button>
    </div>
  `;
  headerRight.appendChild(menu);

  const btn = menu.querySelector('.user-menu-btn');
  const dropdown = menu.querySelector('.user-menu-dropdown');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => dropdown.classList.remove('open'));
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

document.addEventListener('DOMContentLoaded', initUserMenu);

// ─── Shared utility functions ───

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function html(value) {
  return { __html: String(value == null ? '' : value) };
}

function h(parts, ...vals) {
  return parts.reduce((acc, part, i) => {
    const value = vals[i];
    if (value == null) return acc + part;
    if (value && value.__html != null) return acc + part + value.__html;
    return acc + part + esc(value);
  }, '');
}

function apiHeaders() {
  return { 'Content-Type': 'application/json' };
}

function decodeRouteParam(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function parseRemoteProjectId(value) {
  const match = /^remote:([^:]+):(.+)$/.exec(decodeRouteParam(value));
  if (!match) return null;
  return { instanceId: match[1], remoteProjectId: match[2] };
}

function parseRemoteIssueId(value) {
  const match = /^remote-issue:([^:]+):(.+)$/.exec(decodeRouteParam(value));
  if (!match) return null;
  return { instanceId: match[1], remoteIssueId: match[2] };
}

function parseRemoteAgentId(value) {
  const match = /^remote-agent:([^:]+):(.+)$/.exec(decodeRouteParam(value));
  if (!match) return null;
  return { instanceId: match[1], remoteAgentId: match[2] };
}

function parseRemoteKnowledgeId(value) {
  const match = /^remote-knowledge:([^:]+):(.+)$/.exec(decodeRouteParam(value));
  if (!match) return null;
  return { instanceId: match[1], remoteKnowledgeId: match[2] };
}

function isRemoteProjectId(value) {
  return !!parseRemoteProjectId(value);
}

function isRemoteIssueId(value) {
  return !!parseRemoteIssueId(value);
}

function isRemoteAgentId(value) {
  return !!parseRemoteAgentId(value);
}

function isRemoteProject(project) {
  return !!(project && (project.is_remote || isRemoteProjectId(project.id)));
}

function isRemoteInboxIssue(issue) {
  return !!(issue && (issue.is_remote || isRemoteIssueId(issue.id)));
}

function buildProjectPageHref(projectId) {
  return `/project/${encodeURIComponent(decodeRouteParam(projectId))}`;
}

function buildProjectApiPath(projectId, suffix) {
  const tail = suffix ? String(suffix) : '';
  const remote = parseRemoteProjectId(projectId);
  if (remote) {
    return `/api/remote-projects/${encodeURIComponent(remote.instanceId)}/${encodeURIComponent(remote.remoteProjectId)}${tail}`;
  }
  return `/api/projects/${encodeURIComponent(decodeRouteParam(projectId))}${tail}`;
}

function buildIssueApiPath(issueId, suffix) {
  const tail = suffix ? String(suffix) : '';
  const remote = parseRemoteIssueId(issueId);
  if (remote) {
    return `/api/remote-issues/${encodeURIComponent(remote.instanceId)}/${encodeURIComponent(remote.remoteIssueId)}${tail}`;
  }
  return `/api/issues/${encodeURIComponent(decodeRouteParam(issueId))}${tail}`;
}

function buildProjectIssueLookupApiPath(projectId, issueNumber) {
  return `${buildProjectApiPath(projectId, '')}/issues/number/${encodeURIComponent(decodeRouteParam(issueNumber))}`;
}

function buildIssuePageHref(params) {
  const issueId = params && params.issueId ? decodeRouteParam(params.issueId) : '';
  const projectId = params && params.projectId ? decodeRouteParam(params.projectId) : '';
  const issueNumber = params && params.issueNumber != null ? decodeRouteParam(params.issueNumber) : '';
  if (issueId && isRemoteIssueId(issueId)) {
    return `/issues/${encodeURIComponent(issueId)}`;
  }
  if (projectId && issueNumber) {
    return `${buildProjectPageHref(projectId)}/issues/${encodeURIComponent(issueNumber)}`;
  }
  if (issueId) {
    return `/issues/${encodeURIComponent(issueId)}`;
  }
  return '#';
}

function buildAgentApiPath(agentId, suffix) {
  const tail = suffix ? String(suffix) : '';
  const remote = parseRemoteAgentId(agentId);
  if (remote) {
    return `/api/remote-agents/${encodeURIComponent(remote.instanceId)}/${encodeURIComponent(remote.remoteAgentId)}${tail}`;
  }
  return `/api/agents/${encodeURIComponent(decodeRouteParam(agentId))}${tail}`;
}

function buildKnowledgeApiPath(knowledgeId) {
  const remote = parseRemoteKnowledgeId(knowledgeId);
  if (remote) {
    return `/api/remote-knowledge/${encodeURIComponent(remote.instanceId)}/${encodeURIComponent(remote.remoteKnowledgeId)}`;
  }
  return `/api/knowledge/${encodeURIComponent(decodeRouteParam(knowledgeId))}`;
}

function buildAgentPageHref(agentId) {
  return `/agents/${encodeURIComponent(decodeRouteParam(agentId))}`;
}

async function withLoading(btn, asyncFn) {
  if (!btn || btn.disabled) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = originalText + '…';
  try {
    await asyncFn();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function parseServerDate(dateStr) {
  if (!dateStr) return null;
  const value = String(dateStr).trim();
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLocalDateTime(dateStr) {
  const date = parseServerDate(dateStr);
  if (!date) return '-';
  return date.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatLocalTime(dateStr) {
  const date = parseServerDate(dateStr);
  if (!date) return '-';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '-';
  const now = Date.now();
  const thenDate = parseServerDate(dateStr);
  if (!thenDate) return '-';
  const then = thenDate.getTime();
  const diff = now - then;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

function priorityBadge(p) {
  if (p >= 10) return h`<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(220,50,47,0.15);color:var(--error)">USER</span>`;
  if (p >= 5) return h`<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(181,137,0,0.15);color:var(--warning)">CTRL</span>`;
  return h`<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(88,110,117,0.15);color:var(--text-secondary)">AGENT</span>`;
}

// nameOf resolves agent IDs to names. Uses the global `agentsData` array if available.
function nameOf(id) {
  if (id === 'user') return 'User';
  if (id === 'all') return 'All';
  if (typeof agentsData !== 'undefined') {
    const a = agentsData.find(x => x.id === id);
    if (a) return a.name;
  }
  return (id || '').slice(0, 8);
}

// ─── Loading & Error helpers ───

function renderLoading(text, small) {
  var cls = 'loading-spinner' + (small ? ' small' : '');
  return h`<div class="${cls}"><div class="spinner"></div>${text || 'Loading...'}</div>`;
}

function renderError(err, onRetryId) {
  var msg = 'Failed to load';
  if (err) {
    if (typeof err === 'string') msg = err;
    else if (err.status === 0 || err.message === 'Failed to fetch') msg = 'Network error, please check your connection';
    else if (err.status >= 500) msg = 'Server error, please try again later';
    else if (err.status >= 400) msg = 'Request failed (resource not found or no permission)';
    else if (err.message) msg = err.message;
  }
  var retryHtml = onRetryId ? h`<button class="retry-btn" onclick="${onRetryId}">Retry</button>` : '';
  return h`<div class="error-retry"><div class="error-msg">${msg}</div>${html(retryHtml)}</div>`;
}

function renderCollapsibleText(text, options) {
  const value = text == null ? '' : String(text);
  const opts = options || {};
  const previewChars = Number.isFinite(opts.previewChars) ? opts.previewChars : 120;
  const className = opts.className ? ' ' + opts.className : '';
  const styleAttr = opts.style ? h` style="${opts.style}"` : '';
  const expandLabel = opts.expandLabel || 'Expand';
  const collapseLabel = opts.collapseLabel || 'Collapse';
  const contentHtml = h`<span class="collapsible-text__content">${value}</span>`;
  const needsCollapse = value.length > previewChars || /[\r\n]/.test(value);

  if (!needsCollapse) {
    return h`<span class="collapsible-text${className}"${html(styleAttr)}>${html(contentHtml)}</span>`;
  }

  return h`<button type="button" class="collapsible-text is-collapsible${className}" data-collapsible-text data-expanded="false" data-expand-label="${expandLabel}" data-collapse-label="${collapseLabel}" aria-expanded="false" title="Click to expand"${html(styleAttr)}>${html(contentHtml)}<span class="collapsible-text__hint" aria-hidden="true">${expandLabel}</span></button>`;
}

document.addEventListener('click', function(e) {
  const trigger = e.target.closest('[data-collapsible-text]');
  if (!trigger) return;
  const expanded = trigger.getAttribute('data-expanded') === 'true';
  const nextExpanded = !expanded;
  trigger.setAttribute('data-expanded', nextExpanded ? 'true' : 'false');
  trigger.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
  trigger.title = nextExpanded ? 'Click to collapse' : 'Click to expand';
  const hint = trigger.querySelector('.collapsible-text__hint');
  if (hint) {
    hint.textContent = trigger.getAttribute(nextExpanded ? 'data-collapse-label' : 'data-expand-label') || (nextExpanded ? 'Collapse' : 'Expand');
  }
});

// ─── Keyboard shortcuts ───

// ESC to close modals
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    // Close the topmost open modal-overlay
    const modals = document.querySelectorAll('.modal-overlay.active');
    if (modals.length > 0) {
      modals[modals.length - 1].classList.remove('active');
      e.preventDefault();
      return;
    }
    // Close drawer if open
    const drawer = document.getElementById('drawer');
    if (drawer && drawer.classList.contains('open')) {
      closeDrawer();
      e.preventDefault();
    }
  }
});

// Click overlay background to close modal
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('active')) {
    e.target.classList.remove('active');
  }
});

// Ctrl+Enter to submit forms
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const el = e.target;
    // Check if inside a modal — find the submit button
    const modal = el.closest('.modal-overlay.active');
    if (modal) {
      const submitBtn = modal.querySelector('.btn-primary');
      if (submitBtn) { submitBtn.click(); e.preventDefault(); return; }
    }
    // Comment input on issue page
    if (el.id === 'ir-comment-input') {
      const submitBtn = document.querySelector('button[onclick="IssueRenderer.addComment()"]');
      if (submitBtn) { submitBtn.click(); e.preventDefault(); }
    }
  }
});

// ─── Avatars — GitHub-style identicon based on name hash ───
// Generate a unique color per agent name using HSL hue rotation (avoids hash collisions with fixed arrays)
function agentHslColor(name) {
  const hash = hashCode(name || '?');
  const hue = hash % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

// Project color presets
const PROJECT_COLORS = ['#4A90E2','#50C878','#9B59B6','#E67E22','#E74C3C','#1ABC9C','#E91E8A','#8D6E63','#607D8B','#F1C40F'];

// Role → emoji icon mapping
const ROLE_ICON_MAP = [
  { keywords: ['controller', 'manager', 'coordinator', 'lead'], icon: '👑' },
  { keywords: ['developer', 'dev', 'coder', 'engineer', 'programmer'], icon: '💻' },
  { keywords: ['tester', 'qa', 'quality', 'test'], icon: '🧪' },
  { keywords: ['product', 'pm', 'planner'], icon: '📋' },
  { keywords: ['writer', 'docs', 'document', 'technical writer'], icon: '✏️' },
  { keywords: ['assistant', 'helper'], icon: '🤖' },
  { keywords: ['analyst', 'data', 'research'], icon: '📊' },
  { keywords: ['design', 'ui', 'ux'], icon: '🎨' },
  { keywords: ['security', 'sec'], icon: '🛡️' },
  { keywords: ['ops', 'devops', 'infra', 'deploy'], icon: '⚙️' },
];

function getAgentRoleIcon(role) {
  if (!role) return '👤';
  const lower = role.toLowerCase();
  for (const entry of ROLE_ICON_MAP) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) return entry.icon;
    }
  }
  return '👤';
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// GitHub-style letter avatar: circle with hash-based color + initials
function roleAvatarHtml(name, size, bgColor) {
  size = size || 28;
  // Use agent name hash to pick a unique color via HSL hue rotation
  const agentColor = agentHslColor(name);
  const initials = getNameInitials(name || '?');
  const fontSize = Math.round(size * 0.4);
  return h`<span class="role-avatar" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${agentColor};color:#fff;font-size:${fontSize}px;font-weight:600;line-height:1;flex-shrink:0;text-transform:uppercase;letter-spacing:-0.5px">${initials}</span>`;
}

function getNameInitials(name) {
  if (!name || name === '?') return '?';
  // Take the last segment after '-' (the role suffix) and use its first 2 letters
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return name.charAt(0).toUpperCase();
  return lastPart.substring(0, 2).toUpperCase();
}

function avatarSvg(name, size) {
  size = size || 28;
  if (name === 'user' || name === 'User') {
    // User: fixed person silhouette
    return h`<svg width="${size}" height="${size}" viewBox="0 0 5 5"><rect width="5" height="5" rx="0.5" fill="#268bd2"/><circle cx="2.5" cy="1.8" r="0.9" fill="rgba(255,255,255,0.9)"/><ellipse cx="2.5" cy="4.2" rx="1.5" ry="1.2" fill="rgba(255,255,255,0.9)"/></svg>`;
  }
  if (name === 'all' || name === 'All') {
    return h`<svg width="${size}" height="${size}" viewBox="0 0 5 5"><rect width="5" height="5" rx="0.5" fill="#859900"/><circle cx="1.5" cy="1.8" r="0.7" fill="rgba(255,255,255,0.85)"/><circle cx="3.5" cy="1.8" r="0.7" fill="rgba(255,255,255,0.85)"/><ellipse cx="2.5" cy="4" rx="2" ry="1" fill="rgba(255,255,255,0.85)"/></svg>`;
  }
  // GitHub-style 5x5 symmetric identicon
  const hash = hashCode(name || '?');
  const color = agentHslColor(name);
  // Generate 15 bits for the left half + center column of 5x5 grid (mirrored)
  let bits = hash;
  let cells = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((bits >> (y * 3 + x)) & 1) {
        cells += h`<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
        if (x < 2) cells += h`<rect x="${4-x}" y="${y}" width="1" height="1" fill="${color}"/>`;
      }
    }
  }
  return h`<svg width="${size}" height="${size}" viewBox="-0.5 -0.5 6 6"><rect x="-0.5" y="-0.5" width="6" height="6" rx="0.8" fill="var(--selected-bg, #eee)"/>${html(cells)}</svg>`;
}

// Drawer
function toggleDrawer() {
  const drawer = document.getElementById('drawer');
  if (!drawer) return;
  const isOpen = drawer.classList.contains('open');
  if (isOpen) { closeDrawer(); } else { openDrawer(); }
}

function openDrawer() {
  const drawer = document.getElementById('drawer');
  const overlay = document.getElementById('overlay');
  if (drawer) drawer.classList.add('open');
  if (overlay) overlay.classList.add('open');
}

function closeDrawer() {
  const drawer = document.getElementById('drawer');
  const overlay = document.getElementById('overlay');
  if (drawer) drawer.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

// Override fetch — on 401 API response, redirect to /login
const _originalFetch = window.fetch;
window.fetch = function(input, init) {
  return _originalFetch.call(this, input, init).then(function(resp) {
    if (resp.status === 401) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      // Don't redirect for auth endpoints (login/register/logout)
      if (url.indexOf('/api/auth') === -1) {
        window.location.href = '/login';
      }
    }
    return resp;
  });
};

// Logout
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ─── Project-level WebSocket for real-time updates ───

function updateProjectEventsIndicator(state) {
  const el = document.getElementById('ws-status-indicator');
  if (!el) return;
  const colors = { connected: '#3fb950', connecting: '#d29922', disconnected: '#8b949e', error: '#f85149' };
  const labels = { connected: 'Live updates connected', connecting: 'Connecting...', disconnected: 'Live updates disconnected', error: 'Live updates error' };
  el.innerHTML = h`<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${colors[state] || colors.disconnected};margin-right:4px"></span><span style="font-size:11px;color:var(--text-secondary)">${labels[state] || ''}</span>`;
  el.title = labels[state] || '';
}

function connectProjectEventsDirect(projectId) {
  const listeners = {};
  let ws = null;
  let closed = false;
  let retryDelay = 1000;
  let serverErrorSeen = false;

  function on(type, cb) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(cb);
    return api;
  }

  function emit(type, data) {
    (listeners[type] || []).forEach(cb => { try { cb(data); } catch(e) { console.error('WS listener error:', e); } });
    (listeners['*'] || []).forEach(cb => {
      try {
        const payload = data && typeof data === 'object' ? Object.assign({ type: type }, data) : { type: type, data: data };
        cb(payload);
      } catch(e) {}
    });
  }

  function connect() {
    if (closed) return;
    updateProjectEventsIndicator('connecting');
    serverErrorSeen = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/projects/${encodeURIComponent(projectId)}/events`);

    ws.onopen = function() { retryDelay = 1000; updateProjectEventsIndicator('connected'); };

    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') {
          serverErrorSeen = true;
          updateProjectEventsIndicator('error');
          emit('error', msg);
          return;
        }
        if (msg.type) emit(msg.type, msg.data || msg);
      } catch (err) {
        console.warn('WS message parse error:', err);
      }
    };

    ws.onclose = function(e) {
      updateProjectEventsIndicator(serverErrorSeen ? 'error' : 'disconnected');
      if (!closed && !serverErrorSeen && e.code !== 1000) {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(Math.round(retryDelay * 1.5), 15000);
      }
    };

    ws.onerror = function() { /* onclose will fire */ };
  }

  const api = {
    on: on,
    close: function() { closed = true; if (ws) ws.close(); },
  };
  connect();
  return api;
}

/**
 * Connect to a project's event stream. Returns an object with .close() and .on(type, cb).
 * Uses the SharedWorker-backed client when available and falls back to direct WebSocket.
 * Event types are defined by src/realtime/protocol.ts and include project events
 * for agents, issues, comments, and executive summaries.
 */
function connectProjectEvents(projectId) {
  if (isRemoteProjectId(projectId)) {
    const el = document.getElementById('ws-status-indicator');
    if (el) {
      el.innerHTML = h`<span style="font-size:11px;color:var(--text-secondary)">Remote project polling mode</span>`;
      el.title = 'Remote project updates are loaded by polling';
    }
    return {
      on: function() {},
      close: function() {},
    };
  }

  if (window.HAICOProjectEventsClient && typeof window.HAICOProjectEventsClient.connect === 'function') {
    return window.HAICOProjectEventsClient.connect(projectId, {
      onStatus: updateProjectEventsIndicator,
    });
  }

  return connectProjectEventsDirect(projectId);
}

// ─── @mention autocomplete for textareas ───
// Usage: setupMentionAutocomplete(textareaElement, agentsArray)
// agentsArray: [{name, role, ...}, ...]
function setupMentionAutocomplete(textarea, agents) {
  if (!textarea || textarea._mentionSetup) return;
  textarea._mentionSetup = true;

  let dropdown = null;
  let mentionStart = -1;
  let selectedIdx = 0;
  let blurTimeout = null;

  function removeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    selectedIdx = 0;
  }

  function cancelMention() {
    removeDropdown();
    mentionStart = -1;
  }

  function getCaretPixelPos() {
    // Use a mirror element to measure caret position within textarea
    const mirror = document.createElement('div');
    const style = getComputedStyle(textarea);
    ['font', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing',
     'padding', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom',
     'border', 'borderWidth', 'boxSizing', 'whiteSpace', 'wordWrap', 'wordBreak', 'overflowWrap'
    ].forEach(p => { mirror.style[p] = style[p]; });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    mirror.style.width = style.width;
    mirror.style.height = 'auto';

    const textBefore = textarea.value.substring(0, textarea.selectionStart);
    const textNode = document.createTextNode(textBefore);
    const span = document.createElement('span');
    span.textContent = '\u200b'; // zero-width space as caret marker
    mirror.appendChild(textNode);
    mirror.appendChild(span);
    document.body.appendChild(mirror);

    const textareaRect = textarea.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();

    const top = textareaRect.top + (spanRect.top - mirrorRect.top) - textarea.scrollTop;
    const left = textareaRect.left + (spanRect.left - mirrorRect.left) - textarea.scrollLeft;
    mirror.remove();
    return { top, left };
  }

  function showDropdown(items) {
    removeDropdown();
    if (items.length === 0) return;
    dropdown = document.createElement('div');
    dropdown.className = 'mention-dropdown';
    dropdown.style.cssText = 'position:fixed;z-index:300;background:var(--header-bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-height:200px;overflow-y:auto;min-width:200px;';

    const coords = getCaretPixelPos();
    dropdown.style.top = (coords.top + 22) + 'px';
    dropdown.style.left = coords.left + 'px';

    items.forEach((agent, i) => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px;';
      if (i === selectedIdx) item.style.background = 'var(--selected-bg)';
      const roleText = (agent.role || '').slice(0, 30);
      item.innerHTML = h`${html(avatarSvg(agent.name, 18))}<span><strong>${agent.name}</strong> <span style="color:var(--text-secondary);font-size:11px">${roleText}</span></span>`;
      item.onmouseenter = () => { selectedIdx = i; updateSelection(); };
      item.onmousedown = (e) => { e.preventDefault(); selectItem(agent.name); };
      dropdown.appendChild(item);
    });
    document.body.appendChild(dropdown);
  }

  function updateSelection() {
    if (!dropdown) return;
    const children = dropdown.children;
    for (let i = 0; i < children.length; i++) {
      children[i].style.background = i === selectedIdx ? 'var(--selected-bg)' : '';
    }
    // Scroll selected into view
    if (children[selectedIdx]) children[selectedIdx].scrollIntoView({ block: 'nearest' });
  }

  function selectItem(name) {
    // Cancel any pending blur timeout to prevent race condition
    if (blurTimeout) { clearTimeout(blurTimeout); blurTimeout = null; }

    // Recalculate mention position from current textarea state for robustness.
    // mentionStart may be stale if a blur/cancelMention fired between input and selection.
    const cursorPos = textarea.selectionStart;
    const textBefore = textarea.value.substring(0, cursorPos);
    const reMatch = textBefore.match(/(?:^|[\s])@([\w-]*)$/);
    const atPos = reMatch
      ? textBefore.length - reMatch[0].length + (reMatch[0].startsWith('@') ? 0 : 1)
      : mentionStart;

    if (atPos < 0 || atPos > textarea.value.length) {
      removeDropdown();
      return;
    }

    const before = textarea.value.substring(0, atPos);
    const after = textarea.value.substring(cursorPos);
    textarea.value = before + '@' + name + ' ' + after;
    const newPos = atPos + name.length + 2;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    mentionStart = -1;
    removeDropdown();
  }

  function getFilteredAgents(query) {
    if (!query) return agents.slice();
    const q = query.toLowerCase();
    return agents.filter(a => a.name.toLowerCase().includes(q));
  }

  textarea.addEventListener('input', () => {
    if (blurTimeout) { clearTimeout(blurTimeout); blurTimeout = null; }
    const pos = textarea.selectionStart;
    const text = textarea.value.substring(0, pos);
    const match = text.match(/(?:^|[\s])@([\w-]*)$/);
    if (match) {
      selectedIdx = 0;
      showDropdown(getFilteredAgents(match[1]));
      mentionStart = text.length - match[0].length + (match[0].startsWith('@') ? 0 : 1);
    } else {
      cancelMention();
    }
  });

  textarea.addEventListener('keydown', (e) => {
    if (!dropdown) return;
    const items = dropdown.children;
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = (selectedIdx + 1) % items.length;
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = (selectedIdx - 1 + items.length) % items.length;
      updateSelection();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      // Recalculate query from current textarea state (don't rely on mentionStart alone)
      const curPos = textarea.selectionStart;
      const txtBefore = textarea.value.substring(0, curPos);
      const km = txtBefore.match(/(?:^|[\s])@([\w-]*)$/);
      const query = km ? km[1] : textarea.value.substring(mentionStart + 1, curPos);
      const filtered = getFilteredAgents(query);
      if (filtered[selectedIdx]) selectItem(filtered[selectedIdx].name);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelMention();
    }
  });

  textarea.addEventListener('blur', () => {
    blurTimeout = setTimeout(cancelMention, 200);
  });
}
