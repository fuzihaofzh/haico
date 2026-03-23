// ─── Shared utility functions ───

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function apiHeaders() {
  return { 'Content-Type': 'application/json' };
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

function timeAgo(dateStr) {
  if (!dateStr) return '-';
  const now = Date.now();
  const then = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z')).getTime();
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
    if (el.id === 'comment-input') {
      const submitBtn = document.querySelector('button[onclick="addComment()"]');
      if (submitBtn) { submitBtn.click(); e.preventDefault(); }
    }
  }
});

// ─── Avatars — GitHub-style identicon based on name hash ───
const AVATAR_COLORS = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#be5046','#d19a66','#7ec8e3','#b5bd68','#cc6666','#8abeb7','#f0c674','#81a2be','#b294bb'];

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
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
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
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
  'nord':            { bg:'#2e3440', fg:'#d8dee9', headerBg:'#3b4252', drawerBg:'#3b4252', border:'#4c566a', textSecondary:'#81a1c1', accent:'#88c0d0', success:'#a3be8c', warning:'#ebcb8b', error:'#bf616a', selectedBg:'#2e3440' },
  'monokai':         { bg:'#272822', fg:'#f8f8f2', headerBg:'#1e1f1c', drawerBg:'#1e1f1c', border:'#3e3d32', textSecondary:'#75715e', accent:'#66d9ef', success:'#a6e22e', warning:'#e6db74', error:'#f92672', selectedBg:'#272822' },
  'solarized-dark':  { bg:'#002b36', fg:'#839496', headerBg:'#073642', drawerBg:'#073642', border:'#586e75', textSecondary:'#657b83', accent:'#268bd2', success:'#859900', warning:'#b58900', error:'#dc322f', selectedBg:'#002b36' },
  'solarized-light': { bg:'#fdf6e3', fg:'#073642', headerBg:'#eee8d5', drawerBg:'#eee8d5', border:'#c9bba3', textSecondary:'#586e75', accent:'#268bd2', success:'#859900', warning:'#b58900', error:'#dc322f', selectedBg:'#e8dcc8' },
};

function applyTheme(name) {
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
  localStorage.setItem('argus-theme', name);
  applyTheme(name);
}

// Drawer
function toggleDrawer() {
  const drawer = document.getElementById('drawer');
  const overlay = document.getElementById('overlay');
  const isOpen = drawer.classList.contains('open');
  if (isOpen) { closeDrawer(); } else { openDrawer(); }
}

function openDrawer() {
  document.getElementById('drawer').classList.add('open');
  document.getElementById('overlay').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

// Override fetch with global 401 handling
const _originalFetch = window.fetch;
window.fetch = function(input, init) {
  return _originalFetch.call(this, input, init).then(function(response) {
    if (response.status === 401) {
      const reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      if (!reqUrl.startsWith('/api/auth')) {
        window.location.href = '/login';
      }
    }
    return response;
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

// Init theme
(function() {
  const saved = localStorage.getItem('argus-theme') || 'solarized-light';
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
  const listeners = {};
  let ws = null;
  let closed = false;
  let retryDelay = 1000;

  function on(type, cb) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(cb);
  }

  function emit(type, data) {
    (listeners[type] || []).forEach(cb => { try { cb(data); } catch(e) { console.error('WS listener error:', e); } });
    (listeners['*'] || []).forEach(cb => { try { cb({ type, ...data }); } catch(e) {} });
  }

  function connect() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/projects/${projectId}/events`);

    ws.onopen = function() { retryDelay = 1000; };

    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type) emit(msg.type, msg.data || msg);
      } catch {}
    };

    ws.onclose = function() {
      if (!closed) {
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

