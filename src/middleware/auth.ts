import { createHash, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger';
import { User } from '../types';

const COOKIE_NAME = 'argus-auth';
const CONFIG_DIR = path.join(os.homedir(), '.argus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

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
    const { getDatabase } = require('../db/database');
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'auth'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value);
  } catch (e) {
    logger.error(e, 'Failed to load auth config from database');
  }
  // Fallback: try legacy file config and migrate
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (config.passwordHash) {
        logger.info('Migrating auth config from file to database');
        saveAuthConfig(config);
        return config;
      }
    }
  } catch {}
  return {};
}

function saveAuthConfig(config: AuthConfig): void {
  try {
    const { getDatabase } = require('../db/database');
    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auth', ?)").run(JSON.stringify(config));
  } catch (e) {
    logger.error(e, 'Failed to save auth config to database');
  }
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
  '/api/inbox',
  '/api/knowledge/',
  '/api/my-issues',
];

// Admin-only operations that localhost should NOT bypass
const LOCALHOST_BLOCKED_PATTERNS = [
  { method: 'POST', prefix: '/api/auth/' },
  { method: 'GET', prefix: '/api/auth/' },
];

function isLocalhostSafe(method: string, url: string): boolean {
  for (const pattern of LOCALHOST_BLOCKED_PATTERNS) {
    if (method === pattern.method && url.startsWith(pattern.prefix)) {
      return false;
    }
  }
  for (const prefix of LOCALHOST_SAFE_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }
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
  <style>${PAGE_STYLE}
    input[type="text"] { width: 100%; padding: 0.75rem; border: 1px solid var(--border, #30363d); border-radius: 8px; background: var(--bg, #0d1117); color: var(--fg, #e6edf3); font-size: 1rem; outline: none; margin-bottom: 0.75rem; font-family: inherit; }
    input[type="text"]:focus { border-color: var(--accent, #58a6ff); }
  </style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1><span>Argus</span></h1>
    <form id="form">
      <div id="username-field">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" autofocus required>
      </div>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Login</button>
      <div class="error" id="error"></div>
      <p style="text-align:center;margin-top:1rem;font-size:0.875rem;color:var(--text-secondary,#8b949e)">Don't have an account? <a href="/register" style="color:var(--accent,#58a6ff)">Register</a></p>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      errEl.style.display = 'none';
      const username = document.getElementById('username')?.value;
      const password = document.getElementById('password').value;
      // Try multi-user login first
      if (username) {
        const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        if (res.ok) { window.location.href = '/'; return; }
      }
      // Fallback: legacy single-password login
      const res2 = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res2.ok) { window.location.href = '/'; return; }
      errEl.textContent = 'Invalid username or password';
      errEl.style.display = 'block';
    });
  </script>
</body>
</html>`;

const REGISTER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus — Register</title>
  <style>${PAGE_STYLE}</style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1><span>Argus</span></h1>
    <p class="subtitle">Create your account</p>
    <form id="form">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" placeholder="2-32 characters" autofocus required style="width:100%;padding:0.75rem;border:1px solid var(--border,#30363d);border-radius:8px;background:var(--bg,#0d1117);color:var(--fg,#e6edf3);font-size:1rem;outline:none;margin-bottom:0.75rem;font-family:inherit;">
      <label for="display_name">Display Name (optional)</label>
      <input type="text" id="display_name" name="display_name" style="width:100%;padding:0.75rem;border:1px solid var(--border,#30363d);border-radius:8px;background:var(--bg,#0d1117);color:var(--fg,#e6edf3);font-size:1rem;outline:none;margin-bottom:0.75rem;font-family:inherit;">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Min 4 characters" required>
      <label for="confirm">Confirm Password</label>
      <input type="password" id="confirm" name="confirm" required>
      <button type="submit">Register</button>
      <div class="error" id="error"></div>
      <p style="text-align:center;margin-top:1rem;font-size:0.875rem;color:var(--text-secondary)">Already have an account? <a href="/login" style="color:var(--accent)">Login</a></p>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      const username = document.getElementById('username').value;
      const display_name = document.getElementById('display_name').value;
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) { errEl.textContent = 'Password must be at least 4 characters'; errEl.style.display = 'block'; return; }
      if (password !== confirm) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; return; }
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, display_name: display_name || undefined }) });
      if (res.ok) { window.location.href = '/'; } else { const data = await res.json(); errEl.textContent = data.error || 'Registration failed'; errEl.style.display = 'block'; }
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
      const res = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, password }) });
      if (res.ok) { successEl.style.display = 'block'; document.getElementById('form').reset(); } else { const data = await res.json(); errEl.textContent = data.error || 'Failed'; errEl.style.display = 'block'; }
    });
  </script>
</body>
</html>`;

/**
 * Simplified auth: cookie stores passwordHash directly, no server-side sessions.
 * Follows the same pattern as swarmie for maximum reliability.
 */
export function setupAuth(app: FastifyInstance): void {
  let authConfig = loadAuthConfig();

  function checkPassword(pwd: string): boolean {
    if (!authConfig.passwordHash) return false;
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

  function setAuthCookie(reply: FastifyReply): void {
    reply.header('Set-Cookie', `${COOKIE_NAME}=${authConfig.passwordHash}; HttpOnly; Path=/; SameSite=Lax`);
  }

  function isValidToken(token: string): boolean {
    return !!authConfig.passwordHash && token === authConfig.passwordHash;
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
    setAuthCookie(reply);
    reply.send({ ok: true });
  });

  // Register page
  app.get('/register', async (_req, reply) => {
    reply.type('text/html').send(REGISTER_HTML);
  });

  // Login page
  app.get('/login', async (_req, reply) => {
    if (!authConfig.passwordHash) {
      // Check if multi-user mode has users
      let hasUsers = false;
      try {
        const { getDatabase } = require('../db/database');
        const db = getDatabase();
        hasUsers = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c > 0;
      } catch {}
      if (!hasUsers) return reply.redirect('/register');
    }
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
      setAuthCookie(reply);
      reply.send({ ok: true, token: authConfig.passwordHash });
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
    logger.info('Password has been changed');
    setAuthCookie(reply);
    reply.send({ ok: true });
  });

  // Logout
  app.post('/api/auth/logout', async (request, reply) => {
    // Clean up session token from DB
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token) {
      try {
        const { getDatabase } = require('../db/database');
        const db = getDatabase();
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      } catch {}
    }
    reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`).send({ ok: true });
  });

  // --- Multi-user API ---

  // Register user (first user becomes admin)
  app.post('/api/auth/register', async (request, reply) => {
    const body = request.body as { username?: string; email?: string; password?: string; display_name?: string } | null;
    if (!body?.username || !body?.password) {
      return reply.status(400).send({ error: 'username and password are required' });
    }
    if (body.password.length < 4) {
      return reply.status(400).send({ error: 'Password must be at least 4 characters' });
    }
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(body.username)) {
      return reply.status(400).send({ error: 'Username must be 2-32 characters (letters, numbers, -, _)' });
    }

    const { getDatabase } = require('../db/database');
    const db = getDatabase();

    // Check if username exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(body.username);
    if (existing) return reply.status(409).send({ error: 'Username already taken' });

    // First user becomes admin
    const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
    const role = userCount === 0 ? 'admin' : 'member';

    const userId = uuidv4();
    const { hash, salt } = hashPassword(body.password);

    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, password_salt, display_name, role) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, body.username, body.email || '', hash, salt, body.display_name || body.username, role);

    // Auto-login: create session
    const sessionToken = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days
    db.prepare('INSERT INTO sessions (token, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionToken, userId, randomBytes(16).toString('hex'), now, expiresAt);

    reply.header('Set-Cookie', `${COOKIE_NAME}=${sessionToken}; HttpOnly; Path=/; SameSite=Lax`);

    const user = db.prepare('SELECT id, username, email, display_name, role, created_at FROM users WHERE id = ?').get(userId);
    return reply.status(201).send({ ok: true, user, token: sessionToken });
  });

  // Login with username + password (multi-user)
  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string } | null;
    if (!body?.username || !body?.password) {
      return reply.status(400).send({ error: 'username and password are required' });
    }

    const { getDatabase } = require('../db/database');
    const db = getDatabase();

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(body.username) as User | undefined;
    if (!user || !verifyPassword(body.password, user.password_hash, user.password_salt)) {
      return reply.status(401).send({ error: 'Invalid username or password' });
    }

    // Update last_login_at
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

    // Create session
    const sessionToken = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO sessions (token, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionToken, user.id, randomBytes(16).toString('hex'), now, expiresAt);

    reply.header('Set-Cookie', `${COOKIE_NAME}=${sessionToken}; HttpOnly; Path=/; SameSite=Lax`);
    return { ok: true, token: sessionToken, user: { id: user.id, username: user.username, email: user.email, display_name: user.display_name, role: user.role } };
  });

  // Get current user info
  app.get('/api/auth/me', async (request, reply) => {
    const user = getUserFromRequest(request);
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    return { id: user.id, username: user.username, email: user.email, display_name: user.display_name, role: user.role, created_at: user.created_at };
  });

  // List users (admin only)
  app.get('/api/auth/users', async (request, reply) => {
    const user = getUserFromRequest(request);
    if (!user || user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });

    const { getDatabase } = require('../db/database');
    const db = getDatabase();
    const users = db.prepare('SELECT id, username, email, display_name, role, created_at, last_login_at FROM users ORDER BY created_at').all();
    return { users };
  });

  // Update user role (admin only)
  app.put('/api/auth/users/:id', async (request, reply) => {
    const user = getUserFromRequest(request);
    if (!user || user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });

    const { id } = request.params as { id: string };
    const { role } = request.body as { role?: string };

    if (id === user.id) return reply.status(400).send({ error: 'Cannot change your own role' });
    if (role && !['admin', 'member'].includes(role)) return reply.status(400).send({ error: 'Invalid role' });

    const { getDatabase } = require('../db/database');
    const db = getDatabase();
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!target) return reply.status(404).send({ error: 'User not found' });

    if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    const updated = db.prepare('SELECT id, username, email, display_name, role, created_at, last_login_at FROM users WHERE id = ?').get(id);
    return { user: updated };
  });

  // Delete user (admin only)
  app.delete('/api/auth/users/:id', async (request, reply) => {
    const user = getUserFromRequest(request);
    if (!user || user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });

    const { id } = request.params as { id: string };
    if (id === user.id) return reply.status(400).send({ error: 'Cannot delete yourself' });

    const { getDatabase } = require('../db/database');
    const db = getDatabase();
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!target) return reply.status(404).send({ error: 'User not found' });

    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  // Helper: resolve user from request token
  function getUserFromRequest(request: FastifyRequest): User | null {
    try {
      const { getDatabase } = require('../db/database');
      const db = getDatabase();

      // Check cookie
      const cookies = parseCookies(request.headers.cookie);
      let token = cookies[COOKIE_NAME];

      // Check Authorization header
      if (!token) {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          token = authHeader.slice(7);
        }
      }

      if (!token) return null;

      const session = db.prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now()) as { user_id: string } | undefined;
      if (!session?.user_id) return null;

      return db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as User | undefined || null;
    } catch {
      return null;
    }
  }

  // Check if a session token is valid (for multi-user mode)
  function isValidSessionToken(token: string): boolean {
    try {
      const { getDatabase } = require('../db/database');
      const db = getDatabase();
      const session = db.prepare('SELECT token FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now());
      return !!session;
    } catch {
      return false;
    }
  }

  // Auth hook
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;

    // ARGUS_NO_AUTH=true: skip all authentication
    if (process.env.ARGUS_NO_AUTH === 'true') {
      return;
    }

    // Allow auth routes and favicon
    if (request.method === 'OPTIONS' || url === '/login' || url === '/setup' || url === '/register' || url.startsWith('/api/auth') || url === '/favicon.ico') {
      return;
    }

    // Localhost bypass: only for agent-safe routes
    const remoteIp = request.ip;
    const isLocalhost = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    if (isLocalhost && isLocalhostSafe(request.method, url)) {
      return;
    }

    // No password in memory -> reload from DB
    if (!authConfig.passwordHash) {
      authConfig = loadAuthConfig();
    }
    if (!authConfig.passwordHash) {
      // Check if multi-user mode has users
      let hasUsers = false;
      try {
        const { getDatabase } = require('../db/database');
        const db = getDatabase();
        const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
        hasUsers = count > 0;
      } catch {}

      if (!hasUsers) {
        if (url.startsWith('/api/') || url.startsWith('/ws')) {
          reply.status(401).send({ error: 'No authentication configured. Visit /register to create the first account.' });
        } else {
          reply.redirect('/register');
        }
        return;
      }
    }

    // Check cookie token
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];

    // Try legacy single-password token first
    if (token && isValidToken(token)) {
      return;
    }

    // Try multi-user session token
    if (token && isValidSessionToken(token)) {
      return;
    }

    // Check Authorization: Bearer <token>
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);
      if (isValidToken(bearerToken)) return;
      if (isValidSessionToken(bearerToken)) return;
    }

    // Check query token (for WebSocket connections)
    const queryToken = (request.query as Record<string, string>)?.token;
    if (queryToken && (isValidToken(queryToken) || isValidSessionToken(queryToken))) return;

    // Allow static assets and UI page routes — only protect API/WS
    if (url.startsWith('/public/') || url.startsWith('/css/') || url.startsWith('/js/') || url.startsWith('/vendor/')) {
      return;
    }

    // Unauthenticated page routes → redirect to login
    if (!url.startsWith('/api/') && !url.startsWith('/ws')) {
      return reply.redirect('/login');
    }

    // Unauthenticated API/WS
    reply.status(401).send({ error: 'Unauthorized' });
  });
}
