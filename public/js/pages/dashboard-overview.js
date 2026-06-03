import { initDashboardPage, loadDashboardProjects, loadDashboardSummary, setupDashboardWS } from './dashboard-core.js';

let _dashboardProjectsById = {};
let _summaryData = null;
let _refreshTimer = null;

async function loadOverviewSummary() {
  const data = await loadDashboardSummary();
  if (!data) return;
  _summaryData = data;
  const inboxDesc = document.getElementById('overview-inbox-desc');
  if (inboxDesc && data.issues.open > 0) {
    inboxDesc.textContent = data.issues.open + ' issue' + (data.issues.open === 1 ? '' : 's') + ' need attention';
  } else if (inboxDesc) {
    inboxDesc.textContent = 'No pending actions';
  }
}

async function loadProjects() {
  const projects = await loadDashboardProjects();
  _dashboardProjectsById = Object.fromEntries(projects.map(p => [p.id, p]));
  renderProjectsList(projects);
  renderActivityList(projects);
  return projects;
}

function renderProjectsList(projects) {
  const container = document.getElementById('overview-projects-list');
  if (!container) return;

  // Sort by last activity
  const lastActivity = _summaryData?.last_activity || {};
  const sorted = [...projects].sort((a, b) => {
    const aTime = lastActivity[a.id] || a.updated_at || '';
    const bTime = lastActivity[b.id] || b.updated_at || '';
    return bTime > aTime ? 1 : -1;
  });

  if (!sorted.length) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:12px;text-align:center">No projects yet. Create one to get started.</div>';
    return;
  }

  container.innerHTML = sorted.map(project => {
    const running = project.stats?.runningAgents || 0;
    const openIssues = project.stats?.openIssues || 0;
    const meta = [];
    if (running > 0) meta.push(h`<span style="color:var(--success)">${running} running</span>`);
    if (openIssues > 0) meta.push(h`<span>${openIssues} open</span>`);
    if (!meta.length) meta.push(h`<span>idle</span>`);
    const remoteSuffix = project.is_remote ? ` · ${project.remote_instance_name || 'remote'}` : '';
    return h`<a href="/project/${project.id}" class="overview-project-row">
      <span class="overview-project-name">${project.name}${remoteSuffix}</span>
      <span class="overview-project-meta">${meta.join(' · ')}</span>
    </a>`;
  }).join('');
}

function renderActivityList(projects) {
  const container = document.getElementById('overview-activity-list');
  if (!container) return;

  const lastActivity = _summaryData?.last_activity || {};
  const entries = projects
    .map(p => ({ name: p.name, id: p.id, time: lastActivity[p.id] || p.updated_at || '' }))
    .filter(e => e.time)
    .sort((a, b) => b.time > a.time ? 1 : -1)
    .slice(0, 10);

  if (!entries.length) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:12px;text-align:center">No recent activity</div>';
    return;
  }

  container.innerHTML = entries.map(entry => {
    const dotClass = 'idle';
    return h`<div class="overview-activity-item">
      <span class="overview-activity-dot ${dotClass}"></span>
      <span class="overview-activity-text">${entry.name}</span>
      <span class="overview-activity-time">${timeAgo(entry.time) || ''}</span>
    </div>`;
  }).join('');
}

async function refreshOverviewPage() {
  await Promise.all([loadOverviewSummary(), loadProjects()]);
}

async function initOverviewPage() {
  await initDashboardPage('overview');
  await refreshOverviewPage();
  _refreshTimer = setInterval(refreshOverviewPage, 30000);
  setupDashboardWS(refreshOverviewPage);
}

initOverviewPage().catch(e => console.error('Failed to initialize overview page', e));
