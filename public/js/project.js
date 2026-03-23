const projectId = window.location.pathname.split('/').pop();
let projectData = null;
let agentsData = [];

function statusBadge(s) {
  const map = {
    'open':        '<span class="status-badge status-active">open</span>',
    'in_progress': '<span class="status-badge status-running">in progress</span>',
    'done':        '<span class="status-badge status-completed">done</span>',
    'closed':      '<span class="status-badge status-idle">closed</span>',
  };
  return map[s] || s;
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
  if (res.ok) showToast('状态已更新', 'success');
  else showToast('状态更新失败', 'error');
  loadProject();
}

async function triggerController() {
  const btn = event ? event.target : null;
  const run = async () => {
    const controller = agentsData.find(a => a.is_controller);
    if (!controller) { alert('No controller agent found'); return; }
    if (controller.status === 'running') { alert('Controller is already running'); return; }
    const res = await fetch(`/api/agents/${controller.id}/start`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) { loadAgents(); showToast('Controller已启动', 'success'); } else { const err = await res.json().catch(() => ({})); showToast(err.error || '启动失败', 'error'); }
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
    if (res.ok) { window._overviewLoaded = false; loadProject(); showToast('已保存', 'success'); }
    else showToast('保存失败', 'error');
  });
}

async function deleteProject() {
  if (!confirm('Delete this project and all agents/issues?')) return;
  const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
  if (res.ok) { showToast('项目已删除', 'success'); window.location.href = '/'; }
  else { showToast('删除失败', 'error'); }
}

// ─── Agents ───

