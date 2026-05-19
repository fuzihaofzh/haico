import {
  getCachedDashboardProjects,
  getDashboardProjectById,
  getLocalDashboardProjects,
  invalidateDashboardProjects,
  loadDashboardProjects,
  subscribeDashboardProjects,
} from '../shared/dashboard-project-store.js';

const DASHBOARD_NAV_VIEWS = new Set(['inbox', 'projects', 'usage', 'settings']);
let dashboardView = getInitialDashboardView();
let wsRefreshTimer = null;

function normalizeDashboardView(view) {
  return DASHBOARD_NAV_VIEWS.has(view) ? view : 'inbox';
}

function getInitialDashboardView() {
  const page = document.body?.dataset?.dashboardPage || '';
  if (page) return normalizeDashboardView(page);
  const pathView = String(window.location.pathname || '').replace(/^\//, '');
  if (pathView) return normalizeDashboardView(pathView);
  const params = new URLSearchParams(window.location.search);
  return normalizeDashboardView(params.get('view'));
}

function setSidebarActive(view) {
  document.querySelectorAll('.sidebar-nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.sidebarView === view);
  });
}

function applyDashboardViewState(view) {
  dashboardView = normalizeDashboardView(view);
  document.body.dataset.dashboardPage = dashboardView;
  document.body.dataset.dashboardView = dashboardView;
  setSidebarActive(dashboardView);
}

function getDashboardPageHref(view) {
  const page = normalizeDashboardView(view);
  return page === 'inbox' ? '/inbox' : '/' + page;
}

function switchView(view) {
  const nextView = normalizeDashboardView(view);
  const nextHref = getDashboardPageHref(nextView);
  if (window.location.pathname !== nextHref) {
    window.location.href = nextHref;
    return;
  }
  applyDashboardViewState(nextView);
}

async function initDashboardPage(view) {
  applyDashboardViewState(view || dashboardView);
}

function scheduleWSRefresh(refresh) {
  if (wsRefreshTimer) return;
  wsRefreshTimer = setTimeout(async () => {
    wsRefreshTimer = null;
    invalidateDashboardProjects();
    if (typeof refresh === 'function') {
      try { await refresh(); } catch (error) { console.error('Dashboard refresh failed after websocket event', error); }
    }
  }, 2000);
}

async function setupDashboardWS(refresh) {
  try {
    const projects = await loadDashboardProjects();
    for (const project of projects) {
      if (!project || project.is_remote) continue;
      const events = connectProjectEvents(project.id);
      events.on('*', () => scheduleWSRefresh(refresh));
    }
  } catch (error) {
    console.error('Failed to initialize dashboard websocket listeners', error);
  }
}

function invalidateDashboardProjectCaches(options = {}) {
  invalidateDashboardProjects({ invalidateRemoteOptions: options.invalidateRemoteOptions !== false });
}

if (typeof window !== 'undefined') {
  window.switchView = switchView;
  window.HAICODashboardActions = window.HAICODashboardActions || {};
  Object.assign(window.HAICODashboardActions, {
    invalidateDashboardProjectCaches,
    loadProjects: loadDashboardProjects,
  });
}

export {
  applyDashboardViewState,
  getCachedDashboardProjects,
  getDashboardPageHref,
  getDashboardProjectById,
  getLocalDashboardProjects,
  initDashboardPage,
  invalidateDashboardProjectCaches,
  invalidateDashboardProjects,
  loadDashboardProjects,
  normalizeDashboardView,
  setupDashboardWS,
  subscribeDashboardProjects,
  switchView,
};
