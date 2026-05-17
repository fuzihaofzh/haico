// ─── User Menu ───

let _currentUser = null;

async function initUserMenu() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-cache' });
    if (!res.ok) {
      console.warn('[HAICO] initUserMenu: /api/auth/me returned', res.status, '— avatar will not show');
      return;
    }
    _currentUser = await res.json();
    window.dispatchEvent(new CustomEvent('haico:user-ready', { detail: _currentUser }));
  } catch (e) {
    console.warn('[HAICO] initUserMenu: fetch failed —', e.message || e);
    return;
  }

  // Append user menu to .header-right if it exists, otherwise to header
  const headerRight = document.querySelector('.header-right') || document.querySelector('header');
  if (!headerRight) return;

  const menu = document.createElement('div');
  menu.className = 'user-menu';
  const initials = (_currentUser.display_name || _currentUser.username || '?').charAt(0).toUpperCase();
  menu.innerHTML = `
    <button class="user-menu-btn" title="${esc(_currentUser.display_name || _currentUser.username)}">${esc(initials)}</button>
    <div class="user-menu-dropdown" id="user-menu-dropdown">
      <div class="user-menu-info">
        <div class="name">${esc(_currentUser.display_name || _currentUser.username)}</div>
        <div class="role">${esc(_currentUser.role)}</div>
      </div>
      ${_currentUser.role === 'admin' ? '<a href="/admin/users">User Management</a>' : ''}
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

function parseRemoteApprovalId(value) {
  const match = /^remote-approval:([^:]+):(.+)$/.exec(decodeRouteParam(value));
  if (!match) return null;
  return { instanceId: match[1], remoteApprovalId: match[2] };
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

function buildProjectPageHref(projectId) {
  return `/projects/${encodeURIComponent(decodeRouteParam(projectId))}`;
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

function buildApprovalApiPath(approvalId) {
  const remote = parseRemoteApprovalId(approvalId);
  if (remote) {
    return `/api/remote-approvals/${encodeURIComponent(remote.instanceId)}/${encodeURIComponent(remote.remoteApprovalId)}`;
  }
  return `/api/approvals/${encodeURIComponent(decodeRouteParam(approvalId))}`;
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
  if (p >= 10) return '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(220,50,47,0.15);color:var(--error)">USER</span>';
  if (p >= 5) return '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(181,137,0,0.15);color:var(--warning)">CTRL</span>';
  return '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(88,110,117,0.15);color:var(--text-secondary)">AGENT</span>';
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
  return '<div class="' + cls + '"><div class="spinner"></div>' + esc(text || 'Loading...') + '</div>';
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
  var retryHtml = onRetryId ? '<button class="retry-btn" onclick="' + onRetryId + '">Retry</button>' : '';
  return '<div class="error-retry"><div class="error-msg">' + esc(msg) + '</div>' + retryHtml + '</div>';
}

function renderCollapsibleText(text, options) {
  const value = text == null ? '' : String(text);
  const opts = options || {};
  const previewChars = Number.isFinite(opts.previewChars) ? opts.previewChars : 120;
  const className = opts.className ? ' ' + opts.className : '';
  const styleAttr = opts.style ? ` style="${opts.style}"` : '';
  const expandLabel = opts.expandLabel || 'Expand';
  const collapseLabel = opts.collapseLabel || 'Collapse';
  const contentHtml = `<span class="collapsible-text__content">${esc(value)}</span>`;
  const needsCollapse = value.length > previewChars || /[\r\n]/.test(value);

  if (!needsCollapse) {
    return `<span class="collapsible-text${className}"${styleAttr}>${contentHtml}</span>`;
  }

  return `<button type="button" class="collapsible-text is-collapsible${className}" data-collapsible-text data-expanded="false" data-expand-label="${esc(expandLabel)}" data-collapse-label="${esc(collapseLabel)}" aria-expanded="false" title="Click to expand"${styleAttr}>${contentHtml}<span class="collapsible-text__hint" aria-hidden="true">${esc(expandLabel)}</span></button>`;
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

// Toast notifications
function showToast(message, type) {
  type = type || 'info';
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  toast.onclick = function() { toast.remove(); };
  container.appendChild(toast);
  setTimeout(function() { toast.remove(); }, 3000);
}

function showConfirm(message, options) {
  const opts = options || {};
  const tone = opts.tone === 'danger' ? 'danger' : 'default';
  const title = opts.title || (tone === 'danger' ? 'Confirm deletion' : 'Confirm action');
  const confirmLabel = opts.confirmLabel || (tone === 'danger' ? 'Delete' : 'Confirm');
  const cancelLabel = opts.cancelLabel || 'Cancel';
  const messageHtml = esc(message || '').replace(/\n/g, '<br>');

  return new Promise(resolve => {
    let overlay = document.getElementById('confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirm-overlay';
      overlay.className = 'modal-overlay confirm-overlay';
      document.body.appendChild(overlay);
    }

    const close = (value) => {
      overlay.classList.remove('active');
      overlay.innerHTML = '';
      overlay.removeEventListener('click', handleOverlayClick);
      document.removeEventListener('keydown', handleKeydown, true);
      resolve(value);
    };

    const handleOverlayClick = (event) => {
      if (event.target === overlay) close(false);
    };

    const handleKeydown = (event) => {
      if (!overlay.classList.contains('active')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const active = document.activeElement;
        const tag = active && active.tagName ? active.tagName.toLowerCase() : '';
        if (tag === 'textarea') return;
        const confirmButton = document.getElementById('confirm-ok');
        if (confirmButton) {
          event.preventDefault();
          confirmButton.click();
        }
      }
    };

    overlay.innerHTML = `<div class="modal confirm-modal confirm-modal-${tone}" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="confirm-modal-header">
        <div class="confirm-modal-eyebrow">${tone === 'danger' ? 'Danger zone' : 'Confirmation'}</div>
        <h3 id="confirm-title" class="confirm-modal-title">${esc(title)}</h3>
      </div>
      <div class="confirm-modal-body">
        <div class="confirm-modal-message">${messageHtml}</div>
      </div>
      <div class="modal-actions confirm-modal-actions">
        <button class="btn btn-sm" id="confirm-cancel" type="button">${esc(cancelLabel)}</button>
        <button class="btn btn-sm ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}" id="confirm-ok" type="button">${esc(confirmLabel)}</button>
      </div>
    </div>`;

    overlay.classList.add('active');
    overlay.addEventListener('click', handleOverlayClick);
    document.addEventListener('keydown', handleKeydown, true);

    const confirmButton = document.getElementById('confirm-ok');
    const cancelButton = document.getElementById('confirm-cancel');
    if (confirmButton) confirmButton.onclick = () => close(true);
    if (cancelButton) cancelButton.onclick = () => close(false);

    requestAnimationFrame(() => {
      if (tone === 'danger' && cancelButton) cancelButton.focus();
      else if (confirmButton) confirmButton.focus();
    });
  });
}

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
  const h = hashCode(name || '?');
  const hue = h % 360;
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
  return `<span class="role-avatar" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${agentColor};color:#fff;font-size:${fontSize}px;font-weight:600;line-height:1;flex-shrink:0;text-transform:uppercase;letter-spacing:-0.5px">${initials}</span>`;
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
    return `<svg width="${size}" height="${size}" viewBox="0 0 5 5"><rect width="5" height="5" rx="0.5" fill="#268bd2"/><circle cx="2.5" cy="1.8" r="0.9" fill="rgba(255,255,255,0.9)"/><ellipse cx="2.5" cy="4.2" rx="1.5" ry="1.2" fill="rgba(255,255,255,0.9)"/></svg>`;
  }
  if (name === 'all' || name === 'All') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 5 5"><rect width="5" height="5" rx="0.5" fill="#859900"/><circle cx="1.5" cy="1.8" r="0.7" fill="rgba(255,255,255,0.85)"/><circle cx="3.5" cy="1.8" r="0.7" fill="rgba(255,255,255,0.85)"/><ellipse cx="2.5" cy="4" rx="2" ry="1" fill="rgba(255,255,255,0.85)"/></svg>`;
  }
  // GitHub-style 5x5 symmetric identicon
  const h = hashCode(name || '?');
  const color = agentHslColor(name);
  // Generate 15 bits for the left half + center column of 5x5 grid (mirrored)
  let bits = h;
  let cells = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((bits >> (y * 3 + x)) & 1) {
        cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
        if (x < 2) cells += `<rect x="${4-x}" y="${y}" width="1" height="1" fill="${color}"/>`;
      }
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="-0.5 -0.5 6 6"><rect x="-0.5" y="-0.5" width="6" height="6" rx="0.8" fill="var(--selected-bg, #eee)"/>${cells}</svg>`;
}

// Themes
const themes = {
  'github-dark':     { bg:'#0d1117', fg:'#e6edf3', headerBg:'#161b22', drawerBg:'#161b22', border:'#30363d', textSecondary:'#8b949e', accent:'#58a6ff', success:'#3fb950', warning:'#d29922', error:'#f85149', selectedBg:'#21262d' },
  'dracula':         { bg:'#282a36', fg:'#f8f8f2', headerBg:'#21222c', drawerBg:'#21222c', border:'#44475a', textSecondary:'#6272a4', accent:'#8be9fd', success:'#50fa7b', warning:'#f1fa8c', error:'#ff5555', selectedBg:'#282a36' },
  'nord-dark':       { bg:'#2e3440', fg:'#d8dee9', headerBg:'#3b4252', drawerBg:'#3b4252', border:'#4c566a', textSecondary:'#81a1c1', accent:'#88c0d0', success:'#a3be8c', warning:'#ebcb8b', error:'#bf616a', selectedBg:'#2e3440' },
  'nord-light':      { bg:'#ECEFF4', fg:'#2E3440', headerBg:'#E5E9F0', drawerBg:'#E5E9F0', border:'#D8DEE9', textSecondary:'#4C566A', accent:'#5E81AC', success:'#A3BE8C', warning:'#EBCB8B', error:'#BF616A', selectedBg:'#D8DEE9' },
  'monokai':         { bg:'#272822', fg:'#f8f8f2', headerBg:'#1e1f1c', drawerBg:'#1e1f1c', border:'#3e3d32', textSecondary:'#75715e', accent:'#66d9ef', success:'#a6e22e', warning:'#e6db74', error:'#f92672', selectedBg:'#272822' },
  'solarized-dark':  { bg:'#002b36', fg:'#839496', headerBg:'#073642', drawerBg:'#073642', border:'#586e75', textSecondary:'#657b83', accent:'#268bd2', success:'#859900', warning:'#b58900', error:'#dc322f', selectedBg:'#002b36' },
  'solarized-light': { bg:'#fdf6e3', fg:'#073642', headerBg:'#eee8d5', drawerBg:'#eee8d5', border:'#c9bba3', textSecondary:'#586e75', accent:'#268bd2', success:'#859900', warning:'#b58900', error:'#dc322f', selectedBg:'#e8dcc8' },
};

function applyTheme(name) {
  // Backward compat: 'nord' was renamed to 'nord-dark'
  if (name === 'nord') { name = 'nord-dark'; localStorage.setItem('haico-theme', name); }
  const t = themes[name] || themes['github-dark'];
  const r = document.documentElement;
  r.style.setProperty('--bg', t.bg);
  r.style.setProperty('--fg', t.fg);
  r.style.setProperty('--header-bg', t.headerBg);
  r.style.setProperty('--drawer-bg', t.drawerBg);
  r.style.setProperty('--border', t.border);
  r.style.setProperty('--text-secondary', t.textSecondary);
  r.style.setProperty('--accent', t.accent);
  r.style.setProperty('--success', t.success);
  r.style.setProperty('--warning', t.warning);
  r.style.setProperty('--error', t.error);
  r.style.setProperty('--selected-bg', t.selectedBg);
}

function changeTheme(name) {
  localStorage.setItem('haico-theme', name);
  applyTheme(name);
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
      // Don't redirect for auth endpoints (login/setup/logout)
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

// Request notification permission
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ─── Notification Sound ───

// Web Audio API notification sound (short "ding")
let _notifAudioCtx = null;
let _notifLastPlayTime = 0;

// Unlock AudioContext on first user interaction (browser autoplay policy)
// Listen on multiple event types to maximize chances of unlocking
function _unlockAudioCtx() {
  if (!_notifAudioCtx) {
    _notifAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_notifAudioCtx.state === 'suspended') {
    _notifAudioCtx.resume();
  }
}
['click', 'keydown', 'touchstart', 'mousedown'].forEach(function(evt) {
  document.addEventListener(evt, _unlockAudioCtx, { once: false, passive: true });
});

function _playDingSound(ctx) {
  var t = ctx.currentTime;
  var osc1 = ctx.createOscillator();
  var osc2 = ctx.createOscillator();
  var gain = ctx.createGain();

  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(880, t);       // A5
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(1175, t + 0.1); // D6

  gain.gain.setValueAtTime(0.3, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(ctx.destination);

  osc1.start(t);
  osc1.stop(t + 0.15);
  osc2.start(t + 0.1);
  osc2.stop(t + 0.4);
}

function playNotificationSound() {
  // Check setting
  if (localStorage.getItem('haico-notification-sound') === 'off') return;

  // Throttle: no more than once per 5 seconds
  var now = Date.now();
  if (now - _notifLastPlayTime < 5000) return;
  _notifLastPlayTime = now;

  // Create AudioContext if needed
  if (!_notifAudioCtx) {
    _notifAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  var ctx = _notifAudioCtx;

  // If suspended, resume first then play after resume completes
  if (ctx.state === 'suspended') {
    ctx.resume().then(function() {
      if (ctx.state === 'running') {
        _playDingSound(ctx);
      }
    });
  } else if (ctx.state === 'running') {
    _playDingSound(ctx);
  }
}

function toggleNotificationSound() {
  const current = localStorage.getItem('haico-notification-sound') !== 'off';
  const newVal = current ? 'off' : 'on';
  localStorage.setItem('haico-notification-sound', newVal);
  // Update all toggles on the page
  document.querySelectorAll('.notif-sound-toggle').forEach(function(el) {
    el.classList.toggle('on', newVal === 'on');
  });
}

// Init notification sound toggles on page load
document.addEventListener('DOMContentLoaded', function() {
  const isOn = localStorage.getItem('haico-notification-sound') !== 'off';
  document.querySelectorAll('.notif-sound-toggle').forEach(function(el) {
    el.classList.toggle('on', isOn);
  });
});

// Init theme
(function() {
  const saved = localStorage.getItem('haico-theme') || 'solarized-light';
  applyTheme(saved);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = saved;
})();

// ─── Project-level WebSocket for real-time updates ───

/**
 * Connect to a project's event stream. Returns an object with .close() and .on(type, cb).
 * Reconnects automatically on disconnect.
 * Event types: agent_status, issue_created, issue_updated, comment_added
 */
function connectProjectEvents(projectId) {
  if (isRemoteProjectId(projectId)) {
    const el = document.getElementById('ws-status-indicator');
    if (el) {
      el.innerHTML = '<span style="font-size:11px;color:var(--text-secondary)">Remote project polling mode</span>';
      el.title = 'Remote project updates are loaded by polling';
    }
    return {
      on: function() {},
      close: function() {},
    };
  }
  const listeners = {};
  let ws = null;
  let closed = false;
  let retryDelay = 1000;
  let serverErrorSeen = false;

  function on(type, cb) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(cb);
  }

  function emit(type, data) {
    (listeners[type] || []).forEach(cb => { try { cb(data); } catch(e) { console.error('WS listener error:', e); } });
    (listeners['*'] || []).forEach(cb => { try { cb({ type, ...data }); } catch(e) {} });
  }

  function updateWsIndicator(state) {
    const el = document.getElementById('ws-status-indicator');
    if (!el) return;
    const colors = { connected: '#3fb950', connecting: '#d29922', disconnected: '#8b949e', error: '#f85149' };
    const labels = { connected: 'Live updates connected', connecting: 'Connecting...', disconnected: 'Live updates disconnected', error: 'Live updates error' };
    el.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${colors[state] || colors.disconnected};margin-right:4px"></span><span style="font-size:11px;color:var(--text-secondary)">${labels[state] || ''}</span>`;
    el.title = labels[state] || '';
  }

  function connect() {
    if (closed) return;
    updateWsIndicator('connecting');
    serverErrorSeen = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/projects/${projectId}/events`);

    ws.onopen = function() { retryDelay = 1000; updateWsIndicator('connected'); };

    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') {
          serverErrorSeen = true;
          updateWsIndicator('error');
          emit('error', msg);
          return;
        }
        if (msg.type) emit(msg.type, msg.data || msg);
      } catch (err) {
        console.warn('WS message parse error:', err);
      }
    };

    ws.onclose = function(e) {
      updateWsIndicator(serverErrorSeen ? 'error' : 'disconnected');
      if (!closed && !serverErrorSeen && e.code !== 1000) {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, 15000);
      }
    };

    ws.onerror = function() { /* onclose will fire */ };
  }

  connect();

  return {
    on: on,
    close: function() { closed = true; if (ws) ws.close(); },
  };
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
      item.innerHTML = `${avatarSvg(agent.name, 18)}<span><strong>${esc(agent.name)}</strong> <span style="color:var(--text-secondary);font-size:11px">${esc(roleText)}</span></span>`;
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