async function loadAgents() {
  const res = await fetch(`/api/projects/${projectId}/agents`, { headers: apiHeaders() });
  agentsData = await res.json();
  const list = document.getElementById('agent-list');

  // Update tab count
  updateTabCounts();

  if (!agentsData.length) { list.innerHTML = '<li class="empty-state">No agents yet.</li>'; return; }

  // Update issue assign dropdown (preserve current selection, default to controller)
  const assignSel = document.getElementById('issue-assign');
  if (assignSel) {
    const prev = assignSel.value;
    const controllerId = agentsData.find(a => a.is_controller)?.id || '';
    assignSel.innerHTML = '<option value="">Unassigned</option><option value="all">All (broadcast)</option><option value="user">User (me)</option>';
    agentsData.forEach(a => { assignSel.innerHTML += `<option value="${a.id}">${esc(a.name)}${a.is_controller ? ' [controller]' : ''}</option>`; });
    if (prev) assignSel.value = prev;
    else if (controllerId) assignSel.value = controllerId;
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
    const retryBtn = a.status === 'error' && a.last_prompt && !a.paused
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();retryAgent('${a.id}')" style="color:var(--warning);padding:3px 6px" title="Retry last prompt">Retry</button>` : '';
    const pauseBtn = !a.paused
      ? `<button class="btn btn-sm" onclick="event.stopPropagation();pauseAgent('${a.id}')" style="color:var(--warning);padding:3px 6px" title="Pause agent">⏸</button>`
      : `<button class="btn btn-sm" onclick="event.stopPropagation();unpauseAgent('${a.id}')" style="color:var(--success);padding:3px 6px" title="Resume agent">▶</button>`;
    let actions;
    if (a.paused) {
      actions = `${pauseBtn}${deleteBtn}`;
    } else if (a.status === 'running') {
      actions = `${pauseBtn}<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();stopAgentById('${a.id}')">Stop</button>`;
    } else {
      actions = `${pauseBtn}${retryBtn}<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();quickStartAgent('${a.id}')">Start</button>${deleteBtn}`;
    }
    const selected = currentAgentId === a.id ? 'background:var(--selected-bg);' : '';
    const pausedStyle = a.paused ? 'opacity:0.55;' : '';
    return `
    <li class="agent-item" style="cursor:pointer;${selected}${pausedStyle}" onclick="viewAgent('${a.id}')">
      <div style="flex-shrink:0;margin-right:8px">${avatarSvg(a.name, 32)}</div>
      <div class="agent-info">
        <div class="agent-name">${spinner}${esc(a.name)}${tag}</div>
        <div class="agent-role">${esc(a.role)}</div>
        ${errBox}
      </div>
      <div class="flex" style="gap:8px">
        <span class="status-badge status-${a.paused ? 'paused' : a.status}">${a.paused ? 'paused' : a.status}</span>
        ${actions}
      </div>
    </li>`;
  }).join('');

  // Render agent collaboration graph
  // Cache issues for graph node task counts
  fetch(`/api/projects/${projectId}/issues?status=open&per_page=200`, { headers: apiHeaders() })
    .then(r => r.ok ? r.json() : {})
    .then(d => { window._dashboardIssues = d.issues || []; renderAgentGraph(); })
    .catch(() => renderAgentGraph());
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

          <div id="agent-git-status-${agentId}" style="margin-bottom:16px"></div>

          <div id="agent-cost-${agentId}" style="margin-bottom:16px"></div>

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

          <div style="margin-bottom:16px">
            <div style="${L};cursor:pointer;user-select:none" onclick="toggleRunHistory('${agentId}')">
              <span id="agent-runs-arrow-${agentId}">▶</span> Run History
            </div>
            <div id="agent-runs-${agentId}" style="display:none"></div>
          </div>

          <div>
            <div style="${L}">Recent Output</div>
            <div id="agent-output-${agentId}" style="color:var(--text-secondary);font-size:12px">Loading output...</div>
          </div>
        </div>
      </div>
    `;

    // Step 2: Load cost, git status, and logs async (doesn't block config display)
    loadAgentCost(agentId);
    loadAgentGitStatus(agentId);
    loadAgentOutput(agentId);

  } catch (e) {
    el.innerHTML = '<div class="card"><div style="color:var(--error);padding:16px">Failed to load agent details.</div></div>';
  }
}

async function loadAgentCost(agentId) {
  const container = document.getElementById('agent-cost-' + agentId);
  if (!container) return;
  try {
    const res = await fetch(`/api/agents/${agentId}/costs`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    if (data.total_runs === 0) { container.innerHTML = ''; return; }

    const fmtCost = v => v < 0.01 ? '<$0.01' : '$' + v.toFixed(2);
    const fmtTokens = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;
    const avgCost = data.total_runs > 0 ? data.total_cost_usd / data.total_runs : 0;

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:12px">
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Total Cost</div>
          <div style="font-size:16px;font-weight:600;color:var(--accent)">${fmtCost(data.total_cost_usd)}</div>
        </div>
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Avg/Run</div>
          <div style="font-size:16px;font-weight:600">${fmtCost(avgCost)}</div>
        </div>
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Runs</div>
          <div style="font-size:16px;font-weight:600">${data.total_runs}</div>
        </div>
        <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;opacity:0.6;margin-bottom:2px">Tokens</div>
          <div style="font-size:14px;font-weight:600">${fmtTokens(data.total_input_tokens)}↑ ${fmtTokens(data.total_output_tokens)}↓</div>
        </div>
      </div>`;
  } catch {
    container.innerHTML = '';
  }
}

