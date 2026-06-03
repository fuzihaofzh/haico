function getIssueIdFromPath() {
  const match = window.location.pathname.match(/^\/issue\/([^/]+)$/);
  return match ? match[1] : null;
}

function updateBreadcrumb(issue) {
  const issuesLink = document.getElementById('issues-link');
  const projectLink = document.getElementById('project-link');
  const titleBreadcrumb = document.getElementById('issue-title-breadcrumb');

  if (issuesLink) {
    // Link back to project issues if we know the project, else inbox
    issuesLink.href = issue?.project_id ? `/project/${issue.project_id}#issues` : '/inbox';
  }
  if (projectLink && issue) {
    projectLink.href = `/project/${issue.project_id}`;
    projectLink.textContent = issue.project_name || 'Project';
  }
  if (titleBreadcrumb && issue) {
    titleBreadcrumb.textContent = `#${issue.number}`;
  }
}

async function loadIssue() {
  const issueId = getIssueIdFromPath();
  const container = document.getElementById('issue-detail-content');
  if (!container) return;

  if (!issueId) {
    container.innerHTML = '<div class="error-retry"><span class="error-msg">No issue ID in URL</span><a href="/inbox" class="btn btn-sm">Go to Inbox</a></div>';
    return;
  }

  container.innerHTML = '<div class="loading-spinner"><span class="spinner"></span>Loading issue...</div>';

  try {
    const issueRes = await fetch(buildIssueApiPath(issueId), { headers: apiHeaders() });
    if (!issueRes.ok) {
      if (issueRes.status === 404) {
        container.innerHTML = '<div class="error-retry"><span class="error-msg">Issue not found</span><a href="/inbox" class="btn btn-sm">Go to Inbox</a></div>';
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
