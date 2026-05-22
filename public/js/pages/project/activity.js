async function loadActivity() {
  const container = document.getElementById('activity-list');
  try {
    const res = await fetch(`${projectApiPath('/activity')}?limit=200`, { headers: apiHeaders() });
    if (!res.ok) return;
    const events = await res.json();

    if (!events.length) { container.innerHTML = '<div class="empty-state">No activity yet.</div>'; return; }

    container.replaceChildren(...events.map(renderActivityEvent).filter(Boolean));
  } catch (e) { container.innerHTML = renderError(e, 'loadActivity()'); }
}

function cloneActivityTemplate(id) {
  return document.getElementById(id).content.cloneNode(true).firstElementChild;
}

function safeText(value) {
  return value || '';
}

function renderActivityEvent(e) {
  const time = timeAgo(e.time);
  if (e.event_type === 'issue') {
    const icon = e.status === 'open' ? '●' : '✓';
    const color = e.status === 'open' ? 'var(--success)' : (e.status === 'closed' ? 'var(--text-secondary)' : 'var(--accent)');
    const row = cloneActivityTemplate('tmpl-activity-issue');
    row.querySelector('[data-slot="icon"]').textContent = icon;
    row.querySelector('[data-slot="icon"]').style.color = color;
    row.querySelector('[data-slot="actor"]').textContent = nameOf(e.actor);
    row.querySelector('[data-slot="action"]').textContent = e.status === 'open' ? 'opened' : 'updated';
    row.querySelector('[data-slot="number"]').textContent = `#${e.number}`;
    row.querySelector('[data-slot="title"]').textContent = safeText(e.title);
    row.querySelector('[data-slot="time"]').textContent = time;
    return row;
  }

  if (e.event_type === 'comment') {
    const row = cloneActivityTemplate('tmpl-activity-comment');
    row.querySelector('[data-slot="actor"]').textContent = nameOf(e.actor);
    row.querySelector('[data-slot="number"]').textContent = `#${e.issue_number}`;
    row.querySelector('[data-slot="title"]').textContent = safeText(e.issue_title);
    row.querySelector('[data-slot="time"]').textContent = time;
    row.querySelector('[data-slot="preview"]').textContent = safeText(e.body).slice(0, 150);
    return row;
  }

  if (e.event_type === 'agent_run') {
    const color = e.agent_status === 'running' ? 'var(--success)' : (e.agent_status === 'error' ? 'var(--error)' : 'var(--text-secondary)');
    const row = cloneActivityTemplate('tmpl-activity-agent-run');
    row.querySelector('[data-slot="icon"]').style.color = color;
    row.querySelector('[data-slot="name"]').textContent = safeText(e.name);
    row.querySelector('[data-slot="status-text"]').textContent = `[${e.agent_status}]`;
    row.querySelector('[data-slot="time"]').textContent = time;
    return row;
  }

  return null;
}

// ─── Git Tab ───

(async function initActivityPage(){
  await loadProjectShell();
  await loadActivity();
  const events = connectProjectEvents(projectId);
  events.on("agent_status", loadActivity);
  events.on("issue_created", loadActivity);
  events.on("issue_updated", loadActivity);
  events.on("comment_added", loadActivity);
})();
