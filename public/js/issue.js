// Parse URL: /issues/:uuid OR /projects/:pid/issues/:num
const pathParts = window.location.pathname.split('/').filter(Boolean);
let issueId = null;
let projectId = null;
let issueNum = null;
if (pathParts[0] === 'issues') { issueId = pathParts[1]; }
else if (pathParts[0] === 'projects' && pathParts[2] === 'issues') { projectId = pathParts[1]; issueNum = pathParts[3]; }

let issueData = null;
let agentsData = [];
const EMOJIS = ['👍','👎','❤️','🎉','😕','🚀'];

function renderMd(text) {
  if (!text) return '';
  return marked.parse(text.replace(/#(\d+)/g, (m, n) => issueData?.project_id ? `[#${n}](/projects/${issueData.project_id}/issues/${n})` : m));
}
function labelHtml(text) {
  const colors = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#b5bd68','#cc6666','#8abeb7'];
  const bg = colors[hashCode(text.trim()) % colors.length];
  return `<span style="font-size:11px;padding:1px 8px;border-radius:12px;background:${bg}22;color:${bg};border:1px solid ${bg}44;font-weight:500">${esc(text.trim())}</span>`;
}
function statusIcon(s) {
  if (s === 'open') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#3fb950" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#3fb950"/></svg>';
  if (s === 'in_progress') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#d29922"/></svg>';
  return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function reactionBar(targetType, targetId, reactions) {
  const grouped = {};
  (reactions || []).forEach(r => { if (!grouped[r.emoji]) grouped[r.emoji] = []; grouped[r.emoji].push(r.user_id); });
  let html = Object.entries(grouped).map(([emoji, users]) => {
    const title = users.map(u => nameOf(u)).join(', ');
    return `<button onclick="toggleReaction('${targetType}','${targetId}','${emoji}')" style="background:var(--selected-bg);border:1px solid var(--border);border-radius:12px;padding:1px 8px;cursor:pointer;font-size:12px" title="${title}">${emoji} ${users.length}</button>`;
  }).join(' ');
  html += ` <button onclick="showEmojiPicker('${targetType}','${targetId}')" style="background:none;border:1px solid var(--border);border-radius:12px;padding:1px 6px;cursor:pointer;font-size:12px" title="Add reaction">+</button>`;
  return `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">${html}</div>`;
}

async function toggleReaction(type, id, emoji) {
  await fetch(`/api/reactions/${type}/${id}`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ user_id: 'user', emoji }) });
  await loadIssue();
}

function showEmojiPicker(type, id) {
  const picker = EMOJIS.map(e => `<span onclick="toggleReaction('${type}','${id}','${e}')" style="cursor:pointer;font-size:18px;padding:2px">${e}</span>`).join('');
  // Simple inline picker using alert-style approach
  const el = document.getElementById('emoji-picker');
  if (el) { el.remove(); return; }
  const div = document.createElement('div');
  div.id = 'emoji-picker';
  div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--header-bg);border:1px solid var(--border);border-radius:8px;padding:12px;z-index:200;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
  div.innerHTML = picker + `<div style="text-align:center;margin-top:8px"><button class="btn btn-sm" onclick="this.parentElement.parentElement.remove()">Close</button></div>`;
  document.body.appendChild(div);
}

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
  if (projectRes.status === 'fulfilled' && projectRes.value.ok) { const p = await projectRes.value.json(); document.getElementById('project-link').textContent = p.name; }
  document.getElementById('issue-title-breadcrumb').textContent = `#${data.number} ${data.title}`;
  document.title = `#${data.number} ${data.title} - Argus`;

  renderIssue();
  setupIssueWS();
}

