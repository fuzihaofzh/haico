import { initDashboardPage, loadDashboardSummary, setupDashboardWS } from './dashboard-core.js';

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
  const res = await fetch('/api/projects/page?limit=10&sort=activity&with_stats=1', { headers: apiHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  const projects = data.projects || [];
  renderProjectsList(projects);
  renderActivityList(projects);
  return projects;
}

function renderProjectsList(projects) {
  const container = document.getElementById('overview-projects-list');
  if (!container) return;

  if (!projects.length) {
    container.innerHTML = h`<div style="padding:16px;color:var(--text-secondary);font-size:12px;text-align:center">No projects yet. Create one to get started.</div>`;
    return;
  }

  container.innerHTML = projects.map(project => {
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
  const projectById = Object.fromEntries(projects.map(p => [p.id, p]));

  // Build entries from last_activity map (covers projects beyond the top 10 page)
  const entries = Object.entries(lastActivity)
    .filter(([, time]) => time)
    .map(([id, time]) => {
      const p = projectById[id];
      return { name: p?.name || id, id, time };
    })
    .sort((a, b) => b.time > a.time ? 1 : -1)
    .slice(0, 10);

  if (!entries.length) {
    container.innerHTML = h`<div style="padding:16px;color:var(--text-secondary);font-size:12px;text-align:center">No recent activity</div>`;
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
