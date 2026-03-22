// Avatars — GitHub-style identicon based on name hash
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

// CSRF token management
let _csrfToken = localStorage.getItem('argus-csrf') || '';

async function fetchCsrfToken() {
  try {
    const res = await fetch('/api/auth/csrf');
    if (res.ok) {
      const data = await res.json();
      _csrfToken = data.csrfToken || '';
      localStorage.setItem('argus-csrf', _csrfToken);
    }
  } catch {}
}

function getCsrfToken() { return _csrfToken; }

// Fetch CSRF token on page load if we have a session
fetchCsrfToken();

// Override fetch to inject CSRF token for non-GET requests
const _originalFetch = window.fetch;
window.fetch = function(input, init) {
  init = init || {};
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers = init.headers || {};
    if (init.headers instanceof Headers) {
      if (!init.headers.has('X-CSRF-Token')) {
        init.headers.set('X-CSRF-Token', getCsrfToken());
      }
    } else if (Array.isArray(init.headers)) {
      if (!init.headers.some(([k]) => k.toLowerCase() === 'x-csrf-token')) {
        init.headers.push(['X-CSRF-Token', getCsrfToken()]);
      }
    } else {
      if (!init.headers['X-CSRF-Token'] && !init.headers['x-csrf-token']) {
        init.headers['X-CSRF-Token'] = getCsrfToken();
      }
    }
  }
  return _originalFetch.call(this, input, init);
};

// Logout
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('argus-csrf');
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

