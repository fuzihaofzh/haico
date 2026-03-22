const projectId = window.location.pathname.split('/').pop();
let projectData = null;
let agentsData = [];

function apiHeaders() { return { 'Content-Type': 'application/json' }; }

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

async function withLoading(btn, asyncFn) {
  if (!btn || btn.disabled) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = originalText + '…';
  try {
    await asyncFn();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function priorityBadge(p) {
  if (p >= 10) return '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(220,50,47,0.15);color:var(--error)">USER</span>';
  if (p >= 5) return '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(181,137,0,0.15);color:var(--warning)">CTRL</span>';
  return '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(88,110,117,0.15);color:var(--text-secondary)">AGENT</span>';
}

function statusBadge(s) {
  const map = {
    'open':        '<span class="status-badge status-active">open</span>',
    'in_progress': '<span class="status-badge status-running">in progress</span>',
    'done':        '<span class="status-badge status-completed">done</span>',
    'closed':      '<span class="status-badge status-idle">closed</span>',
  };
  return map[s] || s;
}

// Resolve names
function nameOf(id) {
  if (id === 'user') return 'User';
  if (id === 'all') return 'All';
  const a = agentsData.find(x => x.id === id);
  return a ? a.name : id;
}

// ─── Project ───

async function loadProject() {
  const res = await fetch(`/api/projects/${projectId}`, { headers: apiHeaders() });
  if (!res.ok) { alert('Failed to load project'); return; }
  projectData = await res.json();

  document.getElementById('project-name').textContent = projectData.name;
  document.getElementById('project-title').textContent = projectData.name;
  document.getElementById('project-status').textContent = projectData.status;
  document.getElementById('project-status').className = `status-badge status-${projectData.status}`;
  document.title = `Argus - ${projectData.name}`;

  // Editable fields (only set on first load to avoid overwriting user edits)
  if (!window._overviewLoaded) {
    window._overviewLoaded = true;
    document.getElementById('project-name-edit').value = projectData.name;
    document.getElementById('project-desc-edit').value = projectData.description || '';
    document.getElementById('project-task').value = projectData.task_description || '';
    document.getElementById('project-cmd').value = projectData.command_template;
    document.getElementById('project-interval-edit').value = projectData.controller_interval_min;
    document.getElementById('project-schedule').value = projectData.schedule_hours || '';
  }
  document.getElementById('project-created').textContent = projectData.created_at;

  document.getElementById('btn-toggle').innerHTML = projectData.status === 'active' ? '⏸' : '▶';
  document.getElementById('btn-toggle').title = projectData.status === 'active' ? 'Pause' : 'Resume';
  document.getElementById('btn-trigger').style.display = projectData.status === 'active' ? '' : 'none';

  // Load cost
  fetch(`/api/projects/${projectId}/costs`, { headers: apiHeaders() }).then(r => r.ok ? r.json() : null).then(c => {
    if (c && c.total_cost_usd > 0) {
      document.getElementById('project-cost').style.display = '';
      document.getElementById('project-cost-value').textContent = `$${c.total_cost_usd.toFixed(4)} (${c.total_input_tokens} in / ${c.total_output_tokens} out)`;
    }
  }).catch(() => {});
}

async function toggleProjectStatus() {
  if (!projectData) return;
  const newStatus = projectData.status === 'active' ? 'paused' : 'active';
  const res = await fetch(`/api/projects/${projectId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: newStatus }) });
  if (!res.ok) alert('Failed to update status');
  loadProject();
}

async function triggerController() {
  const btn = event ? event.target : null;
  const run = async () => {
    const controller = agentsData.find(a => a.is_controller);
    if (!controller) { alert('No controller agent found'); return; }
    if (controller.status === 'running') { alert('Controller is already running'); return; }
    const res = await fetch(`/api/agents/${controller.id}/start`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) { loadAgents(); } else { const err = await res.json().catch(() => ({})); alert('Error: ' + (err.error || 'Unknown')); }
  };
  if (btn) await withLoading(btn, run); else await run();
}

async function saveOverview() {
  const body = {
    name: document.getElementById('project-name-edit').value.trim(),
    description: document.getElementById('project-desc-edit').value.trim(),
    task_description: document.getElementById('project-task').value.trim(),
    command_template: document.getElementById('project-cmd').value.trim() || 'cld',
    controller_interval_min: parseInt(document.getElementById('project-interval-edit').value) || 5,
    schedule_hours: document.getElementById('project-schedule').value.trim(),
  };
  if (!body.name) { alert('Name cannot be empty'); return; }
  if (!body.task_description) { alert('Task description cannot be empty'); return; }
  const btn = document.querySelector('button[onclick="saveOverview()"]');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/projects/${projectId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) { window._overviewLoaded = false; loadProject(); }
    else alert('Failed to save');
  });
}

async function deleteProject() {
  if (!confirm('Delete this project and all agents/issues?')) return;
  const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
  if (res.ok) { window.location.href = '/'; }
  else { alert('Failed to delete project'); }
}

// ─── Agents ───

async function loadAgents() {
  const res = await fetch(`/api/projects/${projectId}/agents`, { headers: apiHeaders() });
  agentsData = await res.json();
  const list = document.getElementById('agent-list');

  // Update tab count
  updateTabCounts();

  if (!agentsData.length) { list.innerHTML = '<li class="empty-state">No agents yet.</li>'; return; }

  // Update issue assign dropdown (preserve current selection)
  const assignSel = document.getElementById('issue-assign');
  if (assignSel) {
    const prev = assignSel.value;
    assignSel.innerHTML = '<option value="">Unassigned</option><option value="all">All (broadcast)</option><option value="user">User (me)</option>';
    agentsData.forEach(a => { assignSel.innerHTML += `<option value="${a.id}">${esc(a.name)}</option>`; });
    if (prev) assignSel.value = prev;
  }

  // Fetch errors
  const errorLogs = {};
  await Promise.all(agentsData.filter(a => a.status === 'error').map(async (a) => {
    try {
      const r = await fetch(`/api/agents/${a.id}/logs?limit=5`, { headers: apiHeaders() });
      if (r.ok) {
        // Use status API for last_error instead of raw logs
        const sr = await fetch(`/api/agents/${a.id}/status`, { headers: apiHeaders() });
        if (sr.ok) { const st = await sr.json(); errorLogs[a.id] = st.last_error || ''; }
      }
    } catch (e) { console.error('Failed to fetch error logs for agent', a.id, e); }
  }));

  // Error banner for agents in error state
  const errorAgents = agentsData.filter(a => a.status === 'error');
  const bannerEl = document.getElementById('agent-error-banner');
  if (bannerEl) {
    if (errorAgents.length > 0) {
      bannerEl.style.display = '';
      bannerEl.innerHTML = errorAgents.map(a => {
        const errMsg = errorLogs[a.id] ? esc(errorLogs[a.id].slice(0, 300)) : 'Unknown error';
        return `<div style="margin-bottom:4px"><strong>${esc(a.name)}</strong> failed: <span style="font-family:monospace;font-size:11px">${errMsg}</span>
          <button class="btn btn-sm" onclick="retryAgent('${a.id}')" style="margin-left:8px;color:var(--warning);padding:2px 8px">Retry</button></div>`;
      }).join('');
    } else {
      bannerEl.style.display = 'none';
      bannerEl.innerHTML = '';
    }
  }

  // Browser notification for newly errored agents
  if ('Notification' in window && Notification.permission === 'granted') {
    for (const a of errorAgents) {
      if (!window._notifiedErrors) window._notifiedErrors = new Set();
      const key = a.id + ':' + (a.finished_at || '');
      if (!window._notifiedErrors.has(key)) {
        window._notifiedErrors.add(key);
        new Notification('Argus: Agent Error', { body: `${a.name} failed. ${(errorLogs[a.id] || '').slice(0, 100)}`, tag: 'argus-error-' + a.id });
      }
    }
  }

  list.innerHTML = agentsData.map(a => {
    const tag = a.is_controller ? ' <span style="color:var(--accent);font-size:11px">[controller]</span>' : '';
    const errBox = a.status === 'error' && errorLogs[a.id]
      ? `<div style="margin-top:4px;padding:6px 8px;background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.3);border-radius:4px;font-size:11px;color:var(--error);font-family:monospace;max-height:60px;overflow:auto;white-space:pre-wrap">${esc(errorLogs[a.id].slice(0, 500))}</div>` : '';
    const spinner = a.status === 'running' ? '<span class="thinking-spinner">✦</span> ' : '';
    const deleteBtn = !a.is_controller && a.status !== 'running'
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();deleteAgent('${a.id}')" style="color:var(--error);padding:3px 6px" title="Delete">✕</button>` : '';
    const retryBtn = a.status === 'error' && a.last_prompt
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();retryAgent('${a.id}')" style="color:var(--warning);padding:3px 6px" title="Retry last prompt">Retry</button>` : '';
    const actions = a.status !== 'running'
      ? `${retryBtn}<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();quickStartAgent('${a.id}')">Start</button>${deleteBtn}`
      : `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();stopAgentById('${a.id}')">Stop</button>`;
    const selected = currentAgentId === a.id ? 'background:var(--selected-bg);' : '';
    return `
    <li class="agent-item" style="cursor:pointer;${selected}" onclick="viewAgent('${a.id}')">
      <div style="flex-shrink:0;margin-right:8px">${avatarSvg(a.name, 32)}</div>
      <div class="agent-info">
        <div class="agent-name">${spinner}${esc(a.name)}${tag}</div>
        <div class="agent-role">${esc(a.role)}</div>
        ${errBox}
      </div>
      <div class="flex" style="gap:8px">
        <span class="status-badge status-${a.status}">${a.status}</span>
        ${actions}
      </div>
    </li>`;
  }).join('');
}

let currentAgentId = null;

async function viewAgent(agentId) {
  currentAgentId = agentId;
  // Highlight selected in list
  document.querySelectorAll('#agent-list .agent-item').forEach(li => li.style.background = '');
  event?.target?.closest?.('.agent-item')?.style && (event.target.closest('.agent-item').style.background = 'var(--selected-bg)');

  const el = document.getElementById('agent-detail');
  el.style.display = '';
  el.innerHTML = '<div class="card"><div style="color:var(--text-secondary);padding:16px">Loading...</div></div>';

  try {
    const agentRes = await fetch(`/api/agents/${agentId}`, { headers: apiHeaders() });
    const agent = agentRes.ok ? await agentRes.json() : agentsData.find(a => a.id === agentId);

    const L = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:4px';
    const B = 'padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px';

    // Step 1: Render config immediately (no logs yet)
    el.innerHTML = `
      <div class="card" style="padding:0">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
          <div class="flex-between">
            <h3 style="display:flex;align-items:center;gap:8px">${avatarSvg(agent.name, 28)} ${esc(agent.name)} ${agent.is_controller ? '<span style="color:var(--accent);font-size:12px">[controller]</span>' : ''}</h3>
            ${agent.status === 'error' && agent.last_prompt ? `<button class="btn btn-sm" onclick="retryAgent('${agentId}')" style="color:var(--warning)">Retry</button>` : ''}
            <span class="status-badge status-${agent.status}">${agent.status}${agent.pid ? ' (PID:' + agent.pid + ')' : ''}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${esc(agent.role)}</div>
        </div>

        <div id="agent-detail-scroll" style="padding:16px 20px;max-height:700px;overflow-y:auto;overflow-x:hidden">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px;font-size:12px;color:var(--text-secondary);margin-bottom:16px">
            <div>Started: <span style="color:var(--fg)">${agent.started_at || '-'}</span></div>
            <div>Finished: <span style="color:var(--fg)">${agent.finished_at || '-'}</span></div>
            <div>Session: <code style="color:var(--fg);font-size:10px">${agent.session_id ? agent.session_id.slice(0, 8) + '...' : 'none'}</code></div>
          </div>

          <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="${L}">Working Directory</div>
              <div style="display:flex;gap:4px">
                <input type="text" id="ad-workdir-${agentId}" value="${esc(agent.working_directory || '')}" placeholder="(default)" style="${B};flex:1;font-size:12px;font-family:monospace;color:var(--fg)">
                <button class="btn btn-sm" onclick="saveAgentField('${agentId}','working_directory',document.getElementById('ad-workdir-${agentId}').value)">Save</button>
              </div>
            </div>
            <div style="width:160px">
              <div style="${L}">Session Mode</div>
              <select onchange="updateAgentSessionMode('${agentId}', this.value)" style="${B};width:100%;font-size:12px;color:var(--fg)">
                <option value="continue" ${!agent.new_session_per_run ? 'selected' : ''}>Continue previous</option>
                <option value="new" ${agent.new_session_per_run ? 'selected' : ''}>New each run</option>
              </select>
            </div>
          </div>

          <div style="margin-bottom:16px">
            <div style="${L}">Custom Instructions</div>
            <div style="display:flex;gap:4px;align-items:flex-start">
              <textarea id="ad-instructions-${agentId}" rows="3" style="${B};flex:1;font-size:12px;font-family:inherit;color:var(--fg);resize:vertical" placeholder="Extra instructions appended to system prompt...">${esc(agent.custom_instructions || '')}</textarea>
              <button class="btn btn-sm" onclick="saveAgentField('${agentId}','custom_instructions',document.getElementById('ad-instructions-${agentId}').value)">Save</button>
            </div>
          </div>

          <div style="margin-bottom:16px">
            <div style="${L};cursor:pointer;user-select:none" onclick="toggleAgentSystemPrompt('${agentId}')">
              <span id="agent-sysprompt-arrow-${agentId}">▶</span> System Prompt (auto-generated)
            </div>
            <pre id="agent-sysprompt-${agentId}" style="display:none;${B};font-size:11px;max-height:400px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary);margin:0"></pre>
          </div>

          <div>
            <div style="${L}">Recent Output</div>
            <div id="agent-output-${agentId}" style="color:var(--text-secondary);font-size:12px">Loading output...</div>
          </div>
        </div>
      </div>
    `;

    // Step 2: Load logs async (doesn't block config display)
    loadAgentOutput(agentId);

  } catch (e) {
    el.innerHTML = '<div class="card"><div style="color:var(--error);padding:16px">Failed to load agent details.</div></div>';
  }
}

async function loadAgentOutput(agentId) {
  const container = document.getElementById('agent-output-' + agentId);
  if (!container) return;
  try {
    const logsRes = await fetch(`/api/agents/${agentId}/logs?limit=100`, { headers: apiHeaders() });
    const logs = logsRes.ok ? await logsRes.json() : [];
    logs.reverse();

    // Group by run, only show last 3 runs
    const runs = [];
    let curRun = null;
    for (const l of logs) {
      if (l.run_id !== curRun) { curRun = l.run_id; runs.push({ id: l.run_id, logs: [] }); }
      runs[runs.length - 1].logs.push(l);
    }
    // Show last 5 runs, oldest first (newest at bottom)
    const recentRuns = runs.slice(-5);

    const html = recentRuns.map((run, idx) => {
      const filtered = run.logs.filter(l =>
        l.stream !== 'stdin' && l.stream !== 'cost' && !l.content.includes('proxychains') &&
        !l.content.includes('Executing through proxy') && !l.content.includes('Port 7897')
      );
      if (!filtered.length) return '';
      const content = filtered.map(l => {
        const text = l.content.length > 1500 ? l.content.slice(0, 1500) + '\n... (truncated)' : l.content;
        return l.stream === 'stderr' ? `<span style="color:var(--error)">${esc(text)}</span>` : esc(text);
      }).join('');
      const label = idx === recentRuns.length - 1 ? 'Latest Run' : `${recentRuns.length - idx} runs ago`;
      return `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:600;color:var(--text-secondary);margin-bottom:2px">${label}</div><div>${content}</div></div>`;
    }).filter(Boolean).join('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');

    container.innerHTML = html
      ? `<pre style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0;line-height:1.5;overflow-x:hidden;max-height:400px;overflow-y:auto">${html}</pre>`
      : '<span style="color:var(--text-secondary)">No output yet.</span>';

    // Scroll to bottom
    const scroll = document.getElementById('agent-detail-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  } catch {
    container.innerHTML = '<span style="color:var(--error)">Failed to load output.</span>';
  }
}

async function saveAgentField(agentId, field, value) {
  const body = {};
  body[field] = value || null;
  const res = await fetch(`/api/agents/${agentId}`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
  if (!res.ok) alert('Failed to save');
}

async function updateAgentSessionMode(agentId, mode) {
  await fetch(`/api/agents/${agentId}`, {
    method: 'PUT', headers: apiHeaders(),
    body: JSON.stringify({ new_session_per_run: mode === 'new' }),
  });
}

async function toggleAgentSystemPrompt(agentId) {
  const el = document.getElementById('agent-sysprompt-' + agentId);
  const arrow = document.getElementById('agent-sysprompt-arrow-' + agentId);
  if (!el) return;
  if (el.style.display !== 'none') {
    el.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
    return;
  }
  el.style.display = '';
  if (arrow) arrow.textContent = '▼';
  if (el.textContent) return;
  el.textContent = 'Loading...';
  try {
    const res = await fetch(`/api/agents/${agentId}/system-prompt`, { headers: apiHeaders() });
    if (res.ok) { const data = await res.json(); el.textContent = data.prompt; }
    else { el.textContent = 'Failed to load'; }
  } catch { el.textContent = 'Failed to load'; }
}

function closeAgentDetail() {
  console.log('closeAgentDetail called');
  currentAgentId = null;
  const el = document.getElementById('agent-detail');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  document.querySelectorAll('#agent-list .agent-item').forEach(li => li.style.background = '');
}

async function deleteAgent(id) {
  const agent = agentsData.find(a => a.id === id);
  if (!confirm(`Delete agent "${agent?.name || id}"?`)) return;
  const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
  if (res.ok) {
    if (currentAgentId === id) closeAgentDetail();
    loadAgents();
  } else { alert('Failed to delete agent'); }
}

async function retryAgent(id) {
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/retry`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) loadAgents(); else { const e = await res.json().catch(() => ({})); alert('Error: ' + (e.error || 'Unknown')); }
  });
}

async function quickStartAgent(id) {
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/start`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) loadAgents(); else { const e = await res.json().catch(() => ({})); alert('Error: ' + (e.error || 'Unknown')); }
  });
}
async function stopAgentById(id) {
  if (!confirm('Stop this agent?')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/stop`, { method: 'POST', headers: apiHeaders() });
    if (!res.ok) { const e = await res.json().catch(() => ({})); alert('Failed: ' + (e.error || 'Unknown')); }
    loadAgents();
  });
}

function showCreateAgentModal() {
  document.getElementById('agent-name').value = '';
  document.getElementById('agent-role').value = '';
  document.getElementById('agent-workdir').value = '';
  document.getElementById('createAgentModal').classList.add('active');
}
function hideModal(id) { document.getElementById(id).classList.remove('active'); }

async function createAgent() {
  const btn = document.querySelector('#createAgentModal button[onclick="createAgent()"]');
  await withLoading(btn, async () => {
    const body = { name: document.getElementById('agent-name').value, role: document.getElementById('agent-role').value, working_directory: document.getElementById('agent-workdir').value || undefined };
    if (!body.name) { alert('Name is required'); return; }
    const res = await fetch(`/api/projects/${projectId}/agents`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) { hideModal('createAgentModal'); loadAgents(); } else { const e = await res.json().catch(() => ({})); alert('Error: ' + (e.error || 'Unknown')); }
  });
}

// ─── Issues ───

let currentIssueFilter = 'open';
let currentIssuePage = 1;

const LABEL_COLORS = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#b5bd68','#cc6666','#8abeb7'];
function issueLabelHtml(text) {
  const h = hashCode(text.trim());
  const bg = LABEL_COLORS[h % LABEL_COLORS.length];
  return `<span style="font-size:10px;padding:1px 6px;border-radius:12px;background:${bg}22;color:${bg};border:1px solid ${bg}44">${esc(text.trim())}</span>`;
}

async function loadIssues() {
  const sort = document.getElementById('issue-sort')?.value || 'priority';
  const q = document.getElementById('issue-search')?.value?.trim() || '';

  // Fetch all to get counts
  const allRes = await fetch(`/api/projects/${projectId}/issues?per_page=200`, { headers: apiHeaders() });
  const allData = await allRes.json();
  const allIssues = allData.issues || allData || [];
  const counts = { open: 0, in_progress: 0, done: 0, closed: 0 };
  allIssues.forEach(i => { if (counts[i.status] !== undefined) counts[i.status]++; });
  issueCount = allIssues.length;
  updateTabCounts();

  // Filter tabs
  const tabs = document.getElementById('issue-filter-tabs');
  if (tabs) {
    const filters = [
      { key: 'open', label: 'Open', count: counts.open, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#3fb950" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#3fb950"/>' },
      { key: 'in_progress', label: 'In Progress', count: counts.in_progress, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#d29922"/>' },
      { key: 'done', label: 'Done', count: counts.done, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
      { key: 'closed', label: 'Closed', count: counts.closed, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="gray" stroke-width="2"/><line x1="5" y1="5" x2="11" y2="11" stroke="gray" stroke-width="1.5"/><line x1="11" y1="5" x2="5" y2="11" stroke="gray" stroke-width="1.5"/>' },
      { key: '', label: 'All', count: allIssues.length },
    ];
    tabs.innerHTML = filters.map(f =>
      `<span onclick="setIssueFilter('${f.key}')" style="cursor:pointer;padding:4px 10px;border-radius:6px;${currentIssueFilter===f.key?'background:var(--selected-bg);font-weight:600':'color:var(--text-secondary)'}">
        ${f.icon ? `<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px">${f.icon}</svg>` : ''}
        ${f.count} ${f.label}
      </span>`
    ).join('');
  }

  // Fetch filtered + sorted + paginated
  let url = `/api/projects/${projectId}/issues?sort=${sort}&page=${currentIssuePage}&per_page=30`;
  if (currentIssueFilter) url += `&status=${currentIssueFilter}`;
  if (q) url += `&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: apiHeaders() });
  const data = await res.json();
  const issues = data.issues || [];

  const container = document.getElementById('issue-list');
  if (!issues.length) { container.innerHTML = '<div class="card"><div class="empty-state">No issues.</div></div>'; renderPagination(0, 0); return; }

  container.innerHTML = `<div class="card" style="padding:0">${issues.map(i => {
    const labels = i.labels ? i.labels.split(',').filter(l=>l.trim()).map(l => issueLabelHtml(l)).join(' ') : '';
    const icon = (i.status === 'open' || i.status === 'in_progress')
      ? `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="${i.status==='in_progress'?'#d29922':'#3fb950'}" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="${i.status==='in_progress'?'#d29922':'#3fb950'}"/></svg>`
      : '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `<a href="/projects/${projectId}/issues/${i.number}" class="issue-list-item" style="text-decoration:none;color:inherit">
      <div style="flex-shrink:0;margin-top:2px">${icon}</div>
      <div class="issue-main">
        <div class="issue-title-row"><span class="issue-title">${esc(i.title)}</span> ${labels}</div>
        <div class="issue-meta">#${i.number} by ${nameOf(i.created_by)} · ${i.assigned_to ? nameOf(i.assigned_to) : 'unassigned'} · ${timeAgo(i.created_at)}</div>
      </div>
      ${i.assigned_to ? `<div style="flex-shrink:0">${avatarSvg(nameOf(i.assigned_to), 22)}</div>` : ''}
    </a>`;
  }).join('')}</div>`;

  renderPagination(data.total_pages || 1, data.page || 1);
}