function renderIssue() {
  const issue = issueData;
  const labels = issue.labels ? issue.labels.split(',').filter(l=>l.trim()).map(l => labelHtml(l)).join(' ') : '';
  const assignOpts = `<option value="">Unassigned</option><option value="all" ${'all'===issue.assigned_to?'selected':''}>All</option><option value="user" ${'user'===issue.assigned_to?'selected':''}>User</option>` +
    agentsData.map(a => `<option value="${a.id}" ${a.id===issue.assigned_to?'selected':''}>${esc(a.name)}</option>`).join('');

  // Separate comments from events
  const allEntries = issue.comments || [];
  const timeline = allEntries.map(c => {
    if (c.event_type !== 'comment') {
      // Timeline event (status change, assignment, etc.)
      const icon = c.event_type === 'status_change' ? '🔄' : c.event_type === 'assignment' ? '👤' : '🏷️';
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0 8px 40px;font-size:12px;color:var(--text-secondary)">
        <span>${icon}</span>
        <span><strong>${esc(nameOf(c.author_id))}</strong> ${esc(c.body)} ${timeAgo(c.created_at)}</span>
      </div>`;
    }
    // Regular comment
    return `
    <div class="timeline-item">
      <div class="timeline-avatar" style="background:none;border:none">${avatarSvg(nameOf(c.author_id), 24)}</div>
      <div class="timeline-comment">
        <div class="timeline-comment-header" style="display:flex;justify-content:space-between;align-items:center">
          <span><strong>${esc(nameOf(c.author_id))}</strong> commented ${timeAgo(c.created_at)}</span>
          <span style="display:flex;gap:4px">
            ${c.author_id === 'user' ? `<button onclick="editComment('${c.id}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">edit</button><button onclick="deleteComment('${c.id}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">delete</button>` : ''}
          </span>
        </div>
        <div class="timeline-comment-body markdown-body" id="comment-body-${c.id}">${renderMd(c.body)}</div>
        ${reactionBar('comment', c.id, c.reactions)}
      </div>
    </div>`;
  }).join('');

  document.getElementById('issue-page').innerHTML = `
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;gap:8px" id="title-display">
        <h2 style="flex:1;font-size:22px;font-weight:600">${esc(issue.title)} <span style="color:var(--text-secondary);font-weight:400">#${issue.number}</span></h2>
        <button class="btn btn-sm" onclick="startEditTitle()">Edit</button>
      </div>
      <div id="title-edit" style="display:none;margin-bottom:8px">
        <div style="display:flex;gap:8px">
          <input type="text" id="edit-title-input" style="flex:1;padding:6px 10px;font-size:16px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg)">
          <button class="btn btn-sm btn-primary" onclick="saveTitle()">Save</button>
          <button class="btn btn-sm" onclick="cancelEditTitle()">Cancel</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px">
        ${statusIcon(issue.status)}
        <span style="font-weight:500">${issue.status.replace('_',' ')}</span>
        ${priorityBadge(issue.priority)} ${labels}
        <span style="color:var(--text-secondary)">${esc(nameOf(issue.created_by))} opened ${timeAgo(issue.created_at)} · ${allEntries.filter(c=>c.event_type==='comment').length} comments</span>
      </div>
    </div>

    <div class="issue-detail-layout">
      <div class="issue-detail-main">
        <div class="issue-body">
          <div class="issue-body-header" style="display:flex;justify-content:space-between;align-items:center">
            <span style="display:flex;align-items:center;gap:6px">${avatarSvg(nameOf(issue.created_by), 20)} <strong>${esc(nameOf(issue.created_by))}</strong></span>
            <button onclick="startEditBody()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">edit</button>
          </div>
          <div class="issue-body-content" id="body-display">
            <div class="markdown-body">${renderMd(issue.body)}</div>
            ${reactionBar('issue', issue.id, issue.reactions)}
          </div>
          <div id="body-edit" style="display:none;padding:12px">
            <textarea id="edit-body-input" rows="8" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:13px;font-family:inherit;resize:vertical"></textarea>
            <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">
              <button class="btn btn-sm" onclick="cancelEditBody()">Cancel</button>
              <button class="btn btn-sm btn-primary" onclick="saveBody()">Save</button>
            </div>
          </div>
        </div>

        ${timeline ? `<div class="timeline">${timeline}</div>` : ''}

        <div class="comment-box" style="margin-top:16px">
          <textarea id="comment-input" placeholder="Leave a comment... (Markdown supported)"></textarea>
          <div class="comment-box-footer" style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;color:var(--text-secondary)">Markdown · #N auto-links</span>
            <button class="btn btn-sm btn-primary" onclick="addComment()">Comment</button>
          </div>
        </div>
      </div>

      <div class="issue-detail-sidebar">
        <div class="sidebar-section">
          <div class="sidebar-section-title">Status</div>
          <select id="detail-status" onchange="updateField('status',this.value)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">
            <option value="open" ${issue.status==='open'?'selected':''}>Open</option>
            <option value="in_progress" ${issue.status==='in_progress'?'selected':''}>In Progress</option>
            <option value="done" ${issue.status==='done'?'selected':''}>Done</option>
            <option value="closed" ${issue.status==='closed'?'selected':''}>Closed</option>
          </select>
        </div>
        <div class="sidebar-section">
          <div class="sidebar-section-title">Assignee</div>
          <select id="detail-assign" onchange="updateField('assigned_to',this.value||null)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">
            ${assignOpts}
          </select>
        </div>
        <div class="sidebar-section">
          <div class="sidebar-section-title">Labels</div>
          <input type="text" id="detail-labels" value="${esc(issue.labels||'')}" placeholder="bug, feature" onchange="updateField('labels',this.value)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">
        </div>
        <div class="sidebar-section">
          <div class="sidebar-section-title">Priority</div>
          ${priorityBadge(issue.priority)}
        </div>
        <div style="margin-top:12px;display:flex;gap:6px;flex-direction:column">
          ${issue.status !== 'closed' ? `<button class="btn btn-sm" onclick="updateField('status','closed')" style="color:var(--error)">Close Issue</button>` : `<button class="btn btn-sm" onclick="updateField('status','open')" style="color:var(--success)">Reopen</button>`}
          ${issue.status === 'open' ? `<button class="btn btn-sm btn-danger" onclick="deleteIssue()">Delete</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

// ─── Inline editing ───

function startEditTitle() {
  document.getElementById('title-display').style.display = 'none';
  document.getElementById('title-edit').style.display = '';
  document.getElementById('edit-title-input').value = issueData.title;
  document.getElementById('edit-title-input').focus();
}
function cancelEditTitle() {
  document.getElementById('title-display').style.display = '';
  document.getElementById('title-edit').style.display = 'none';
}
async function saveTitle() {
  const v = document.getElementById('edit-title-input').value.trim();
  if (!v) return;
  await fetch(`/api/issues/${issueId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ title: v, actor: 'user' }) });
  await loadIssue();
}
function startEditBody() {
  document.getElementById('body-display').style.display = 'none';
  document.getElementById('body-edit').style.display = '';
  document.getElementById('edit-body-input').value = issueData.body;
  document.getElementById('edit-body-input').focus();
}
function cancelEditBody() {
  document.getElementById('body-display').style.display = '';
  document.getElementById('body-edit').style.display = 'none';
}
async function saveBody() {
  const v = document.getElementById('edit-body-input').value;
  await fetch(`/api/issues/${issueId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ body: v, actor: 'user' }) });
  await loadIssue();
}

// ─── Actions ───

async function updateField(field, value) {
  const body = {}; body[field] = value; body.actor = 'user';
  await fetch(`/api/issues/${issueId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
  await loadIssue();
}
async function deleteIssue() {
  if (!confirm('Delete this issue?')) return;
  const res = await fetch(`/api/issues/${issueId}`, { method: 'DELETE' });
  if (res.ok) { showToast('Issue已删除', 'success'); history.back(); } else showToast('只能删除open状态的issue', 'error');
}
async function addComment() {
  const body = document.getElementById('comment-input').value.trim();
  if (!body) return;
  const res = await fetch(`/api/issues/${issueId}/comments`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ author_id: 'user', body }) });
  if (res.ok) showToast('评论已添加', 'success');
  await loadIssue();
}
async function editComment(cid) {
  const c = issueData.comments.find(x => x.id === cid);
  if (!c) return;
  // Inline edit — replace body with textarea
  const el = document.getElementById('comment-body-' + cid);
  if (!el) return;
  const oldHtml = el.innerHTML;
  el.innerHTML = `<textarea id="edit-comment-${cid}" rows="4" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:13px;font-family:inherit">${esc(c.body)}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">
      <button class="btn btn-sm" onclick="loadIssue()">Cancel</button>
      <button class="btn btn-sm btn-primary" onclick="saveComment('${cid}')">Save</button>
    </div>`;
}
async function saveComment(cid) {
  const v = document.getElementById('edit-comment-' + cid)?.value;
  if (!v) return;
  const res = await fetch(`/api/comments/${cid}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ body: v }) });
  if (res.ok) showToast('评论已保存', 'success');
  await loadIssue();
}
async function deleteComment(cid) {
  if (!confirm('Delete this comment?')) return;
  await fetch(`/api/comments/${cid}`, { method: 'DELETE' });
  await loadIssue();
}

loadIssue();

// Connect to project WebSocket for real-time comment updates
// Set up after first load when we know the projectId
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
