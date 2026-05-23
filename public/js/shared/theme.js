// Global theme bootstrap.
// Keep this file as a classic synchronous <script> loaded before CSS links.
// It must not be converted to an ES module: modules defer by default, which
// would allow theme CSS variables to miss the first paint, and legacy inline
// handlers such as onchange="changeTheme(...)" rely on global functions.
(function initGlobalTheme(window, document) {
  'use strict';

  const STORAGE_KEY = 'haico-theme';
  const DEFAULT_THEME = 'solarized-light';
  const themes = {
    'github-dark': { bg: '#0d1117', fg: '#e6edf3', headerBg: '#161b22', drawerBg: '#161b22', border: '#30363d', textSecondary: '#8b949e', accent: '#58a6ff', success: '#3fb950', warning: '#d29922', error: '#f85149', selectedBg: '#21262d' },
    dracula: { bg: '#282a36', fg: '#f8f8f2', headerBg: '#21222c', drawerBg: '#21222c', border: '#44475a', textSecondary: '#6272a4', accent: '#8be9fd', success: '#50fa7b', warning: '#f1fa8c', error: '#ff5555', selectedBg: '#282a36' },
    'nord-dark': { bg: '#2e3440', fg: '#d8dee9', headerBg: '#3b4252', drawerBg: '#3b4252', border: '#4c566a', textSecondary: '#81a1c1', accent: '#88c0d0', success: '#a3be8c', warning: '#ebcb8b', error: '#bf616a', selectedBg: '#2e3440' },
    'nord-light': { bg: '#ECEFF4', fg: '#2E3440', headerBg: '#E5E9F0', drawerBg: '#E5E9F0', border: '#D8DEE9', textSecondary: '#4C566A', accent: '#5E81AC', success: '#A3BE8C', warning: '#EBCB8B', error: '#BF616A', selectedBg: '#D8DEE9' },
    monokai: { bg: '#272822', fg: '#f8f8f2', headerBg: '#1e1f1c', drawerBg: '#1e1f1c', border: '#3e3d32', textSecondary: '#75715e', accent: '#66d9ef', success: '#a6e22e', warning: '#e6db74', error: '#f92672', selectedBg: '#272822' },
    'solarized-dark': { bg: '#002b36', fg: '#839496', headerBg: '#073642', drawerBg: '#073642', border: '#586e75', textSecondary: '#657b83', accent: '#268bd2', success: '#859900', warning: '#b58900', error: '#dc322f', selectedBg: '#002b36' },
    'solarized-light': { bg: '#fdf6e3', fg: '#073642', headerBg: '#eee8d5', drawerBg: '#eee8d5', border: '#c9bba3', textSecondary: '#586e75', accent: '#268bd2', success: '#859900', warning: '#b58900', error: '#dc322f', selectedBg: '#e8dcc8' },
  };

  function normalizeThemeName(name) {
    return name === 'nord' ? 'nord-dark' : name;
  }

  function safeGetSavedTheme(fallback) {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeSetSavedTheme(name) {
    try {
      window.localStorage.setItem(STORAGE_KEY, name);
    } catch (_) {}
  }

  function resolveThemeName(name, fallback) {
    const normalized = normalizeThemeName(name);
    if (normalized && themes[normalized]) return normalized;
    return themes[fallback] ? fallback : DEFAULT_THEME;
  }

  function syncThemeSelectors(name) {
    document.querySelectorAll('#theme-select').forEach(function syncSelect(select) {
      if (select.value !== name) select.value = name;
    });
  }

  function applyTheme(name, fallback) {
    const appliedName = resolveThemeName(name, fallback || DEFAULT_THEME);
    const theme = themes[appliedName];
    const root = document.documentElement;
    root.style.setProperty('--bg', theme.bg);
    root.style.setProperty('--fg', theme.fg);
    root.style.setProperty('--header-bg', theme.headerBg);
    root.style.setProperty('--drawer-bg', theme.drawerBg);
    root.style.setProperty('--border', theme.border);
    root.style.setProperty('--text-secondary', theme.textSecondary);
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--success', theme.success);
    root.style.setProperty('--warning', theme.warning);
    root.style.setProperty('--error', theme.error);
    root.style.setProperty('--selected-bg', theme.selectedBg);
    syncThemeSelectors(appliedName);
    return appliedName;
  }

  function applySavedTheme(fallback) {
    const selectedFallback = fallback || DEFAULT_THEME;
    const saved = safeGetSavedTheme(selectedFallback);
    const appliedName = applyTheme(saved, selectedFallback);
    if (saved !== appliedName) safeSetSavedTheme(appliedName);
    return appliedName;
  }

  function changeTheme(name) {
    const appliedName = applyTheme(name, DEFAULT_THEME);
    safeSetSavedTheme(appliedName);
    return appliedName;
  }

  window.HaicoTheme = {
    STORAGE_KEY,
    DEFAULT_THEME,
    themes,
    normalizeThemeName,
    applyTheme,
    applySavedTheme,
    changeTheme,
    syncThemeSelectors,
  };
  window.applyTheme = applyTheme;
  window.changeTheme = changeTheme;

  const initialTheme = applySavedTheme(DEFAULT_THEME);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function onReady() {
      syncThemeSelectors(initialTheme);
    });
  } else {
    syncThemeSelectors(initialTheme);
  }
})(window, document);
