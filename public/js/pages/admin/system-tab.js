function initSystemTab() {
  loadSystemStatus();
  setupResetStuckAgents();
  setupRunMaintenance();
}

// Self-initialize — this file is loaded directly as a page module
initSystemTab();

async function loadSystemStatus() {
  const el = document.getElementById('system-status-overview');
  try {
    const res = await fetch('/api/admin/system-status');
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    const items = [
      { label: 'Users', value: data.total_users ?? '-' },
      { label: 'Projects', value: data.total_projects ?? '-' },
      { label: 'Running Agents', value: data.running_agents ?? '-' },
      { label: 'DB Size', value: data.db_size ?? '-' },
      { label: 'Uptime', value: data.uptime ?? '-' },
    ];
    el.innerHTML = h`<div class="info-panel">${html(items.map(i => h`<dt>${i.label}</dt><dd>${i.value}</dd>`).join(''))}</div>`;
  } catch {
    el.innerHTML = h`<p style="color:var(--error);font-size:13px">Failed to load system status.</p>`;
  }
}

function setupResetStuckAgents() {
  const btn = document.getElementById('reset-stuck-agents-btn');
  const resultEl = document.getElementById('reset-stuck-agents-result');
  btn.addEventListener('click', async () => {
    if (!confirm('Reset all agents stuck in running status?')) return;
    btn.disabled = true;
    resultEl.style.display = 'none';
    try {
      const res = await fetch('/api/admin/reset-stuck-agents', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        resultEl.textContent = data.message || 'Done';
        resultEl.style.color = 'var(--success)';
      } else {
        resultEl.textContent = data.error || 'Failed';
        resultEl.style.color = 'var(--error)';
      }
      resultEl.style.display = 'block';
    } catch {
      resultEl.textContent = 'Request failed';
      resultEl.style.color = 'var(--error)';
      resultEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });
}

function setupRunMaintenance() {
  const btn = document.getElementById('run-maintenance-btn');
  const resultEl = document.getElementById('run-maintenance-result');
  btn.addEventListener('click', async () => {
    if (!confirm('Run database maintenance tasks?')) return;
    btn.disabled = true;
    resultEl.style.display = 'none';
    try {
      const res = await fetch('/api/admin/run-maintenance', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        resultEl.textContent = data.message || 'Done';
        resultEl.style.color = 'var(--success)';
      } else {
        resultEl.textContent = data.error || 'Failed';
        resultEl.style.color = 'var(--error)';
      }
      resultEl.style.display = 'block';
    } catch {
      resultEl.textContent = 'Request failed';
      resultEl.style.color = 'var(--error)';
      resultEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });
}
