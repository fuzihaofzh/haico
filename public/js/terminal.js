const agentId = window.location.pathname.split('/').pop();
let term = null;
let fitAddon = null;
let lastLogId = 0;

function initTerminal() {
  const cs = getComputedStyle(document.documentElement);
  term = new Terminal({
    theme: {
      background: cs.getPropertyValue('--bg').trim() || '#fdf6e3',
      foreground: cs.getPropertyValue('--fg').trim() || '#073642',
      cursor: cs.getPropertyValue('--accent').trim() || '#268bd2',
      selectionBackground: cs.getPropertyValue('--selected-bg').trim() || '#e8dcc8',
    },
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    scrollback: 10000,
    convertEol: true,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();
  window.addEventListener('resize', () => fitAddon.fit());
}

function writeLog(log) {
  if (log.stream === 'stdin') {
    const preview = log.content.replace(/\n/g, ' ').slice(0, 100);
    term.writeln('\x1b[36m--- Input Prompt (' + log.content.length + ' chars) ---\x1b[0m');
    term.writeln('\x1b[2m' + preview + '...\x1b[0m');
    term.writeln('\x1b[36m--- Output ---\x1b[0m');
  } else if (log.stream === 'cost') {
    return; // Don't display cost data in terminal
  } else if (log.stream === 'stderr') {
    // Skip proxychains noise
    if (log.content.includes('proxychains')) return;
    term.writeln('\x1b[31m' + log.content.trimEnd() + '\x1b[0m');
  } else {
    // Skip proxychains noise in stdout too
    if (log.content.includes('Executing through proxy:') || log.content.includes('Port 7897')) return;
    // Use writeln per line for reliable display
    const lines = log.content.split('\n');
    lines.forEach((line, i) => {
      if (i < lines.length - 1 || line) {
        term.writeln(line);
      }
    });
  }
  term.scrollToBottom();
}

// ─── Poll logs via HTTP (real-time, every 1 second) ───

async function pollLogs() {
  try {
    const res = await fetch(`/api/agents/${agentId}/logs?limit=200`, { headers: apiHeaders() });
    if (!res.ok) return;
    const logs = await res.json();
    if (!logs.length) return;

    const newLogs = logs.filter(l => l.id > lastLogId);
    if (newLogs.length > 0) {
      // Display oldest first
      newLogs.reverse().forEach(writeLog);
      lastLogId = Math.max(...logs.map(l => l.id));
    }
  } catch (e) { console.error('Failed to poll logs', e); }
}

// Initial load: fetch history, grouped by run
async function loadHistory() {
  try {
    const res = await fetch(`/api/agents/${agentId}/logs?limit=500`, { headers: apiHeaders() });
    if (!res.ok) return;
    const logs = await res.json();
    if (!logs.length) {
      term.writeln('\x1b[2m(no logs yet)\x1b[0m');
      return;
    }
    lastLogId = Math.max(...logs.map(l => l.id));

    // Group by run_id, display with separators
    logs.reverse();
    let currentRun = null;
    let runIndex = 0;
    logs.forEach(log => {
      if (log.run_id !== currentRun) {
        currentRun = log.run_id;
        runIndex++;
        if (runIndex > 1) term.writeln('');
        term.writeln('\x1b[33m━━━ Run #' + runIndex + ' ━━━\x1b[0m');
      }
      writeLog(log);
    });
    term.writeln('\r\n\x1b[36m--- End of history ---\x1b[0m\r\n');
  } catch (e) { console.error('Failed to load history', e); }
}

// ─── Agent Info ───

async function loadAgentInfo() {
  try {
    const res = await fetch(`/api/agents/${agentId}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const agent = await res.json();

    document.getElementById('agent-name').textContent = agent.name;
    document.getElementById('agent-title').textContent = agent.name;
    document.getElementById('agent-role').textContent = agent.role || '-';
    document.getElementById('agent-type').textContent = agent.is_controller ? 'Controller' : 'Worker';
    document.getElementById('agent-status-text').textContent = agent.status + (agent.pid ? ` (PID: ${agent.pid})` : '');
    document.getElementById('agent-started').textContent = agent.started_at || '-';
    document.getElementById('agent-status').textContent = agent.status;
    document.getElementById('agent-status').className = `status-badge status-${agent.status}`;
    document.title = `Argus - ${agent.name}`;

    document.getElementById('project-link').href = `/projects/${agent.project_id}`;
    // Load project name for breadcrumb
    if (!window._projectLoaded) {
      window._projectLoaded = true;
      fetch(`/api/projects/${agent.project_id}`, { headers: apiHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(p => { if (p) document.getElementById('project-link').textContent = p.name; })
        .catch((e) => { console.error('Failed to load project name', e); });
    }
    document.getElementById('btn-start').style.display = agent.status === 'running' ? 'none' : '';
    document.getElementById('btn-stop').style.display = agent.status === 'running' ? '' : 'none';
    document.getElementById('thinking-indicator').style.display = agent.status === 'running' ? '' : 'none';
    const retryBtn = document.getElementById('btn-retry');
    if (retryBtn) {
      retryBtn.style.display = (agent.status === 'error' && agent.last_prompt) ? '' : 'none';
    }

    if (!window._instructionsLoaded) {
      document.getElementById('agent-instructions').value = agent.custom_instructions || '';
      document.getElementById('agent-workdir').value = agent.working_directory || '';
      const maxRunsEl = document.getElementById('agent-maxruns');
      if (maxRunsEl) maxRunsEl.value = agent.session_max_runs || 10;
      window._instructionsLoaded = true;
    }
  } catch (e) { console.error('Failed to load agent info', e); }
}

const refreshAgentInfo = loadAgentInfo;

// ─── Actions ───

async function quickStart() {
  const btn = document.getElementById('btn-start');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}/start`, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({}),
    });
    if (res.ok) { loadAgentInfo(); showToast('Agent已启动', 'success'); }
    else { const err = await res.json(); showToast(err.error || '启动失败', 'error'); }
  });
}

