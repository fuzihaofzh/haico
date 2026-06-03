import {
  getCachedDashboardProjects,
  getDashboardProjectById,
  getLocalDashboardProjects,
  invalidateDashboardProjects,
  loadDashboardProjects,
  subscribeDashboardProjects,
} from '../shared/dashboard-project-store.js';

const DASHBOARD_NAV_VIEWS = new Set(['overview', 'inbox', 'chat', 'projects', 'usage', 'settings']);
let dashboardView = getInitialDashboardView();
let wsRefreshTimer = null;

function normalizeDashboardView(view) {
  return DASHBOARD_NAV_VIEWS.has(view) ? view : 'overview';
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


async function loadDashboardSummary() {
  try {
    const res = await fetch('/api/dashboard/summary', { headers: apiHeaders() });
    if (!res.ok) return null;
    const data = await res.json();

    const runningStat = document.getElementById('stat-running');
    const openIssuesStat = document.getElementById('stat-open-issues');
    if (runningStat && openIssuesStat) {
      runningStat.textContent = data.agents.running;
      openIssuesStat.textContent = data.issues.open;

      const fmtTokens = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;
      if (data.total_cost_usd > 0) {
        document.getElementById('stat-cost').textContent = '$' + data.total_cost_usd.toFixed(2);
      } else if (data.total_input_tokens > 0) {
        document.getElementById('stat-cost').textContent = fmtTokens(data.total_input_tokens) + '↑ ' + fmtTokens(data.total_output_tokens) + '↓';
        const costLabel = document.getElementById('stat-cost')?.closest('.stat-card')?.querySelector('.stat-label');
        if (costLabel) costLabel.textContent = 'Token Usage';
      }

      const errCard = document.getElementById('stat-errors-card');
      if (data.agents.error_count > 0) {
        document.getElementById('stat-errors').textContent = data.agents.error_count;
        errCard.style.display = '';
      } else {
        errCard.style.display = 'none';
      }

      document.getElementById('dashboard-stats').style.display = '';
    }

    return data;
  } catch (e) {
    console.error('Failed to load dashboard summary', e);
    return null;
  }
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
  loadDashboardSummary,
  normalizeDashboardView,
  setupDashboardWS,
  subscribeDashboardProjects,
  switchView,
};