async function loadAgentGitStatus(agentId) {
  const container = document.getElementById('agent-git-status-' + agentId);
  if (!container) return;
  try {
    const res = await fetch(`/api/agents/${agentId}/git-status`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    if (!data.branch) { container.innerHTML = ''; return; }

    const lastCommit = data.recent_commits && data.recent_commits[0]
      ? `<code style="color:var(--accent)">${esc(data.recent_commits[0].hash)}</code> ${esc(data.recent_commits[0].message.slice(0, 50))} <span style="color:var(--text-secondary)">${timeAgo(data.recent_commits[0].date)}</span>`
      : '<span style="color:var(--text-secondary)">no commits</span>';
    const uncommitted = data.has_uncommitted
      ? `<span style="color:var(--warning)"> | ${(data.uncommitted_files || []).length} uncommitted files</span>` : '';

    container.innerHTML = `
      <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px">
        <span style="font-family:monospace;background:var(--card);padding:2px 8px;border-radius:10px;border:1px solid var(--border)">${esc(data.branch)}</span>
        <span style="margin-left:8px">Last commit: ${lastCommit}</span>${uncommitted}
      </div>`;
  } catch {
    container.innerHTML = '';
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
  if (res.ok) showToast('已保存', 'success');
  else showToast('保存失败', 'error');
}

async function updateAgentSessionMode(agentId, mode) {
  const res = await fetch(`/api/agents/${agentId}`, {
    method: 'PUT', headers: apiHeaders(),
    body: JSON.stringify({ new_session_per_run: mode === 'new' }),
  });
  if (res.ok) showToast('已保存', 'success');
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

async function toggleRunHistory(agentId) {
  const el = document.getElementById('agent-runs-' + agentId);
  const arrow = document.getElementById('agent-runs-arrow-' + agentId);
  if (!el) return;
  if (el.style.display !== 'none') {
    el.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
    return;
  }
  el.style.display = '';
  if (arrow) arrow.textContent = '▼';
  if (el.innerHTML) return;
  el.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:8px">Loading...</div>';
  await loadRunHistory(agentId);
}

async function loadRunHistory(agentId) {
  const container = document.getElementById('agent-runs-' + agentId);
  if (!container) return;
  try {
    const res = await fetch(`/api/agents/${agentId}/runs?limit=10`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = '<span style="color:var(--error);font-size:12px">Failed to load runs.</span>'; return; }
    const data = await res.json();
    const runs = data.runs || [];
    if (!runs.length) { container.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">No runs yet.</span>'; return; }

    const fmtCost = v => v < 0.01 ? '<$0.01' : '$' + v.toFixed(2);
    const fmtDur = ms => {
      if (!ms) return '-';
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    };

    container.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">${runs.map((r, idx) => {
      const statusColor = r.status === 'error' ? 'var(--error)' : 'var(--success)';
      const statusIcon = r.status === 'error' ? '✕' : '✓';
      return `<div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer" onclick="viewRunReport('${agentId}','${r.run_id}')">
        <div style="display:flex;align-items:center;gap:10px;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:${statusColor};font-weight:600">${statusIcon}</span>
            <span style="color:var(--text-secondary)">${timeAgo(r.started_at)}</span>
          </div>
          <div style="display:flex;gap:12px;color:var(--text-secondary);font-size:11px">
            <span title="Tools">\u{1F527} ${r.tool_call_count}</span>
            <span title="Cost">${fmtCost(r.cost_usd)}</span>
            <span title="Duration">${fmtDur(r.duration_ms)}</span>
          </div>
        </div>
        ${r.result_snippet ? `<div style="margin-top:4px;color:var(--fg);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.result_snippet.slice(0, 120))}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  } catch {
    container.innerHTML = '<span style="color:var(--error);font-size:12px">Failed to load runs.</span>';
  }
}

async function viewRunReport(agentId, runId) {
  const container = document.getElementById('agent-runs-' + agentId);
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:8px">Loading report...</div>';
  try {
    const res = await fetch(`/api/agents/${agentId}/runs/${runId}/report`, { headers: apiHeaders() });
    if (!res.ok) { container.innerHTML = '<span style="color:var(--error)">Failed to load report.</span>'; return; }
    const r = await res.json();

    const fmtCost = v => v < 0.01 ? '<$0.01' : '$' + v.toFixed(4);
    const fmtTokens = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);
    const fmtDur = ms => {
      if (!ms) return '-';
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    };
    const statusColor = r.status === 'error' ? 'var(--error)' : 'var(--success)';

    // Tool frequency
    const toolFreqHtml = Object.entries(r.summary.tool_frequency || {})
      .sort((a, b) => (b[1]) - (a[1]))
      .map(([name, count]) => `<span style="padding:2px 8px;background:rgba(88,166,255,0.1);border:1px solid rgba(88,166,255,0.3);border-radius:12px;font-size:10px">${esc(name)} ×${count}</span>`)
      .join(' ');

    // File changes
    const filesHtml = (r.summary.files_changed || []).map(f =>
      `<div style="font-family:monospace;font-size:11px;padding:2px 0">${esc(f)}</div>`
    ).join('') || '<span style="color:var(--text-secondary)">None</span>';

    // Tool call timeline
    const toolsHtml = (r.tool_calls || []).map((tc, i) =>
      `<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:11px">
        <div style="display:flex;gap:6px;align-items:baseline">
          <span style="color:var(--accent);font-weight:600;min-width:20px">${i + 1}.</span>
          <span style="color:var(--accent);font-weight:500">${esc(tc.name)}</span>
          <span style="color:var(--text-secondary);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:400px">${esc(tc.input.slice(0, 100))}</span>
        </div>
        ${tc.result ? `<div style="margin-left:26px;color:var(--text-secondary);font-family:monospace;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px">${esc(tc.result.slice(0, 150))}</div>` : ''}
      </div>`
    ).join('');

    container.innerHTML = `
      <div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <button class="btn btn-sm" onclick="loadRunHistory('${agentId}')" style="font-size:11px">← Back to runs</button>
          <span style="color:${statusColor};font-weight:600">${r.status === 'error' ? 'Failed' : 'Success'}</span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Duration</div>
            <div style="font-size:14px;font-weight:600">${fmtDur(r.cost?.duration_ms)}</div>
          </div>
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Cost</div>
            <div style="font-size:14px;font-weight:600;color:var(--accent)">${r.cost ? fmtCost(r.cost.total_usd) : '-'}</div>
          </div>
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Tools</div>
            <div style="font-size:14px;font-weight:600">${r.summary.total_tool_calls}</div>
          </div>
          <div style="padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;opacity:0.6">Tokens</div>
            <div style="font-size:14px;font-weight:600">${r.cost ? fmtTokens(r.cost.input_tokens) + '↑ ' + fmtTokens(r.cost.output_tokens) + '↓' : '-'}</div>
          </div>
        </div>

        ${r.error_message ? `<div style="margin-bottom:12px;padding:8px;background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.3);border-radius:4px;font-size:11px;color:var(--error);font-family:monospace;white-space:pre-wrap">${esc(r.error_message.slice(0, 500))}</div>` : ''}

        ${toolFreqHtml ? `<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Tool Usage</div><div style="display:flex;gap:6px;flex-wrap:wrap">${toolFreqHtml}</div></div>` : ''}

        ${r.summary.files_changed.length > 0 ? `<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Files Changed (${r.summary.files_changed.length})</div>${filesHtml}</div>` : ''}

        ${r.final_result ? `<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Final Result</div><pre style="padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0;max-height:200px;overflow-y:auto">${esc(r.final_result.slice(0, 1000))}</pre></div>` : ''}

        ${toolsHtml ? `<div><div style="font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Tool Call Timeline (${r.tool_calls.length})</div><div style="max-height:300px;overflow-y:auto">${toolsHtml}</div></div>` : ''}
      </div>`;
  } catch {
    container.innerHTML = '<span style="color:var(--error)">Failed to load report.</span>';
  }
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
    loadAgents(); showToast('Agent已删除', 'success');
  } else { showToast('删除失败', 'error'); }
}

async function retryAgent(id) {
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/retry`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) { loadAgents(); showToast('Agent已重试', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '重试失败', 'error'); }
  });
}

async function quickStartAgent(id) {
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/start`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
    if (res.ok) { loadAgents(); showToast('Agent已启动', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '启动失败', 'error'); }
  });
}
async function pauseAgent(id) {
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/pause`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { loadAgents(); showToast('Agent已暂停', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '暂停失败', 'error'); }
  });
}