function renderPagination(totalPages, currentPage) {
  const el = document.getElementById('issue-pagination');
  if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }
  let html = '';
  for (let p = 1; p <= Math.min(totalPages, 10); p++) {
    html += `<button onclick="goToIssuePage(${p})" class="btn btn-sm" style="${p===currentPage?'background:var(--accent);color:#fff':''}">${p}</button>`;
  }
  el.innerHTML = html;
}

function goToIssuePage(p) { currentIssuePage = p; loadIssues(); }
function setIssueFilter(f) { currentIssueFilter = f; currentIssuePage = 1; loadIssues(); }
function searchIssues() { currentIssuePage = 1; loadIssues(); }


function timeAgo(dateStr) {
  const d = new Date(dateStr + 'Z');
  const now = new Date();
  const s = Math.floor((now - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function showCreateIssueModal() {
  document.getElementById('issue-title').value = '';
  document.getElementById('issue-body').value = '';
  document.getElementById('issue-labels').value = '';
  const sel = document.getElementById('issue-assign');
  if (sel) sel.selectedIndex = 0;
  document.getElementById('createIssueModal').classList.add('active');
}

async function createIssue() {
  const btn = document.querySelector('#createIssueModal button[onclick="createIssue()"]');
  await withLoading(btn, async () => {
    const body = {
      title: document.getElementById('issue-title').value,
      body: document.getElementById('issue-body').value,
      created_by: 'user',
      assigned_to: document.getElementById('issue-assign').value || undefined,
      labels: document.getElementById('issue-labels').value || undefined,
    };
    if (!body.title) { alert('Title is required'); return; }
    const res = await fetch(`/api/projects/${projectId}/issues`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) { hideModal('createIssueModal'); loadIssues(); } else { const e = await res.json().catch(() => ({})); alert('Error: ' + (e.error || 'Unknown')); }
  });
}

// ─── Tabs ───

let issueCount = 0;
async function updateTabCounts() {
  const tabs = document.querySelectorAll('.tab-bar .tab');
  tabs.forEach(t => {
    const text = t.textContent.replace(/\s*\(\d+\)/, '').trim().toLowerCase();
    if (text === 'agents') t.textContent = `Agents (${agentsData.length})`;
    else if (text === 'issues') t.textContent = `Issues (${issueCount})`;
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-bar .tab').forEach(t => {
    if (t.textContent.replace(/\s*\(\d+\)/, '').trim().toLowerCase() === tab) t.classList.add('active');
  });
  document.getElementById('tab-overview').style.display = tab === 'overview' ? '' : 'none';
  document.getElementById('tab-agents').style.display = tab === 'agents' ? '' : 'none';
  document.getElementById('tab-issues').style.display = tab === 'issues' ? '' : 'none';
  document.getElementById('tab-activity').style.display = tab === 'activity' ? '' : 'none';
  if (tab === 'issues') loadIssues();
  if (tab === 'activity') loadActivity();
}

async function loadActivity() {
  const container = document.getElementById('activity-list');
  try {
    const res = await fetch(`/api/projects/${projectId}/activity?limit=200`, { headers: apiHeaders() });
    if (!res.ok) return;
    const events = await res.json();

    if (!events.length) { container.innerHTML = '<div class="empty-state">No activity yet.</div>'; return; }

    container.innerHTML = events.map(e => {
      const time = timeAgo(e.time);
      if (e.event_type === 'issue') {
        const icon = e.status === 'open' ? '●' : '✓';
        const color = e.status === 'open' ? 'var(--success)' : (e.status === 'closed' ? 'var(--text-secondary)' : 'var(--accent)');
        return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:${color};flex-shrink:0">${icon}</span>
          <div><strong>${esc(nameOf(e.actor))}</strong> ${e.status === 'open' ? 'opened' : 'updated'} issue <strong>#${e.number}</strong> ${esc(e.title)} <span style="color:var(--text-secondary)">${time}</span></div>
        </div>`;
      } else if (e.event_type === 'comment') {
        return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:var(--text-secondary);flex-shrink:0">💬</span>
          <div><strong>${esc(nameOf(e.actor))}</strong> commented on <strong>#${e.issue_number}</strong> ${esc(e.issue_title)} <span style="color:var(--text-secondary)">${time}</span>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${esc((e.body || '').slice(0, 150))}</div></div>
        </div>`;
      } else if (e.event_type === 'agent_run') {
        const color = e.agent_status === 'running' ? 'var(--success)' : (e.agent_status === 'error' ? 'var(--error)' : 'var(--text-secondary)');
        return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:${color};flex-shrink:0">⚡</span>
          <div>Agent <strong>${esc(e.name)}</strong> [${e.agent_status}] <span style="color:var(--text-secondary)">${time}</span></div>
        </div>`;
      }
      return '';
    }).join('');
  } catch { container.innerHTML = '<div class="empty-state">Failed to load activity.</div>'; }
}

// ─── Init ───
loadProject();
loadAgents();

// Slow fallback polling (WS handles real-time)
setInterval(loadAgents, 30000);

// Connect to project-level WebSocket for real-time updates
const _projectEvents = connectProjectEvents(projectId);

_projectEvents.on('agent_status', function(data) {
  loadAgents();
  // If viewing this agent's detail, refresh output too
  if (currentAgentId === data.agentId) {
    loadAgentOutput(data.agentId);
  }
});

_projectEvents.on('issue_created', function() {
  loadIssues();
});

_projectEvents.on('issue_updated', function() {
  loadIssues();
});

_projectEvents.on('comment_added', function() {
  loadIssues();
});

// Handle hash navigation (e.g., #issues or #agents from dashboard)
const hash = window.location.hash.replace('#', '');
if (['overview', 'agents', 'issues'].includes(hash)) {
  setTimeout(() => switchTab(hash), 500);
}