async function saveWorkdir() {
  const val = document.getElementById('agent-workdir').value.trim();
  const btn = document.querySelector('button[onclick="saveWorkdir()"]');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ working_directory: val || null }),
    });
    if (res.ok) showToast('已保存', 'success');
    else showToast('保存失败', 'error');
  });
}

async function saveMaxRuns() {
  const raw = parseInt(document.getElementById('agent-maxruns').value);
  const val = Number.isNaN(raw) ? 10 : raw;
  const btn = document.querySelector('button[onclick="saveMaxRuns()"]');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ session_max_runs: Math.max(1, val) }),
    });
    if (res.ok) showToast('已保存', 'success');
    else showToast('保存失败', 'error');
  });
}

function showStartModal() { document.getElementById('startModal').classList.add('active'); }
function hideModal() { document.getElementById('startModal').classList.remove('active'); }

async function startAgent() {
  const btn = document.querySelector('#startModal button[onclick="startAgent()"]');
  await withLoading(btn, async () => {
    const prompt = document.getElementById('start-prompt').value.trim();
    const body = prompt ? { prompt } : {};
    const res = await fetch(`/api/agents/${agentId}/start`, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify(body),
    });
    if (res.ok) { hideModal(); loadAgentInfo(); showToast('Agent已启动', 'success'); }
    else { const err = await res.json(); showToast(err.error || '启动失败', 'error'); }
  });
}

async function retryAgent() {
  const btn = document.getElementById('btn-retry');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}/retry`, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({}),
    });
    if (res.ok) { loadAgentInfo(); showToast('Agent已重试', 'success'); }
    else { const err = await res.json().catch(() => ({})); showToast(err.error || '重试失败', 'error'); }
  });
}

async function stopAgent() {
  if (!confirm('Stop this agent?')) return;
  const btn = document.getElementById('btn-stop');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}/stop`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { showToast('Agent已停止', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || '停止失败', 'error'); }
    loadAgentInfo();
  });
}

function clearTerminal() { if (term) { term.clear(); } }

function openTerminal() {
  window.location.href = `/terminal?agentId=${agentId}`;
}

async function saveInstructions() {
  const btn = document.querySelector('button[onclick="saveInstructions()"]');
  await withLoading(btn, async () => {
    const val = document.getElementById('agent-instructions').value;
    const res = await fetch(`/api/agents/${agentId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ custom_instructions: val }),
    });
    if (res.ok) showToast('已保存', 'success');
    else showToast('保存失败', 'error');
  });
}

async function loadSystemPromptPreview() {
  const el = document.getElementById('system-prompt-preview');
  if (el.textContent) return;
  try {
    const res = await fetch(`/api/agents/${agentId}/system-prompt`, { headers: apiHeaders() });
    if (res.ok) { const data = await res.json(); el.textContent = data.prompt; }
  } catch (e) { console.error('Failed to load system prompt', e); }
}

function toggleSystemPrompt() {
  const el = document.getElementById('system-prompt-preview');
  if (el.style.display === 'none') { el.style.display = ''; loadSystemPromptPreview(); }
  else { el.style.display = 'none'; }
}

// ─── Init ───

initTerminal();
loadAgentInfo();
loadHistory();

// Poll every 1 second for new logs (real-time feel)
setInterval(pollLogs, 1000);
// Refresh agent info every 3 seconds
setInterval(loadAgentInfo, 3000);
