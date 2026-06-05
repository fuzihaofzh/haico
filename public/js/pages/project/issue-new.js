import { showToast } from '../../components/toast.js';

// ─── Project ID from URL ───

function getProjectIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('project');
  return decodeRouteParam(idx >= 0 ? parts[idx + 1] : '');
}

const projectId = getProjectIdFromPath();
const projectBase = buildProjectPageHref(projectId);

// ─── Templates ───

const ISSUE_TEMPLATES = {
  bug: { labels: 'bug', body: '## Problem Description\n\n## Steps to Reproduce\n1. \n2. \n\n## Expected Behavior\n\n## Actual Behavior\n' },
  feature: { labels: 'feature', body: '## Background and Motivation\n\n## Requested Feature\n\n## Acceptance Criteria\n' },
};

function applyIssueTemplate(tpl) {
  const t = ISSUE_TEMPLATES[tpl];
  const bodyEl = document.getElementById('f-body');
  const labelsEl = document.getElementById('f-labels');
  if (t) {
    bodyEl.value = t.body;
    if (labelsEl && !labelsEl.value) labelsEl.value = t.labels;
  } else {
    bodyEl.value = '';
  }
}

// ─── Create ───

async function createIssue() {
  const assignedTo = document.getElementById('f-assign').value.trim();
  const title = document.getElementById('f-title').value.trim();
  const body = document.getElementById('f-body').value.trim();
  const labels = document.getElementById('f-labels').value.trim() || undefined;

  if (!assignedTo) { showToast('To is required', 'error'); document.getElementById('f-assign').focus(); return; }
  if (!title) { showToast('Subject is required', 'error'); document.getElementById('f-title').focus(); return; }

  const btn = document.getElementById('btn-create');
  await withLoading(btn, async () => {
    const res = await fetch(buildProjectApiPath(projectId, '/issues'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ title, body, created_by: 'user', assigned_to: assignedTo, labels }),
    });

    if (res.ok) {
      showToast('Issue created', 'success');
      location.href = projectBase + '/issues';
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to create', 'error');
    }
  });
}

// ─── Init ───

(async function initNewIssuePage() {
  // Cancel link
  const cancelLink = document.getElementById('cancel-link');
  if (cancelLink) cancelLink.href = projectBase + '/issues';

  // Breadcrumb links
  const issuesLink = document.getElementById('issues-link');
  if (issuesLink) issuesLink.href = projectBase + '/issues';

  // Load project name
  try {
    const res = await fetch(buildProjectApiPath(projectId, ''), { headers: apiHeaders() });
    const project = await res.json();
    if (res.ok && project) {
      const projectLink = document.getElementById('project-link');
      if (projectLink) {
        projectLink.href = projectBase;
        projectLink.textContent = project.name || projectId;
      }
    }
  } catch { /* breadcrumb stays as fallback */ }

  // Load agents for "To" select
  let agents = [];
  try {
    const res = await fetch(buildProjectApiPath(projectId, '/agents'), { headers: apiHeaders() });
    if (res.ok) agents = await res.json();
  } catch { /* select stays with default option */ }

  const sel = document.getElementById('f-assign');
  if (sel) {
    const controllerId = agents.find(a => a.is_controller)?.id || '';
    sel.innerHTML = h`<option value="">Select a recipient</option><option value="all">All (broadcast)</option><option value="user">User (me)</option>${html(
      agents.map(a => h`<option value="${a.id}">${a.name}${a.is_controller ? ' [controller]' : ''}</option>`).join('')
    )}`;
    if (controllerId) sel.value = controllerId;
  }

  // Setup mention autocomplete
  const bodyEl = document.getElementById('f-body');
  if (bodyEl && typeof setupMentionAutocomplete === 'function') {
    setupMentionAutocomplete(bodyEl, agents);
  }

  // Template select
  document.getElementById('f-template')?.addEventListener('change', function () {
    applyIssueTemplate(this.value);
  });

  // Create button
  document.getElementById('btn-create')?.addEventListener('click', createIssue);
})();
