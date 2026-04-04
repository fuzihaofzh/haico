// Parse URL: /issues/:uuid OR /projects/:pid/issues/:num
const pathParts = window.location.pathname.split('/').filter(Boolean);
let issueId = null;
let projectId = null;
let issueNum = null;
if (pathParts[0] === 'issues') { issueId = pathParts[1]; }
else if (pathParts[0] === 'projects' && pathParts[2] === 'issues') { projectId = pathParts[1]; issueNum = pathParts[3]; }

let issueData = null;
let agentsData = [];

async function loadIssue() {
  let data;
  if (issueId) {
    const res = await fetch(`/api/issues/${issueId}`, { headers: apiHeaders() });
    if (!res.ok) { document.getElementById('issue-page').innerHTML = '<div class="empty-state">Issue not found.</div>'; return; }
    data = await res.json();
  } else if (projectId && issueNum) {
    const res = await fetch(`/api/projects/${projectId}/issues/number/${issueNum}`, { headers: apiHeaders() });
    if (!res.ok) { document.getElementById('issue-page').innerHTML = '<div class="empty-state">Issue not found.</div>'; return; }
    data = await res.json();
  }
  issueData = data; issueId = data.id;

  // Fetch agents and project info in parallel
  const [agentsRes, projectRes] = await Promise.allSettled([
    fetch(`/api/projects/${data.project_id}/agents`, { headers: apiHeaders() }),
    fetch(`/api/projects/${data.project_id}`, { headers: apiHeaders() })
  ]);
  if (agentsRes.status === 'fulfilled' && agentsRes.value.ok) agentsData = await agentsRes.value.json();

  document.getElementById('project-link').href = `/projects/${data.project_id}`;
  document.getElementById('issues-link').href = `/projects/${data.project_id}#issues`;
  let projectColor = null;
  if (projectRes.status === 'fulfilled' && projectRes.value.ok) { const p = await projectRes.value.json(); document.getElementById('project-link').textContent = p.name; projectColor = p.color; }
  document.getElementById('issue-title-breadcrumb').textContent = `#${data.number} ${data.title}`;
  document.title = `#${data.number} ${data.title} - Agentopia`;

  IssueRenderer.render(issueData, agentsData, document.getElementById('issue-page'), {
    reload: loadIssue,
    projectColor: projectColor,
  });
  setupIssueWS();
}

loadIssue();

// Connect to project WebSocket for real-time comment updates
let _issueEvents = null;
function setupIssueWS() {
  if (!issueData || !issueData.project_id || _issueEvents) return;
  _issueEvents = connectProjectEvents(issueData.project_id);
  _issueEvents.on('comment_added', function(data) {
    if (data.issueId === issueId) loadIssue();
  });
  _issueEvents.on('issue_updated', function(data) {
    if (data.issue && data.issue.id === issueId) loadIssue();
  });
}
