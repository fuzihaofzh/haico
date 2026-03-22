function apiHeaders() {
  return { 'Content-Type': 'application/json' };
}

async function loadProjects() {
  const container = document.getElementById('projects');
  try {
    const res = await fetch('/api/projects', { headers: apiHeaders() });
    if (!res.ok) {
      container.innerHTML = '<div class="empty-state">Failed to load projects.</div>';
      return;
    }
    const projects = await res.json();
    if (!projects.length) {
      container.innerHTML = '<div class="empty-state">No projects yet. Create one to get started.</div>';
      return;
    }

    // Fetch agent + issue counts for each project
    const stats = {};
    await Promise.all(projects.map(async (p) => {
      const s = { agents: 0, running: 0, agentError: 0, issues: 0, openIssues: 0, userIssues: [] };
      try {
        const r = await fetch(`/api/projects/${p.id}/agents`, { headers: apiHeaders() });
        if (r.ok) { const a = await r.json(); s.agents = a.length; s.running = a.filter(x => x.status === 'running').length; s.agentError = a.filter(x => x.status === 'error').length; }
      } catch (e) { console.error('Failed to fetch agents for project', p.id, e); }
      try {
        const r = await fetch(`/api/projects/${p.id}/issues`, { headers: apiHeaders() });
        if (r.ok) {
          const i = await r.json();
          s.issues = i.length;
          s.openIssues = i.filter(x => x.status === 'open' || x.status === 'in_progress').length;
          s.userIssues = i.filter(x => (x.assigned_to === 'user' || x.assigned_to === 'all') && (x.status === 'open' || x.status === 'in_progress'));
        }
      } catch (e) { console.error('Failed to fetch issues for project', p.id, e); }
      stats[p.id] = s;
    }));

    container.innerHTML = projects.map(p => {
      const s = stats[p.id] || { agents: 0, running: 0, agentError: 0, issues: 0, openIssues: 0, userIssues: [] };
      const link = `/projects/${p.id}`;
      const userCount = s.userIssues?.length || 0;
      const notifBadge = userCount > 0
        ? `<span onclick="event.stopPropagation();window.location='${link}#issues'" style="background:var(--error);color:#fff;font-size:11px;padding:1px 8px;border-radius:10px;cursor:pointer;margin-left:6px" title="${userCount} issue(s) need your attention">${userCount}</span>`
        : '';
      return `
      <div class="card" style="cursor:pointer" onclick="window.location='${link}'">
        <div class="flex-between">
          <strong style="font-size:15px">${esc(p.name)}${notifBadge}</strong>
          <span class="status-badge status-${p.status}">${p.status}</span>
        </div>
        <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;margin-bottom:12px">${esc(p.description || '')}</p>
        <div style="display:flex;gap:16px;font-size:12px">
          <div style="display:flex;align-items:center;gap:4px;color:var(--text-secondary)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm5 7c0-2.8-2.2-5-5-5s-5 2.2-5 5h10z"/></svg>
            <span>${s.running} running</span>
            <span style="opacity:0.5">/ ${s.agents}</span>
            ${s.agentError > 0 ? `<span style="color:var(--error)">${s.agentError} error</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:4px;color:var(--text-secondary)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            <span>${s.openIssues} open</span>
            <span style="opacity:0.5">/ ${s.issues}</span>
          </div>
        </div>
      </div>
    `}).join('');
  } catch (e) {
    container.innerHTML = '<div class="empty-state"></div>';
    container.querySelector('.empty-state').textContent = 'Error loading projects: ' + e.message;
  }
}

function showCreateModal() { document.getElementById('createModal').classList.add('active'); }
function hideCreateModal() { document.getElementById('createModal').classList.remove('active'); }

async function withLoading(btn, asyncFn) {
  if (btn.disabled) return;
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

async function createProject() {
  const btn = document.querySelector('#createModal button[onclick="createProject()"]');
  await withLoading(btn, async () => {
    const task = document.getElementById('proj-task').value.trim();
    const toolPath = document.getElementById('proj-cmd').value.trim() || 'cld';
    if (!task) { alert('Please describe what you want to do'); return; }

    // Step 1: Call AI to generate project metadata
    btn.textContent = 'Generating...';
    const genRes = await fetch('/api/generate-project', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ description: task, tool_path: toolPath }),
    });

    let name, description, taskDesc, workDir, ctrlRole;
    if (genRes.ok) {
      const gen = await genRes.json();
      name = gen.name || 'project';
      description = gen.description || task.slice(0, 100);
      taskDesc = gen.task_description || task;
      workDir = gen.working_directory || null;
      ctrlRole = gen.controller_role || null;
    } else {
      // Fallback if AI fails
      name = task.slice(0, 30).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'project';
      description = task.slice(0, 100);
      taskDesc = task;
    }

    // Step 2: Create the project
    btn.textContent = 'Creating...';
    const body = {
      name,
      description,
      task_description: taskDesc,
      controller_interval_min: 5,
      command_template: toolPath,
      working_directory: workDir,
      controller_role: ctrlRole,
    };

    const res = await fetch('/api/projects', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) {
      const proj = await res.json();
      hideCreateModal();
      window.location.href = '/projects/' + proj.id;
    } else {
      const err = await res.json();
      alert('Error: ' + (err.error || 'Unknown error'));
    }
  });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

loadProjects();
// Slow fallback polling (WS handles real-time); connect to each project as we discover them
setInterval(loadProjects, 30000);

// Listen for events from all projects and refresh dashboard on changes
(async function setupDashboardWS() {
  try {
    const res = await fetch('/api/projects', { headers: apiHeaders() });
    if (!res.ok) return;
    const projects = await res.json();
    for (const p of projects) {
      const ev = connectProjectEvents(p.id);
      ev.on('*', function() { loadProjects(); });
    }
  } catch {}
})();
