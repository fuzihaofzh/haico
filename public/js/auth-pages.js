(function applyTheme() {
  const themes = {
    'github-dark': { bg: '#0d1117', fg: '#e6edf3', headerBg: '#161b22', border: '#30363d', textSecondary: '#8b949e', accent: '#58a6ff', error: '#f85149' },
    dracula: { bg: '#282a36', fg: '#f8f8f2', headerBg: '#21222c', border: '#44475a', textSecondary: '#6272a4', accent: '#8be9fd', error: '#ff5555' },
    nord: { bg: '#2e3440', fg: '#d8dee9', headerBg: '#3b4252', border: '#4c566a', textSecondary: '#81a1c1', accent: '#88c0d0', error: '#bf616a' },
    'nord-dark': { bg: '#2e3440', fg: '#d8dee9', headerBg: '#3b4252', border: '#4c566a', textSecondary: '#81a1c1', accent: '#88c0d0', error: '#bf616a' },
    monokai: { bg: '#272822', fg: '#f8f8f2', headerBg: '#1e1f1c', border: '#3e3d32', textSecondary: '#75715e', accent: '#66d9ef', error: '#f92672' },
    'solarized-dark': { bg: '#002b36', fg: '#839496', headerBg: '#073642', border: '#586e75', textSecondary: '#657b83', accent: '#268bd2', error: '#dc322f' },
    'solarized-light': { bg: '#fdf6e3', fg: '#073642', headerBg: '#eee8d5', border: '#c9bba3', textSecondary: '#586e75', accent: '#268bd2', error: '#dc322f' },
  };
  let name = null;
  try {
    name = localStorage.getItem('haico-theme');
  } catch (_) {}
  const theme = themes[name] || themes['solarized-light'];
  const root = document.documentElement;
  root.style.setProperty('--bg', theme.bg);
  root.style.setProperty('--fg', theme.fg);
  root.style.setProperty('--header-bg', theme.headerBg);
  root.style.setProperty('--border', theme.border);
  root.style.setProperty('--text-secondary', theme.textSecondary);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--error', theme.error);
})();

function showAuthError(message) {
  const errEl = document.getElementById('error');
  if (!errEl) return;
  errEl.textContent = message;
  errEl.style.display = 'block';
}

function hideAuthError() {
  const errEl = document.getElementById('error');
  if (errEl) errEl.style.display = 'none';
}

async function readError(res, fallback) {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch (_) {
    return fallback;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const setupForm = document.getElementById('setup-form');
  if (setupForm) {
    setupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAuthError();
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) return showAuthError('Password must be at least 4 characters');
      if (password !== confirm) return showAuthError('Passwords do not match');
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        showAuthError(await readError(res, 'Setup failed'));
      }
    });
  }

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAuthError();
      const username = document.getElementById('username')?.value;
      const password = document.getElementById('password').value;
      if (username) {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (res.ok) {
          window.location.href = '/';
          return;
        }
      }
      const legacyRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (legacyRes.ok) {
        window.location.href = '/';
        return;
      }
      showAuthError('Invalid username or password');
    });
  }

  const registerForm = document.getElementById('register-form');
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAuthError();
      const username = document.getElementById('username').value;
      const displayName = document.getElementById('display_name').value;
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) return showAuthError('Password must be at least 4 characters');
      if (password !== confirm) return showAuthError('Passwords do not match');
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, display_name: displayName || undefined }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        showAuthError(await readError(res, 'Registration failed'));
      }
    });
  }

  const changePasswordForm = document.getElementById('change-password-form');
  if (changePasswordForm) {
    changePasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAuthError();
      const successEl = document.getElementById('success');
      if (successEl) successEl.style.display = 'none';
      const current = document.getElementById('current').value;
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) return showAuthError('New password must be at least 4 characters');
      if (password !== confirm) return showAuthError('Passwords do not match');
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, password }),
      });
      if (res.ok) {
        if (successEl) successEl.style.display = 'block';
        changePasswordForm.reset();
      } else {
        showAuthError(await readError(res, 'Failed'));
      }
    });
  }
});
