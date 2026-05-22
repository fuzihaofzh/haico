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
    const list = cloneKnowledgeTemplate('tmpl-knowledge-list');
    const entriesSlot = list.matches('[data-slot="entries"]')
      ? list
      : list.querySelector('[data-slot="entries"]');
    entriesSlot.replaceChildren(...entries.map((entry) => renderKnowledgeEntry(entry, canManage)));
    el.replaceChildren(list);
  } catch (e) { el.innerHTML = renderError(e, 'loadKnowledge()'); }
}

let _knowledgeCache = [];

function cloneKnowledgeTemplate(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function setKnowledgeText(root, slotName, value) {
  const node = root.querySelector(`[data-slot="${slotName}"]`);
  if (node) node.textContent = value == null ? '' : String(value);
}

function renderKnowledgeEntry(entry, canManage) {
  const row = cloneKnowledgeTemplate('tmpl-knowledge-entry');
  const importance = entry.importance || 'low';
  const colors = { high: 'var(--error)', medium: 'var(--warning)', low: 'var(--text-secondary)' };
  const labels = { high: 'High', medium: 'Medium', low: 'Low' };
  const badge = row.querySelector('[data-slot="importance"]');
  badge.style.background = colors[importance] || 'var(--text-secondary)';
  badge.textContent = labels[importance] || importance;
  setKnowledgeText(row, 'title', entry.title);
  setKnowledgeText(row, 'content', `${(entry.content || '').slice(0, 200)}${entry.content && entry.content.length > 200 ? '...' : ''}`);

  const tags = row.querySelector('[data-slot="tags"]');
  const tagItems = String(entry.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  if (tagItems.length) {
    tags.replaceChildren(...tagItems.map(createKnowledgeTag));
  } else {
    tags.remove();
  }

  const actions = row.querySelector('[data-slot="actions"]');
  if (canManage) {
    row.querySelector('[data-action="edit-knowledge"]').addEventListener('click', () => editKnowledge(entry.id));
    row.querySelector('[data-action="delete-knowledge"]').addEventListener('click', () => deleteKnowledge(entry.id));
  } else {
    actions.remove();
  }
  return row;
}

function createKnowledgeTag(label) {
  const tag = document.createElement('span');
  tag.style.padding = '1px 6px';
  tag.style.background = 'var(--bg)';
  tag.style.border = '1px solid var(--border)';
  tag.style.borderRadius = '3px';
  tag.style.fontSize = '10px';
  tag.textContent = label;
  return tag;
}

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
