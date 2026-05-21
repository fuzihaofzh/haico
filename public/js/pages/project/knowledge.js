async function loadKnowledge() {
  const el = document.getElementById('knowledge-list');
  if (!el) return;
  const canManage = canManageProject();
  const importance = document.getElementById('knowledge-filter-importance')?.value || '';
  const qs = importance ? `?importance=${importance}` : '';
  try {
    const res = await fetch(`${projectApiPath('/knowledge')}${qs}`, { headers: apiHeaders() });
    if (!res.ok) { el.innerHTML = renderError({ status: res.status }, 'loadKnowledge()'); return; }
    const data = await res.json();
    const entries = data.entries || [];
    if (entries.length === 0) {
      el.innerHTML = `<div class="empty-state">No knowledge entries yet.${canManage ? ' Click "Add Knowledge" to start building the project knowledge base.' : ''}</div>`;
      return;
    }
    const impBadge = (imp) => {
      const colors = { high: 'var(--error)', medium: 'var(--warning)', low: 'var(--text-secondary)' };
      const labels = { high: 'High', medium: 'Medium', low: 'Low' };
      return `<span style="padding:1px 6px;border-radius:3px;font-size:10px;background:${colors[imp] || 'var(--text-secondary)'};color:#fff">${labels[imp] || imp}</span>`;
    };
    el.innerHTML = '<div style="padding:8px 0">' + entries.map(e => `
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            ${impBadge(e.importance)}
            <span style="font-weight:600;font-size:13px">${esc(e.title)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;max-height:60px;overflow:hidden;white-space:pre-wrap">${esc((e.content || '').slice(0, 200))}${e.content && e.content.length > 200 ? '...' : ''}</div>
          ${e.tags ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${e.tags.split(',').filter(t => t.trim()).map(t => `<span style="padding:1px 6px;background:var(--bg);border:1px solid var(--border);border-radius:3px;font-size:10px">${esc(t.trim())}</span>`).join('')}</div>` : ''}
        </div>
        ${canManage ? `<div style="display:flex;gap:4px;flex-shrink:0;margin-left:12px">
          <button class="btn btn-sm" onclick="editKnowledge('${e.id}')" style="padding:3px 8px">Edit</button>
          <button class="btn btn-sm" onclick="deleteKnowledge('${e.id}')" style="padding:3px 8px;color:var(--error)">Delete</button>
        </div>` : ''}
      </div>
    `).join('') + '</div>';
  } catch (e) { el.innerHTML = renderError(e, 'loadKnowledge()'); }
}

let _knowledgeCache = [];

function showCreateKnowledgeModal() {
  if (!requireProjectManageAccess('Insufficient permission to add knowledge')) return;
  document.getElementById('knowledge-modal-title').textContent = 'Add Knowledge Entry';
  document.getElementById('knowledge-edit-id').value = '';
  document.getElementById('knowledge-title').value = '';
  document.getElementById('knowledge-content').value = '';
  document.getElementById('knowledge-tags').value = '';
  document.getElementById('knowledge-importance').value = 'medium';
  document.getElementById('knowledgeModal').classList.add('active');
}

async function editKnowledge(id) {
  if (!requireProjectManageAccess('Insufficient permission to edit knowledge')) return;
  try {
    const res = await fetch(buildKnowledgeApiPath(id), { headers: apiHeaders() });
    if (!res.ok) return;
    const e = await res.json();
    document.getElementById('knowledge-modal-title').textContent = 'Edit Knowledge Entry';
    document.getElementById('knowledge-edit-id').value = id;
    document.getElementById('knowledge-title').value = e.title || '';
    document.getElementById('knowledge-content').value = e.content || '';
    document.getElementById('knowledge-tags').value = e.tags || '';
    document.getElementById('knowledge-importance').value = e.importance || 'medium';
    document.getElementById('knowledgeModal').classList.add('active');
  } catch { showToast('Failed to load', 'error'); }
}

async function saveKnowledge() {
  if (!requireProjectManageAccess('Insufficient permission to save knowledge')) return;
  const id = document.getElementById('knowledge-edit-id').value;
  const body = {
    title: document.getElementById('knowledge-title').value,
    content: document.getElementById('knowledge-content').value,
    tags: document.getElementById('knowledge-tags').value,
    importance: document.getElementById('knowledge-importance').value,
  };
  if (!body.title) { showToast('Title is required', 'error'); return; }
  try {
    const url = id ? buildKnowledgeApiPath(id) : projectApiPath('/knowledge');
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { ...apiHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) {
      hideModal('knowledgeModal');
      showToast(id ? 'Updated' : 'Created', 'success');
      loadKnowledge();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to save', 'error');
    }
  } catch { showToast('Failed to save', 'error'); }
}

async function deleteKnowledge(id) {
  if (!requireProjectManageAccess('Insufficient permission to delete knowledge')) return;
  if (!await showConfirm('Delete this knowledge entry?', {
    title: 'Delete knowledge entry?',
    confirmLabel: 'Delete',
    tone: 'danger',
  })) return;
  try {
    const res = await fetch(buildKnowledgeApiPath(id), { method: 'DELETE', headers: apiHeaders() });
    if (res.ok) { showToast('Deleted', 'success'); loadKnowledge(); }
    else showToast('Failed to delete', 'error');
  } catch { showToast('Failed to delete', 'error'); }
}

// ─── Workflow Tab (#615) ───
(async function initKnowledgePage(){
  await loadProjectShell();
  await loadKnowledge();
  const events = connectProjectEvents(projectId);
  events.on("agent_status", loadKnowledge);
})();
