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
      const summary = cloneGitTemplate('tmpl-git-status-summary');
      summary.querySelector('[data-slot="rows"]').replaceChildren(...validStatuses.map(renderGitStatusRow));
      statusContainer.replaceChildren(summary);
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

    const commitList = cloneGitTemplate('tmpl-git-commit-list');
    commitList.querySelector('[data-slot="rows"]').replaceChildren(...commits.map(renderGitCommitRow));
    commitContainer.replaceChildren(commitList);

    // Render uncommitted changes
    const allUncommitted = validStatuses.filter(s => s.data.has_uncommitted && s.data.uncommitted_files && s.data.uncommitted_files.length > 0);
    if (allUncommitted.length > 0) {
      const uncommitted = cloneGitTemplate('tmpl-git-uncommitted');
      const rows = allUncommitted.flatMap(s => s.data.uncommitted_files.map(renderGitUncommittedRow));
      uncommitted.querySelector('[data-slot="rows"]').replaceChildren(...rows);
      uncommittedContainer.replaceChildren(uncommitted);
    } else {
      uncommittedContainer.innerHTML = '';
    }
  } catch (e) {
    commitContainer.innerHTML = renderError(e, 'loadGitTab()');
    statusContainer.innerHTML = '';
    uncommittedContainer.innerHTML = '';
  }
}

function cloneGitTemplate(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function setGitText(root, slotName, value) {
  const node = root.querySelector(`[data-slot="${slotName}"]`);
  if (node) node.textContent = value == null ? '' : String(value);
}

function createGitAgentAvatar(agentName) {
  const span = document.createElement('span');
  const size = 22;
  span.className = 'role-avatar';
  span.style.display = 'inline-flex';
  span.style.alignItems = 'center';
  span.style.justifyContent = 'center';
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.style.borderRadius = '50%';
  span.style.background = agentHslColor(agentName);
  span.style.color = '#fff';
  span.style.fontSize = `${Math.round(size * 0.4)}px`;
  span.style.fontWeight = '600';
  span.style.lineHeight = '1';
  span.style.flexShrink = '0';
  span.style.textTransform = 'uppercase';
  span.style.letterSpacing = '-0.5px';
  span.textContent = getNameInitials(agentName || '?');
  return span;
}

function renderGitStatusRow(status) {
  const row = cloneGitTemplate('tmpl-git-status-row');
  const data = status.data;
  row.querySelector('[data-slot="avatar"]').replaceChildren(createGitAgentAvatar(status.agent.name));
  setGitText(row, 'agent-name', status.agent.name);
  setGitText(row, 'branch', data.branch);

  const lastCommit = row.querySelector('[data-slot="last-commit"]');
  const recent = data.recent_commits && data.recent_commits[0];
  if (recent) {
    setGitText(row, 'commit-hash', recent.hash);
    setGitText(row, 'commit-message', recent.message.slice(0, 60));
    setGitText(row, 'commit-time', timeAgo(recent.date));
    row.querySelector('[data-slot="no-commits"]').remove();
  } else {
    lastCommit.replaceChildren(row.querySelector('[data-slot="no-commits"]'));
  }

  const uncommitted = row.querySelector('[data-slot="uncommitted"]');
  if (data.has_uncommitted) {
    uncommitted.textContent = `${(data.uncommitted_files || []).length} uncommitted`;
  } else {
    uncommitted.remove();
  }
  return row;
}

function renderGitCommitRow(commit) {
  const row = cloneGitTemplate('tmpl-git-commit-row');
  setGitText(row, 'short-hash', commit.short_hash);
  setGitText(row, 'message', commit.message);
  setGitText(row, 'author', commit.author);
  setGitText(row, 'time', timeAgo(commit.date));
  return row;
}

function renderGitUncommittedRow(file) {
  const row = cloneGitTemplate('tmpl-git-uncommitted-row');
  const status = row.querySelector('[data-slot="status"]');
  const tone = file.status === 'M' ? 'var(--warning)' : file.status === 'A' || file.status === '?' ? 'var(--success)' : 'var(--error)';
  status.style.color = tone;
  status.textContent = file.status;
  setGitText(row, 'file', file.file);
  return row;
}

// ─── Dashboard & Visualization ───

(async function initGitPage(){
  await loadProjectShell();
  agentsData = await getProjectAgents().catch(() => []);
  await loadGitTab();
  const events = connectProjectEvents(projectId);
  events.on("agent_status", async () => { agentsData = await getProjectAgents().catch(() => agentsData); loadGitTab(); });
})();
