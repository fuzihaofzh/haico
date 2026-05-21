async function loadGitTab() {
  const commitContainer = document.getElementById('git-commit-list');
  const statusContainer = document.getElementById('git-status-summary');
  const uncommittedContainer = document.getElementById('git-uncommitted');

  // Load git log and per-agent git status in parallel
  try {
    const [logRes, ...agentStatuses] = await Promise.all([
      fetch(`${projectApiPath('/git-log')}?limit=30`, { headers: apiHeaders() }),
      ...agentsData.filter(a => a.working_directory).map(a =>
        fetch(agentApiPath(a.id, '/git-status'), { headers: apiHeaders() }).then(r => r.ok ? r.json() : null).then(data => ({ agent: a, data }))
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
          return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;flex-wrap:wrap">
            <div style="flex-shrink:0">${roleAvatarHtml(s.agent.name, 22, projectData?.color)}</div>
            <strong>${esc(s.agent.name)}</strong>
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
    if (!logRes.ok) { commitContainer.innerHTML = renderError({ status: logRes.status }, 'loadGitTab()'); return; }
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
    commitContainer.innerHTML = renderError(e, 'loadGitTab()');
    statusContainer.innerHTML = '';
    uncommittedContainer.innerHTML = '';
  }
}

// ─── Dashboard & Visualization ───

(async function initGitPage(){
  await loadProjectShell();
  agentsData = await getProjectAgents().catch(() => []);
  await loadGitTab();
  const events = connectProjectEvents(projectId);
  events.on("agent_status", async () => { agentsData = await getProjectAgents().catch(() => agentsData); loadGitTab(); });
})();
