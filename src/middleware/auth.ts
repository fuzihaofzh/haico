import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger';
import { getDatabase } from '../db/database';

const COOKIE_NAME = 'argus-auth';
const CSRF_HEADER = 'x-csrf-token';
const CONFIG_DIR = path.join(os.homedir(), '.argus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SESSION_MAX_AGE_S = 7 * 24 * 3600; // 7 days

// --- Password hashing with scrypt ---

function hashPassword(pwd: string, salt?: string): { hash: string; salt: string } {
  const s = salt || randomBytes(16).toString('hex');
  const derived = scryptSync(pwd, s, 64).toString('hex');
  return { hash: derived, salt: s };
}

function verifyPassword(pwd: string, storedHash: string, salt: string): boolean {
  const { hash } = hashPassword(pwd, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Backward compat: detect old SHA-256 hashes (64 hex chars, no salt)
function isLegacySha256(config: AuthConfig): boolean {
  return !!config.passwordHash && !config.passwordSalt;
}

function legacySha256(pwd: string): string {
  return createHash('sha256').update(pwd).digest('hex');
}

// --- Session store (SQLite-persisted) ---

interface Session {
  token: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

function cleanExpiredSessions(): void {
  try {
    const db = getDatabase();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  } catch (e) {
    logger.error(e, 'Failed to clean expired sessions');
  }
}

// Clean expired sessions on startup
cleanExpiredSessions();

function createSession(): Session {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const now = Date.now();
  const session: Session = {
    token,
    csrfToken,
    createdAt: now,
    expiresAt: now + SESSION_MAX_AGE_S * 1000,
  };
  const db = getDatabase();
  db.prepare('INSERT INTO sessions (token, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, csrfToken, now, session.expiresAt);
  return session;
}

function getSession(token: string): Session | undefined {
  const db = getDatabase();
  const row = db.prepare('SELECT token, csrf_token, created_at, expires_at FROM sessions WHERE token = ?').get(token) as any;
  if (!row) return undefined;
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return undefined;
  }
  return { token: row.token, csrfToken: row.csrf_token, createdAt: row.created_at, expiresAt: row.expires_at };
}

function deleteSession(token: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteAllSessions(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM sessions').run();
}

// --- Config persistence ---

interface AuthConfig {
  passwordHash?: string;
  passwordSalt?: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return cookies;
}

function loadAuthConfig(): AuthConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) { logger.error(e, 'Failed to load auth config'); }
  return {};
}

function saveAuthConfig(config: AuthConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Localhost bypass: only safe (agent-usable) routes ---

const LOCALHOST_SAFE_PREFIXES = [
  '/api/projects',   // project CRUD and sub-resources (issues, agents, etc.)
  '/api/issues/',    // issue CRUD + comments
  '/api/agents/',    // agent status/logs (GET), start/stop (POST)
  '/api/comments/',  // comment editing
  '/api/milestones', // milestone CRUD
  '/api/notifications',
  '/api/reactions/',
];

// Admin-only operations that localhost should NOT bypass
const LOCALHOST_BLOCKED_PATTERNS = [
  // Auth changes from localhost are blocked (must use browser session)
  { method: 'POST', prefix: '/api/auth/' },
  { method: 'GET', prefix: '/api/auth/' },
];

function isLocalhostSafe(method: string, url: string): boolean {
  // Block admin operations even from localhost
  for (const pattern of LOCALHOST_BLOCKED_PATTERNS) {
    if (method === pattern.method && url.startsWith(pattern.prefix)) {
      return false;
    }
  }
  // Allow safe API routes
  for (const prefix of LOCALHOST_SAFE_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }
  // Also allow WebSocket connections for agent terminals
  if (url.startsWith('/ws/')) return true;
  return false;
}

// --- HTML pages ---

const THEME_SCRIPT = `<script>
(function() {
  var themes = {
    'github-dark': { bg:'#0d1117', fg:'#e6edf3', headerBg:'#161b22', border:'#30363d', textSecondary:'#8b949e', accent:'#58a6ff', error:'#f85149' },
    'dracula': { bg:'#282a36', fg:'#f8f8f2', headerBg:'#21222c', border:'#44475a', textSecondary:'#6272a4', accent:'#8be9fd', error:'#ff5555' },
    'nord': { bg:'#2e3440', fg:'#d8dee9', headerBg:'#3b4252', border:'#4c566a', textSecondary:'#81a1c1', accent:'#88c0d0', error:'#bf616a' },
    'monokai': { bg:'#272822', fg:'#f8f8f2', headerBg:'#1e1f1c', border:'#3e3d32', textSecondary:'#75715e', accent:'#66d9ef', error:'#f92672' },
    'solarized-dark': { bg:'#002b36', fg:'#839496', headerBg:'#073642', border:'#586e75', textSecondary:'#657b83', accent:'#268bd2', error:'#dc322f' },
    'solarized-light': { bg:'#fdf6e3', fg:'#073642', headerBg:'#eee8d5', border:'#c9bba3', textSecondary:'#586e75', accent:'#268bd2', error:'#dc322f' }
  };
  var name = null;
  try { name = localStorage.getItem('argus-theme'); } catch(e) {}
  var t = themes[name] || themes['solarized-light'];
  var r = document.documentElement;
  r.style.setProperty('--bg', t.bg);
  r.style.setProperty('--fg', t.fg);
  r.style.setProperty('--header-bg', t.headerBg);
  r.style.setProperty('--border', t.border);
  r.style.setProperty('--text-secondary', t.textSecondary);
  r.style.setProperty('--accent', t.accent);
  r.style.setProperty('--error', t.error);
})();
</script>`;

const PAGE_STYLE = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', Menlo, monospace; background: var(--bg, #0d1117); color: var(--fg, #e6edf3); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: var(--header-bg, #161b22); border: 1px solid var(--border, #30363d); border-radius: 12px; padding: 2rem; width: 100%; max-width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; text-align: center; }
    h1 span { color: var(--accent, #58a6ff); }
    .subtitle { font-size: 0.875rem; color: var(--text-secondary, #8b949e); text-align: center; margin-bottom: 1.5rem; }
    label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; color: var(--text-secondary, #8b949e); }
    input[type="password"] { width: 100%; padding: 0.75rem; border: 1px solid var(--border, #30363d); border-radius: 8px; background: var(--bg, #0d1117); color: var(--fg, #e6edf3); font-size: 1rem; outline: none; margin-bottom: 0.75rem; font-family: inherit; }
    input[type="password"]:focus { border-color: var(--accent, #58a6ff); }
    button { width: 100%; padding: 0.75rem; margin-top: 0.5rem; border: none; border-radius: 8px; background: #238636; color: #fff; font-size: 1rem; cursor: pointer; font-weight: 600; font-family: inherit; }
    button:hover { background: #2ea043; }
    .error { color: var(--error, #f85149); font-size: 0.875rem; margin-top: 0.75rem; text-align: center; display: none; }
    .success { color: var(--accent, #58a6ff); font-size: 0.875rem; margin-top: 0.75rem; text-align: center; display: none; }
`;

const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus — Setup</title>
  <style>${PAGE_STYLE}</style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1><span>Argus</span></h1>
    <p class="subtitle">Set a password to protect your platform</p>
    <form id="form">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Enter password (min 4 chars)" autofocus required>
      <label for="confirm">Confirm password</label>
      <input type="password" id="confirm" name="confirm" placeholder="Confirm password" required>
      <button type="submit">Set Password</button>
      <div class="error" id="error"></div>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) { errEl.textContent = 'Password must be at least 4 characters'; errEl.style.display = 'block'; return; }
      if (password !== confirm) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; return; }
      const res = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.ok) { window.location.href = '/'; } else { const data = await res.json(); errEl.textContent = data.error || 'Setup failed'; errEl.style.display = 'block'; }
    });
  </script>
</body>
</html>`;

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus — Login</title>
  <style>${PAGE_STYLE}</style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1><span>Argus</span></h1>
    <form id="form">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus required>
      <button type="submit">Login</button>
      <div class="error" id="error">Incorrect password</div>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.ok) {
        const data = await res.json();
        if (data.csrfToken) { localStorage.setItem('argus-csrf', data.csrfToken); }
        window.location.href = '/';
      } else { document.getElementById('error').style.display = 'block'; }
    });
  </script>
</body>
</html>`;

const CHANGE_PASSWORD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus — Change Password</title>
  <style>${PAGE_STYLE}</style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1><span>Argus</span></h1>
    <p class="subtitle">Change your password</p>
    <form id="form">
      <label for="current">Current password</label>
      <input type="password" id="current" name="current" autofocus required>
      <label for="password">New password</label>
      <input type="password" id="password" name="password" placeholder="Min 4 characters" required>
      <label for="confirm">Confirm new password</label>
      <input type="password" id="confirm" name="confirm" required>
      <button type="submit">Change Password</button>
      <div class="error" id="error"></div>
      <div class="success" id="success">Password changed successfully</div>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      const successEl = document.getElementById('success');
      errEl.style.display = 'none'; successEl.style.display = 'none';
      const current = document.getElementById('current').value;
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) { errEl.textContent = 'New password must be at least 4 characters'; errEl.style.display = 'block'; return; }
      if (password !== confirm) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; return; }
      const csrf = localStorage.getItem('argus-csrf') || '';
      const res = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ current, password }) });
      if (res.ok) { successEl.style.display = 'block'; document.getElementById('form').reset(); } else { const data = await res.json(); errEl.textContent = data.error || 'Failed'; errEl.style.display = 'block'; }
    });
  </script>
</body>
</html>`;

export function setupAuth(app: FastifyInstance): void {
  let authConfig = loadAuthConfig();

  function checkPassword(pwd: string): boolean {
    if (!authConfig.passwordHash) return false;
    // Handle legacy SHA-256 hashes (auto-migrate on next login)
    if (isLegacySha256(authConfig)) {
      return legacySha256(pwd) === authConfig.passwordHash;
    }
    return verifyPassword(pwd, authConfig.passwordHash, authConfig.passwordSalt!);
  }

  function setPassword(pwd: string): void {
    const { hash, salt } = hashPassword(pwd);
    authConfig = { passwordHash: hash, passwordSalt: salt };
    saveAuthConfig(authConfig);
  }

  // Setup page
  app.get('/setup', async (_req, reply) => {
    if (authConfig.passwordHash) return reply.redirect('/login');
    reply.type('text/html').send(SETUP_HTML);
  });

  // Setup endpoint
  app.post('/api/auth/setup', async (request, reply) => {
    if (authConfig.passwordHash) return reply.status(403).send({ error: 'Password already set' });
    const body = request.body as { password?: string } | null;
    if (!body?.password || body.password.length < 4) {
      return reply.status(400).send({ error: 'Password must be at least 4 characters' });
    }
    setPassword(body.password);
    logger.info('Password has been set');
    const session = createSession();
    reply.header('Set-Cookie', `${COOKIE_NAME}=${session.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`).send({ ok: true, csrfToken: session.csrfToken });
  });

  // Login page
  app.get('/login', async (_req, reply) => {
    if (!authConfig.passwordHash) return reply.redirect('/setup');
    reply.type('text/html').send(LOGIN_HTML);
  });

  // Login endpoint
  app.post('/api/auth', async (request, reply) => {
    if (!authConfig.passwordHash) return reply.status(400).send({ error: 'No password configured' });
    const body = request.body as { password?: string } | null;
    if (body?.password && checkPassword(body.password)) {
      // Auto-migrate legacy SHA-256 to scrypt on successful login
      if (isLegacySha256(authConfig)) {
        setPassword(body.password);
        logger.info('Migrated password hash from SHA-256 to scrypt');
      }
      const session = createSession();
      reply.header('Set-Cookie', `${COOKIE_NAME}=${session.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`).send({ ok: true, csrfToken: session.csrfToken });
    } else {
      reply.status(401).send({ error: 'Invalid password' });
    }
  });

  // Change password page
  app.get('/change-password', async (_req, reply) => {
    reply.type('text/html').send(CHANGE_PASSWORD_HTML);
  });

  // Change password endpoint
  app.post('/api/auth/change-password', async (request, reply) => {
    if (!authConfig.passwordHash) return reply.status(400).send({ error: 'No password configured' });
    const body = request.body as { current?: string; password?: string } | null;
    if (!body?.current || !checkPassword(body.current)) {
      return reply.status(401).send({ error: 'Current password is incorrect' });
    }
    if (!body.password || body.password.length < 4) {
      return reply.status(400).send({ error: 'New password must be at least 4 characters' });
    }
    setPassword(body.password);
    // Invalidate all existing sessions
    deleteAllSessions();
    logger.info('Password has been changed, all sessions invalidated');
    const session = createSession();
    reply.header('Set-Cookie', `${COOKIE_NAME}=${session.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`).send({ ok: true, csrfToken: session.csrfToken });
  });

  // Logout
  app.post('/api/auth/logout', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token) deleteSession(token);
    reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`).send({ ok: true });
  });

  // Session management endpoint
  app.get('/api/auth/sessions', async (request, reply) => {
    const db = getDatabase();
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    const rows = db.prepare('SELECT token, created_at, expires_at FROM sessions WHERE expires_at > ?').all(now) as any[];
    const cookies = parseCookies(request.headers.cookie);
    const currentToken = cookies[COOKIE_NAME];
    const activeSessions = rows.map(row => ({
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      current: row.token === currentToken,
    }));
    return { sessions: activeSessions };
  });

  // CSRF token endpoint (for pages that need it after cookie-based auth)
  app.get('/api/auth/csrf', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];
    const session = token ? getSession(token) : undefined;
    if (!session) return reply.status(401).send({ error: 'Not authenticated' });
    return { csrfToken: session.csrfToken };
  });

  // Auth hook
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;

    // Allow auth routes and favicon
    if (request.method === 'OPTIONS' || url === '/login' || url === '/setup' || url.startsWith('/api/auth') || url === '/favicon.ico') {
      return;
    }

    // Localhost bypass: only for agent-safe routes
    const remoteIp = request.ip;
    const isLocalhost = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    if (isLocalhost && isLocalhostSafe(request.method, url)) {
      return;
    }

    // No password yet -> setup (reload config first to avoid stale state)
    if (!authConfig.passwordHash) {
      authConfig = loadAuthConfig();
    }
    if (!authConfig.passwordHash) {
      if (url.startsWith('/api/') || url.startsWith('/ws')) {
        reply.status(401).send({ error: 'Password not configured. Visit /setup first.' });
      } else {
        reply.redirect('/setup');
      }
      return;
    }

    // Check session cookie
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[COOKIE_NAME];
    const session = sessionToken ? getSession(sessionToken) : undefined;

    if (session) {
      // CSRF check for state-changing requests from browser (cookie auth)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const csrfToken = request.headers[CSRF_HEADER] as string | undefined;
        if (!csrfToken || csrfToken !== session.csrfToken) {
          reply.status(403).send({ error: 'Invalid CSRF token' });
          return;
        }
      }
      return; // authenticated via session
    }

    // Check Authorization: Bearer <session-token> (for programmatic/agent use, no CSRF needed)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);
      if (getSession(bearerToken)) return;
    }

    // Check query token (for WebSocket connections)
    const queryToken = (request.query as Record<string, string>)?.token;
    if (queryToken && getSession(queryToken)) return;

    // Allow static assets and UI page routes — only protect API/WS
    if (url.startsWith('/public/') || url.startsWith('/css/') || url.startsWith('/js/') || url.startsWith('/vendor/')) {
      return;
    }

    // Allow UI page routes (HTML pages) — they load data via API which handles auth
    if (!url.startsWith('/api/') && !url.startsWith('/ws')) {
      return;
    }

    // Unauthenticated API/WS
    reply.status(401).send({ error: 'Unauthorized' });
  });
}
