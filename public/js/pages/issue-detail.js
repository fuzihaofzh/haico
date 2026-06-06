function parseIssuePath() {
  // Match /issues/:id, /issue/:id, or /project/:pid/issues/:num
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'issues' || pathParts[0] === 'issue') {
    return { issueId: decodeRouteParam(pathParts[1]) };
  }
  if (pathParts[0] === 'project' && pathParts[2] === 'issues') {
    return { projectId: decodeRouteParam(pathParts[1]), issueNum: decodeRouteParam(pathParts[3]) };
  }
  return {};
}

function updateBreadcrumb(issue) {
  const projectLink = document.getElementById('project-link');
  const issuesLink = document.getElementById('issues-link');
  const titleBreadcrumb = document.getElementById('issue-title-breadcrumb');

  if (projectLink && issue) {
    projectLink.href = `/project/${issue.project_id}`;
    projectLink.textContent = issue.project_name || 'Project';
  }
  if (issuesLink && issue) {
    issuesLink.href = `/project/${issue.project_id}/issues`;
  }
  if (titleBreadcrumb && issue) {
    titleBreadcrumb.textContent = `#${issue.number}`;
  }
}

async function loadIssue() {
  const parsed = parseIssuePath();
  const container = document.getElementById('issue-detail-content');
  if (!container) return;

  if (!parsed.issueId && !parsed.projectId) {
    container.innerHTML = h`<div class="error-retry"><span class="error-msg">No issue ID in URL</span><a href="/inbox" class="btn btn-sm">Go to Inbox</a></div>`;
    return;
  }

  container.innerHTML = h`<div class="loading-spinner"><span class="spinner"></span>Loading issue...</div>`;

  try {
    let issueRes;
    if (parsed.issueId) {
      issueRes = await fetch(buildIssueApiPath(parsed.issueId), { headers: apiHeaders() });
    } else {
      issueRes = await fetch(buildProjectIssueLookupApiPath(parsed.projectId, parsed.issueNum), { headers: apiHeaders() });
    }
    if (!issueRes.ok) {
      if (issueRes.status === 404) {
        container.innerHTML = h`<div class="error-retry"><span class="error-msg">Issue not found</span><a href="/inbox" class="btn btn-sm">Go to Inbox</a></div>`;
      } else {
        container.innerHTML = renderError({ status: issueRes.status });
      }
      return;
    }

    const issue = await issueRes.json();
    updateBreadcrumb(issue);
    document.title = `#${issue.number} ${issue.title} - HAICO`;

    // Load agents for this project
    let agents = [];
    try {
      const agentsRes = await fetch(buildProjectApiPath(issue.project_id, '/agents'), { headers: apiHeaders() });
      if (agentsRes.ok) agents = await agentsRes.json();
    } catch {}

    IssueRenderer.render(issue, agents, container, {
      reload: loadIssue,
      onAfterAction: loadIssue,
      refreshComments: () => loadIssue(),
    });
  } catch (e) {
    container.innerHTML = renderError(e, 'loadIssue');
  }
}

loadIssue().catch(e => console.error('Failed to initialize issue detail page', e));
