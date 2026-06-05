import { showToast } from '../../components/toast.js';

// ─── URL Parsing ───

function getProjectIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('project');
  return decodeRouteParam(idx >= 0 ? parts[idx + 1] : '');
}

function getKnowledgeIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  // /project/:pid/knowledge/:kid/edit
  const kIdx = parts.indexOf('knowledge');
  if (kIdx >= 0 && parts[kIdx + 1] && parts[kIdx + 1] !== 'new') {
    return decodeRouteParam(parts[kIdx + 1]);
  }
  return null;
}

const projectId = getProjectIdFromPath();
const knowledgeId = getKnowledgeIdFromPath();
const isEdit = !!knowledgeId;
const projectBase = buildProjectPageHref(projectId);

// ─── Save ───

async function saveKnowledge() {
  const title = document.getElementById('f-title').value.trim();
  const content = document.getElementById('f-content').value.trim();
  const tags = document.getElementById('f-tags').value.trim();
  const importance = document.getElementById('f-importance').value;

  if (!title) { showToast('Title is required', 'error'); document.getElementById('f-title').focus(); return; }

  const body = { title, content, tags, importance };
  const url = isEdit ? buildKnowledgeApiPath(knowledgeId) : buildProjectApiPath(projectId, '/knowledge');
  const method = isEdit ? 'PUT' : 'POST';

  const btn = document.getElementById('btn-save');
  await withLoading(btn, async () => {
    const res = await fetch(url, {
      method,
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      showToast(isEdit ? 'Updated' : 'Created', 'success');
      location.href = projectBase + '/knowledge';
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to save', 'error');
    }
  });
}

// ─── Init ───

(async function initKnowledgeEditPage() {
  // Cancel link & breadcrumb links
  const cancelLink = document.getElementById('cancel-link');
  if (cancelLink) cancelLink.href = projectBase + '/knowledge';

  const knowledgeLink = document.getElementById('knowledge-link');
  if (knowledgeLink) knowledgeLink.href = projectBase + '/knowledge';

  // Breadcrumb label
  const breadcrumbLabel = document.getElementById('breadcrumb-label');
  if (breadcrumbLabel && isEdit) breadcrumbLabel.textContent = 'Edit Entry';

  // Page title
  document.title = isEdit ? 'Edit Knowledge - HAICO' : 'New Knowledge - HAICO';

  // Load project name for breadcrumb
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

  // Edit mode: load existing entry
  if (isEdit) {
    try {
      const res = await fetch(buildKnowledgeApiPath(knowledgeId), { headers: apiHeaders() });
      if (!res.ok) {
        showToast('Failed to load knowledge entry', 'error');
        return;
      }
      const entry = await res.json();
      document.getElementById('f-title').value = entry.title || '';
      document.getElementById('f-content').value = entry.content || '';
      document.getElementById('f-tags').value = entry.tags || '';
      document.getElementById('f-importance').value = entry.importance || 'medium';
      if (breadcrumbLabel) breadcrumbLabel.textContent = entry.title ? `Edit: ${entry.title}` : 'Edit Entry';
    } catch {
      showToast('Failed to load knowledge entry', 'error');
    }
  }

  // Save button
  document.getElementById('btn-save')?.addEventListener('click', saveKnowledge);
})();
