// Parse URL: /issues/:uuid OR /projects/:pid/issues/:num
const pathParts = window.location.pathname.split('/').filter(Boolean);
let issueId = null;
let projectId = null;
let issueNum = null;
if (pathParts[0] === 'issues') { issueId = pathParts[1]; }
else if (pathParts[0] === 'projects' && pathParts[2] === 'issues') { projectId = pathParts[1]; issueNum = pathParts[3]; }

let issueData = null;
let agentsData = [];
let issueProjectColor = null;

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
  let projectColor = issueProjectColor;
  if (projectRes.status === 'fulfilled' && projectRes.value.ok) { const p = await projectRes.value.json(); document.getElementById('project-link').textContent = p.name; projectColor = p.color; }
  issueProjectColor = projectColor;
  document.getElementById('issue-title-breadcrumb').textContent = `#${data.number} ${data.title}`;
  document.title = `#${data.number} ${data.title} - HAICO`;

  IssueRenderer.render(issueData, agentsData, document.getElementById('issue-page'), {
    reload: loadIssue,
    refreshComments: refreshIssueComments,
    projectColor: issueProjectColor,
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
    if (data.issueId === issueId) refreshIssueComments(data.comment);
  });
  _issueEvents.on('issue_updated', function(data) {
    if (data.issue && data.issue.id === issueId) loadIssue();
  });
}

function getLastCommentCreatedAt(issue) {
  return (issue && issue.comments || []).reduce(function(max, comment) {
    const createdAt = comment && comment.created_at;
    return createdAt && createdAt > max ? createdAt : max;
  }, '');
}

function mergeIssueComments(comments) {
  if (!issueData || !Array.isArray(comments) || comments.length === 0) return false;
  const byId = new Map((issueData.comments || []).map(function(comment) { return [comment.id, comment]; }));
  let changed = false;
  for (const comment of comments) {
    if (!comment || !comment.id) continue;
    if (!byId.has(comment.id)) changed = true;
    byId.set(comment.id, Object.assign({ reactions: [] }, comment));
  }
  if (!changed) return false;
  issueData.comments = Array.from(byId.values()).sort(function(a, b) {
    return (a.created_at || '') > (b.created_at || '') ? 1 : -1;
  });
  return true;
}

async function refreshIssueComments(seedComment) {
  if (!issueData || !issueId) return loadIssue();
  let changed = mergeIssueComments(seedComment ? [seedComment] : []);
  const sinceCreatedAt = getLastCommentCreatedAt(issueData);
  try {
    const params = new URLSearchParams();
    if (sinceCreatedAt) params.set('since_created_at', sinceCreatedAt);
    const res = await fetch(`/api/issues/${issueId}/comments?${params.toString()}`, { headers: apiHeaders() });
    if (res.ok) {
      const comments = await res.json();
      changed = mergeIssueComments(comments) || changed;
    }
  } catch (e) {
    console.error('Failed to refresh issue comments', e);
  }
  if (!changed) return;
  IssueRenderer.render(issueData, agentsData, document.getElementById('issue-page'), {
    reload: loadIssue,
    refreshComments: refreshIssueComments,
    projectColor: issueProjectColor,
  });
}
