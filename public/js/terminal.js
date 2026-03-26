const agentId = window.location.pathname.split('/').pop();
let term = null;
let fitAddon = null;
let lastLogId = 0;

// ─── Activity Summary ───
const MAX_ACTIVITIES = 20;
const activities = [];
let lastActivityIsActive = false;

function parseToolActivity(content) {
  // Match [Tool: ToolName] {json_input}
  const m = content.match(/^\[Tool: (\w+)\]\s*(.*)$/);
  if (!m) return null;
  const tool = m[1];
  let detail = '';
  try {
    const input = JSON.parse(m[2]);
    switch (tool) {
      case 'Read':
        detail = '读取文件 <code>' + escHtml(basename(input.file_path || '')) + '</code>';
        break;
      case 'Edit':
        detail = '编辑文件 <code>' + escHtml(basename(input.file_path || '')) + '</code>';
        break;
      case 'Write':
        detail = '写入文件 <code>' + escHtml(basename(input.file_path || '')) + '</code>';
        break;
      case 'Bash':
        detail = '运行命令 <code>' + escHtml((input.command || '').slice(0, 60)) + '</code>';
        break;
      case 'Grep':
        detail = '搜索 <code>' + escHtml((input.pattern || '').slice(0, 40)) + '</code>';
        break;
      case 'Glob':
        detail = '查找文件 <code>' + escHtml((input.pattern || '').slice(0, 40)) + '</code>';
        break;
      case 'Agent':
        detail = '委派子任务 ' + escHtml((input.description || '').slice(0, 50));
        break;
      case 'WebFetch':
        detail = '获取网页 <code>' + escHtml((input.url || '').slice(0, 50)) + '</code>';
        break;
      case 'WebSearch':
        detail = '搜索网页 <code>' + escHtml((input.query || '').slice(0, 40)) + '</code>';
        break;
      case 'NotebookEdit':
        detail = '编辑Notebook <code>' + escHtml(basename(input.notebook_path || '')) + '</code>';
        break;
      default:
        detail = '调用工具 ' + escHtml(tool);
    }
  } catch {
    detail = '调用工具 ' + escHtml(tool);
  }
  return { tool, detail };
}

const TOOL_ICONS = {
  Read: '📖', Edit: '✏️', Write: '📝', Bash: '⚡', Grep: '🔍',
  Glob: '📁', Agent: '🤖', WebFetch: '🌐', WebSearch: '🔎', NotebookEdit: '📓',
};

function addActivity(tool, detail) {
  // Mark previous active item as done
  if (lastActivityIsActive && activities.length > 0) {
    activities[activities.length - 1].active = false;
  }
  activities.push({ tool, detail, time: new Date(), active: true });
  if (activities.length > MAX_ACTIVITIES) activities.shift();
  lastActivityIsActive = true;
  renderActivities();
}

function completeLastActivity() {
  if (lastActivityIsActive && activities.length > 0) {
    activities[activities.length - 1].active = false;
    lastActivityIsActive = false;
    renderActivities();
  }
}

function renderActivities() {
  const panel = document.getElementById('activity-panel');
  const list = document.getElementById('activity-list');
  const count = document.getElementById('activity-count');
  if (!panel || !list) return;

  if (activities.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  count.textContent = activities.length + ' 条记录';

  // Render newest first
  list.innerHTML = activities.slice().reverse().map(a => {
    const icon = TOOL_ICONS[a.tool] || '🔧';
    const cls = a.active ? 'activity-item active' : 'activity-item';
    const timeStr = a.time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="${cls}"><span class="activity-icon">${icon}</span><span class="activity-text">${a.detail}</span><span class="activity-time">${timeStr}</span></div>`;
  }).join('');
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function basename(p) {
  return p ? p.split('/').pop() : '';
}

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

function writeLog(log, skipActivity) {
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

    // Parse activity from tool calls (only for real-time, not history)
    if (!skipActivity) {
      const trimmed = log.content.trim();
      if (trimmed.startsWith('[Tool: ')) {
        const parsed = parseToolActivity(trimmed);
        if (parsed) addActivity(parsed.tool, parsed.detail);
      } else if (trimmed.startsWith('[Result]')) {
        completeLastActivity();
      }
    }

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
    // Parse activities from last run only (most recent context)
    logs.reverse();
    let currentRun = null;
    let runIndex = 0;
    const lastRunId = logs.length > 0 ? logs[logs.length - 1].run_id : null;
    logs.forEach(log => {
      if (log.run_id !== currentRun) {
        currentRun = log.run_id;
        runIndex++;
        if (runIndex > 1) term.writeln('');
        term.writeln('\x1b[33m━━━ Run #' + runIndex + ' ━━━\x1b[0m');
      }
      // Parse activities from last run for initial context
      const isLastRun = log.run_id === lastRunId;
      if (isLastRun && log.stream === 'stdout') {
        const trimmed = log.content.trim();
        if (trimmed.startsWith('[Tool: ')) {
          const parsed = parseToolActivity(trimmed);
          if (parsed) {
            activities.push({ tool: parsed.tool, detail: parsed.detail, time: new Date(log.created_at || Date.now()), active: false });
            if (activities.length > MAX_ACTIVITIES) activities.shift();
          }
        }
      }
      writeLog(log, true);
    });
    renderActivities();
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
      const maxTokensEl = document.getElementById('agent-maxtokens');
      if (maxTokensEl) maxTokensEl.value = agent.session_max_tokens || 200000;
      const resumeTimeoutEl = document.getElementById('agent-resumetimeout');
      if (resumeTimeoutEl) resumeTimeoutEl.value = agent.session_resume_timeout ?? 300;
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

async function saveMaxTokens() {
  const raw = parseInt(document.getElementById('agent-maxtokens').value);
  const val = Number.isNaN(raw) ? 0 : raw;
  const btn = document.querySelector('button[onclick="saveMaxTokens()"]');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ session_max_tokens: Math.max(0, val) }),
    });
    if (res.ok) showToast('已保存', 'success');
    else showToast('保存失败', 'error');
  });
}

async function saveResumeTimeout() {
  const raw = parseInt(document.getElementById('agent-resumetimeout').value);
  const val = Number.isNaN(raw) ? 300 : raw;
  const btn = document.querySelector('button[onclick="saveResumeTimeout()"]');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ session_resume_timeout: Math.max(0, val) }),
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
  window.location.href = `/terminal?agentId=${agentId}&newSession=true`;
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
