async function loadActivity() {
  const container = document.getElementById('activity-list');
  try {
    const res = await fetch(`${projectApiPath('/activity')}?limit=200`, { headers: apiHeaders() });
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
  } catch (e) { container.innerHTML = renderError(e, 'loadActivity()'); }
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