async function unpauseAgent(id) {
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/unpause`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { loadAgents(); showToast('Agent已恢复', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '恢复失败', 'error'); }
  });
}

async function stopAgentById(id) {
  if (!confirm('Stop this agent?')) return;
  const btn = event ? event.target : null;
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${id}/stop`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { showToast('Agent已停止', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '停止失败', 'error'); }
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
    if (res.ok) { hideModal('createAgentModal'); loadAgents(); showToast('Agent已创建', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '创建失败', 'error'); }
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
      ${i.comment_count ? `<div style="flex-shrink:0;display:flex;align-items:center;gap:4px;color:var(--text-secondary);font-size:12px" title="${i.comment_count} 条评论"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.749.749 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>${i.comment_count}</div>` : ''}
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



function showCreateIssueModal() {
  document.getElementById('issue-title').value = '';
  document.getElementById('issue-body').value = '';
  document.getElementById('issue-labels').value = '';
  const sel = document.getElementById('issue-assign');
  if (sel) {
    const controllerId = agentsData.find(a => a.is_controller)?.id || '';
    sel.value = controllerId || '';
  }
  document.getElementById('createIssueModal').classList.add('active');
  const issueBodyTextarea = document.getElementById('issue-body');
  if (issueBodyTextarea) setupMentionAutocomplete(issueBodyTextarea, agentsData);
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
    if (res.ok) { hideModal('createIssueModal'); loadIssues(); showToast('Issue已创建', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '创建失败', 'error'); }
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
  document.getElementById('tab-git').style.display = tab === 'git' ? '' : 'none';
  // Update breadcrumb section
  const sectionNames = { overview: '', agents: 'Agents', issues: 'Issues', activity: 'Activity', git: 'Git' };
  const sectionEl = document.getElementById('breadcrumb-section');
  if (sectionEl) {
    sectionEl.textContent = sectionNames[tab] ? ' / ' + sectionNames[tab] : '';
  }
  // Update URL hash
  window.location.hash = tab === 'overview' ? '' : tab;
  if (tab === 'issues') loadIssues();
  if (tab === 'activity') loadActivity();
  if (tab === 'git') loadGitTab();
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

// ─── Git Tab ───

async function loadGitTab() {
  const commitContainer = document.getElementById('git-commit-list');
  const statusContainer = document.getElementById('git-status-summary');
  const uncommittedContainer = document.getElementById('git-uncommitted');

  // Load git log and per-agent git status in parallel
  try {
    const [logRes, ...agentStatuses] = await Promise.all([
      fetch(`/api/projects/${projectId}/git-log?limit=30`, { headers: apiHeaders() }),
      ...agentsData.filter(a => a.working_directory).map(a =>
        fetch(`/api/agents/${a.id}/git-status`, { headers: apiHeaders() }).then(r => r.ok ? r.json() : null).then(data => ({ agent: a, data }))
      )
    ]);

    // Render status summary (branch info per agent)
    const validStatuses = agentStatuses.filter(s => s && s.data && s.data.branch);
    if (validStatuses.length > 0) {
      statusContainer.innerHTML = `<div class="card" style="padding:14px 18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:10px">Repository Status</div>
        ${validStatuses.map(s => {
          const d = s.data;
          const lastCommit = d.recent_commits && d.recent_commits[0]
            ? `<code style="color:var(--accent)">${esc(d.recent_commits[0].hash)}</code> ${esc(d.recent_commits[0].message.slice(0, 60))} <span style="color:var(--text-secondary)">${timeAgo(d.recent_commits[0].date)}</span>`
            : '<span style="color:var(--text-secondary)">no commits</span>';
          const uncommitted = d.has_uncommitted
            ? `<span style="color:var(--warning);margin-left:12px">${(d.uncommitted_files || []).length} uncommitted</span>`
            : '';
          return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
            <div style="flex-shrink:0">${avatarSvg(s.agent.name, 22)}</div>
            <strong style="min-width:100px">${esc(s.agent.name)}</strong>
            <span style="background:var(--bg);padding:2px 8px;border-radius:10px;border:1px solid var(--border);font-family:monospace;font-size:11px">${esc(d.branch)}</span>
            <div style="flex:1">${lastCommit}</div>
            ${uncommitted}
          </div>`;
        }).join('')}
      </div>`;
    } else {
      statusContainer.innerHTML = '';
    }

    // Render commit list
    if (!logRes.ok) { commitContainer.innerHTML = '<div class="empty-state">Failed to load git log.</div>'; return; }
    const commits = await logRes.json();

    if (!commits.length) {
      commitContainer.innerHTML = '<div class="empty-state">No git commits found. Ensure agents have a working directory that is a git repository.</div>';
      uncommittedContainer.innerHTML = '';
      return;
    }

    commitContainer.innerHTML = `
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:10px;padding:0 4px">Recent Commits</div>
      ${commits.map(c => `<div style="display:flex;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border);font-size:13px;align-items:flex-start">
        <span style="color:var(--success);flex-shrink:0;margin-top:2px">●</span>
        <code style="color:var(--accent);flex-shrink:0;font-size:12px">${esc(c.short_hash)}</code>
        <div style="flex:1;min-width:0">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.message)}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${esc(c.author)} <span style="color:var(--text-secondary)">${timeAgo(c.date)}</span></div>
        </div>
      </div>`).join('')}`;

    // Render uncommitted changes
    const allUncommitted = validStatuses.filter(s => s.data.has_uncommitted && s.data.uncommitted_files && s.data.uncommitted_files.length > 0);
    if (allUncommitted.length > 0) {
      uncommittedContainer.innerHTML = `<div class="card" style="padding:14px 18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:10px">Uncommitted Changes</div>
        ${allUncommitted.map(s => s.data.uncommitted_files.map(f => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px;font-family:monospace;border-bottom:1px solid var(--border)">
          <span style="color:${f.status === 'M' ? 'var(--warning)' : f.status === 'A' || f.status === '?' ? 'var(--success)' : 'var(--error)'};width:20px;text-align:center;flex-shrink:0">${esc(f.status)}</span>
          <span>${esc(f.file)}</span>
        </div>`).join('')).join('')}
      </div>`;
    } else {
      uncommittedContainer.innerHTML = '';
    }
  } catch (e) {
    commitContainer.innerHTML = '<div class="empty-state">Failed to load git information.</div>';
    statusContainer.innerHTML = '';
    uncommittedContainer.innerHTML = '';
  }
}

// ─── Dashboard & Visualization ───

async function loadDashboard() {
  const el = document.getElementById('project-dashboard');
  if (!el) return;
  try {
    const [agentsRes, issuesRes, costRes] = await Promise.all([
      fetch(`/api/projects/${projectId}/agents`, { headers: apiHeaders() }),
      fetch(`/api/projects/${projectId}/issues?per_page=200`, { headers: apiHeaders() }),
      fetch(`/api/projects/${projectId}/costs`, { headers: apiHeaders() }),
    ]);
    const agents = agentsRes.ok ? await agentsRes.json() : [];
    const issueData = issuesRes.ok ? await issuesRes.json() : {};
    const issues = issueData.issues || issueData || [];
    const cost = costRes.ok ? await costRes.json() : null;

    const running = agents.filter(a => a.status === 'running').length;
    const errors = agents.filter(a => a.status === 'error').length;
    const paused = agents.filter(a => a.paused).length;
    const openIssues = issues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
    const doneIssues = issues.filter(i => i.status === 'done' || i.status === 'closed').length;
    const fmtCost = v => !v ? '$0' : v < 0.01 ? '<$0.01' : '$' + v.toFixed(2);

    const card = (label, value, color, sub) => `
      <div style="padding:12px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:4px">${label}</div>
        <div style="font-size:22px;font-weight:700;color:${color || 'var(--fg)'}">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${sub}</div>` : ''}
      </div>`;

    el.innerHTML =
      card('Agents', `${running}/${agents.length}`, running > 0 ? 'var(--success)' : 'var(--fg)',
        `${errors > 0 ? `<span style="color:var(--error)">${errors} error</span>` : ''}${paused > 0 ? ` <span style="color:var(--warning)">${paused} paused</span>` : ''}`) +
      card('Open Issues', openIssues, openIssues > 0 ? 'var(--warning)' : 'var(--fg)',
        `${doneIssues} completed`) +
      card('Total Cost', fmtCost(cost?.total_cost_usd), 'var(--accent)',
        cost ? `${cost.total_runs || 0} runs` : '') +
      card('Issues Progress', issues.length > 0 ? Math.round(doneIssues / issues.length * 100) + '%' : '-', 'var(--fg)',
        `${doneIssues}/${issues.length} total`);
  } catch { el.innerHTML = ''; }
}

function renderAgentGraph() {
  const container = document.getElementById('agent-graph-container');
  if (!container || !agentsData.length) { if (container) container.innerHTML = ''; return; }

  const W = Math.min(container.clientWidth || 600, 700);
  const H = 280;
  const cx = W / 2, cy = H / 2;

  const controller = agentsData.find(a => a.is_controller);
  const workers = agentsData.filter(a => !a.is_controller);

  const statusColor = (a) => {
    if (a.paused) return '#d29922';
    switch (a.status) {
      case 'running': return '#3fb950';
      case 'error': return '#f85149';
      case 'stopped': return '#d29922';
      default: return '#8b949e';
    }
  };

  const nodeRadius = 30;
  const orbitRadius = Math.min(W / 2 - 60, H / 2 - 50);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;margin:0 auto">`;

  // Draw connections from controller to workers
  if (controller) {
    workers.forEach((w, i) => {
      const angle = (2 * Math.PI * i / workers.length) - Math.PI / 2;
      const wx = cx + orbitRadius * Math.cos(angle);
      const wy = cy + orbitRadius * Math.sin(angle);
      svg += `<line x1="${cx}" y1="${cy}" x2="${wx}" y2="${wy}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4" opacity="0.5"/>`;
    });
  }

  // Draw worker nodes
  workers.forEach((w, i) => {
    const angle = (2 * Math.PI * i / workers.length) - Math.PI / 2;
    const wx = cx + orbitRadius * Math.cos(angle);
    const wy = cy + orbitRadius * Math.sin(angle);
    const color = statusColor(w);
    const pulse = w.status === 'running' ? `<animate attributeName="r" values="${nodeRadius};${nodeRadius+4};${nodeRadius}" dur="2s" repeatCount="indefinite"/>` : '';

    // Count assigned issues
    const assignedCount = (window._dashboardIssues || []).filter(iss => iss.assigned_to === w.id && (iss.status === 'open' || iss.status === 'in_progress')).length;

    svg += `<g style="cursor:pointer" onclick="viewAgent('${w.id}')">
      <circle cx="${wx}" cy="${wy}" r="${nodeRadius}" fill="${color}22" stroke="${color}" stroke-width="2"${w.paused ? ' stroke-dasharray="4,4"' : ''}>${pulse}</circle>
      <text x="${wx}" y="${wy - 2}" text-anchor="middle" fill="var(--fg)" font-size="11" font-weight="600">${esc(w.name.length > 10 ? w.name.slice(0, 9) + '…' : w.name)}</text>
      <text x="${wx}" y="${wy + 12}" text-anchor="middle" fill="${color}" font-size="9">${w.paused ? 'paused' : w.status}${assignedCount > 0 ? ' · ' + assignedCount + ' tasks' : ''}</text>
    </g>`;
  });

  // Draw controller node (center)
  if (controller) {
    const color = statusColor(controller);
    const pulse = controller.status === 'running' ? `<animate attributeName="r" values="34;38;34" dur="2s" repeatCount="indefinite"/>` : '';
    svg += `<g style="cursor:pointer" onclick="viewAgent('${controller.id}')">
      <circle cx="${cx}" cy="${cy}" r="34" fill="${color}22" stroke="${color}" stroke-width="2.5">${pulse}</circle>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="var(--fg)" font-size="12" font-weight="700">${esc(controller.name.length > 12 ? controller.name.slice(0, 11) + '…' : controller.name)}</text>
      <text x="${cx}" y="${cy + 10}" text-anchor="middle" fill="${color}" font-size="9">${controller.status}</text>
      <text x="${cx}" y="${cy + 21}" text-anchor="middle" fill="var(--accent)" font-size="8">controller</text>
    </g>`;
  }

  svg += '</svg>';
  container.innerHTML = `<div class="card" style="padding:12px;text-align:center">
    <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:8px">Agent Collaboration</div>
    ${svg}
  </div>`;
}

// ─── Init ───
loadProject();
loadAgents();
loadDashboard();

// Slow fallback polling (WS handles real-time)
setInterval(loadAgents, 30000);

// Connect to project-level WebSocket for real-time updates
const _projectEvents = connectProjectEvents(projectId);

_projectEvents.on('agent_status', function(data) {
  loadAgents();
  loadDashboard();
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
if (['overview', 'agents', 'issues', 'activity', 'git'].includes(hash)) {
  setTimeout(() => switchTab(hash), 500);
}
