const agentId = window.location.pathname.split('/').pop();
let term = null;
let fitAddon = null;
let lastLogId = 0;
let logsPollInFlight = false;
const CUSTOM_COMMAND_PROFILE_VALUE = '__custom__';

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
        detail = 'Read file <code>' + escHtml(basename(input.file_path || '')) + '</code>';
        break;
      case 'Edit':
        detail = 'Edit file <code>' + escHtml(basename(input.file_path || '')) + '</code>';
        break;
      case 'Write':
        detail = 'Write file <code>' + escHtml(basename(input.file_path || '')) + '</code>';
        break;
      case 'Bash':
        detail = 'Run command <code>' + escHtml((input.command || '').slice(0, 60)) + '</code>';
        break;
      case 'Grep':
        detail = 'Search <code>' + escHtml((input.pattern || '').slice(0, 40)) + '</code>';
        break;
      case 'Glob':
        detail = 'Find files <code>' + escHtml((input.pattern || '').slice(0, 40)) + '</code>';
        break;
      case 'Agent':
        detail = 'Delegate subtask ' + escHtml((input.description || '').slice(0, 50));
        break;
      case 'WebFetch':
        detail = 'Fetch URL <code>' + escHtml((input.url || '').slice(0, 50)) + '</code>';
        break;
      case 'WebSearch':
        detail = 'Web search <code>' + escHtml((input.query || '').slice(0, 40)) + '</code>';
        break;
      case 'NotebookEdit':
        detail = 'Edit notebook <code>' + escHtml(basename(input.notebook_path || '')) + '</code>';
        break;
      default:
        detail = 'Invoke tool ' + escHtml(tool);
    }
  } catch {
    detail = 'Invoke tool ' + escHtml(tool);
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
  count.textContent = activities.length + ' activities';

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

function getCommandProfileManager() {
  return window.HAICOCommandProfiles || null;
}

async function populateTerminalCommandProfileSelect() {
  const select = document.getElementById('agent-command-profile');
  if (!select) return;

  const manager = getCommandProfileManager();
  if (!manager) {
    select.innerHTML = `
      <option value="">Use project default</option>
      <option value="${CUSTOM_COMMAND_PROFILE_VALUE}">Custom command</option>
    `;
    return;
  }

  await manager.ensureLoaded();
  manager.populateSelect(select, {
    includeProjectDefault: true,
    projectDefaultLabel: 'Use project default',
    customLabel: 'Custom command',
  });
}

function setTerminalCommandProfileSelection(commandTemplate, commandType) {
  const select = document.getElementById('agent-command-profile');
  if (!select) return;

  const manager = getCommandProfileManager();
  const normalizedCommand = String(commandTemplate || '').trim();
  if (!normalizedCommand) {
    select.value = '';
    return;
  }

  const matchedProfile = manager?.findMatch(normalizedCommand, commandType) || null;
  if (matchedProfile) {
    select.value = matchedProfile.id;
    return;
  }

  const option = select.querySelector(`option[value="${CUSTOM_COMMAND_PROFILE_VALUE}"]`) || document.createElement('option');
  option.value = CUSTOM_COMMAND_PROFILE_VALUE;
  option.textContent = `Legacy/custom: ${normalizedCommand}${commandType ? ` (${commandType})` : ''}`;
  if (!option.parentElement) select.appendChild(option);
  select.value = CUSTOM_COMMAND_PROFILE_VALUE;
}

function updateTerminalCommandPreview(commandTemplate, commandType, fallbackText) {
  const preview = document.getElementById('agent-command-template-preview');
  if (!preview) return;
  const command = String(commandTemplate || '').trim();
  preview.textContent = command
    ? `Command: ${command}${commandType ? ` (${commandType})` : ''}`
    : fallbackText;
}

async function hydrateTerminalCommandProfileControls(agent) {
  const input = document.getElementById('agent-command-template');
  if (!input) return;

  await populateTerminalCommandProfileSelect();
  input.value = agent?.command_template || '';
  setTerminalCommandProfileSelection(agent?.command_template, agent?.command_type);
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(document.getElementById('agent-command-profile')?.value || '') || null;
  input.dataset.commandType = selectedProfile?.type || agent?.command_type || '';
  updateTerminalCommandPreview(input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
}

function handleTerminalCommandProfileChange() {
  const select = document.getElementById('agent-command-profile');
  const input = document.getElementById('agent-command-template');
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  if (selectedProfile) {
    input.value = selectedProfile.command || '';
    input.dataset.commandType = selectedProfile.type || '';
    updateTerminalCommandPreview(input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
    return;
  }

  if (select.value === '') {
    input.value = '';
    input.dataset.commandType = '';
    updateTerminalCommandPreview('', '', 'Using project-level Tool Path setting.');
    return;
  }

  updateTerminalCommandPreview(input.value, input.dataset.commandType, 'Select a tool configured in Settings.');
}

function handleTerminalCommandInputChange() {
  const select = document.getElementById('agent-command-profile');
  const input = document.getElementById('agent-command-template');
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  const normalizedCommand = String(input.value || '').trim();

  if (!normalizedCommand) {
    select.value = '';
    input.dataset.commandType = '';
    updateTerminalCommandPreview('', '', 'Using project-level Tool Path setting.');
    return;
  }

  if (selectedProfile && String(selectedProfile.command || '').trim() === normalizedCommand) {
    return;
  }

  if (select.value === '' || selectedProfile) {
    select.value = CUSTOM_COMMAND_PROFILE_VALUE;
  }
  updateTerminalCommandPreview(input.value, input.dataset.commandType, 'Select a tool configured in Settings.');
}

function buildTerminalCommandConfigPayload() {
  const select = document.getElementById('agent-command-profile');
  const input = document.getElementById('agent-command-template');
  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select?.value || '') || null;
  const commandTemplate = String(input?.value || '').trim();

  if (selectedProfile) {
    return {
      command_template: selectedProfile.command,
      command_type: selectedProfile.type,
    };
  }

  if (!commandTemplate) {
    return { command_template: null, command_type: null };
  }

  return {
    command_template: commandTemplate,
    command_type: input?.dataset.commandType || undefined,
  };
}

async function refreshTerminalCommandProfileControls() {
  const select = document.getElementById('agent-command-profile');
  const input = document.getElementById('agent-command-template');
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const selectedType = manager?.getById(select.value)?.type || window.currentAgentState?.command_type || null;
  await populateTerminalCommandProfileSelect();
  setTerminalCommandProfileSelection(input.value, selectedType);
  const selectedProfile = manager?.getById(select.value) || null;
  input.dataset.commandType = selectedProfile?.type || selectedType || '';
  updateTerminalCommandPreview(input.value, input.dataset.commandType, 'Using project-level Tool Path setting.');
}

window.addEventListener('haico:command-profiles-changed', () => {
  refreshTerminalCommandProfileControls().catch((error) => {
    console.error('Failed to refresh terminal command profile controls', error);
  });
});

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
  if (logsPollInFlight) return;
  logsPollInFlight = true;
  try {
    const url = lastLogId > 0
      ? `/api/agents/${agentId}/logs?since_id=${lastLogId}&limit=200`
      : `/api/agents/${agentId}/logs?limit=200`;
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) return;
    const logs = await res.json();
    if (!logs.length) return;

    const newLogs = logs.filter(l => l.id > lastLogId);
    if (newLogs.length > 0) {
      if (lastLogId === 0) newLogs.reverse();
      newLogs.forEach(writeLog);
      lastLogId = Math.max(lastLogId, ...newLogs.map(l => l.id));
    }
  } catch (e) { console.error('Failed to poll logs', e); }
  finally { logsPollInFlight = false; }
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
            activities.push({ tool: parsed.tool, detail: parsed.detail, time: parseServerDate(log.created_at) || new Date(), active: false });
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
    document.getElementById('agent-started').textContent = formatLocalDateTime(agent.started_at);
    document.getElementById('agent-status').textContent = agent.status;
    document.getElementById('agent-status').className = `status-badge status-${agent.status}`;
    document.title = `HAICO - ${agent.name}`;
    window.currentAgentState = agent;
    if (window.AgentFiles && typeof window.AgentFiles.setAgent === 'function') {
      window.AgentFiles.setAgent(agent);
    }

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
      if (maxRunsEl) maxRunsEl.value = agent.session_max_runs ?? 10;
      const maxTokensEl = document.getElementById('agent-maxtokens');
      if (maxTokensEl) maxTokensEl.value = agent.session_max_tokens ?? 200000;
      const resumeTimeoutEl = document.getElementById('agent-resumetimeout');
      if (resumeTimeoutEl) resumeTimeoutEl.value = agent.session_resume_timeout ?? 300;
      hydrateTerminalCommandProfileControls(agent);
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
    if (res.ok) { loadAgentInfo(); showToast('Agent started', 'success'); }
    else { const err = await res.json(); showToast(err.error || 'Failed to start', 'error'); }
  });
}

async function saveWorkdir() {
  const val = document.getElementById('agent-workdir').value.trim();
  const btn = document.querySelector('button[onclick="saveWorkdir()"]');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}`, {
      method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ working_directory: val || null }),
    });
    if (res.ok) {
      showToast('Saved', 'success');
      loadAgentInfo();
      if (window.AgentFiles && typeof window.AgentFiles.handleWorkingDirectoryChange === 'function') {
        window.AgentFiles.handleWorkingDirectoryChange();
      }
    } else {
      showToast('Failed to save', 'error');
    }
  });
}

async function saveCommandConfig() {
  const btn = document.querySelector('button[onclick="saveCommandConfig()"]');
  await withLoading(btn, async () => {
    const body = buildTerminalCommandConfigPayload();
    const res = await fetch(`/api/agents/${agentId}`, {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    if (res.ok) {
      showToast('Saved', 'success');
      window._instructionsLoaded = false;
      await loadAgentInfo();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to save', 'error');
    }
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
    if (res.ok) showToast('Saved', 'success');
    else showToast('Failed to save', 'error');
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
    if (res.ok) showToast('Saved', 'success');
    else showToast('Failed to save', 'error');
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
    if (res.ok) showToast('Saved', 'success');
    else showToast('Failed to save', 'error');
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
    if (res.ok) { hideModal(); loadAgentInfo(); showToast('Agent started', 'success'); }
    else { const err = await res.json(); showToast(err.error || 'Failed to start', 'error'); }
  });
}

async function retryAgent() {
  const btn = document.getElementById('btn-retry');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}/retry`, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({}),
    });
    if (res.ok) { loadAgentInfo(); showToast('Agent retried', 'success'); }
    else { const err = await res.json().catch(() => ({})); showToast(err.error || 'Failed to retry', 'error'); }
  });
}

async function stopAgent() {
  if (!await showConfirm('Stop this agent?', {
    title: 'Stop agent?',
    confirmLabel: 'Stop',
  })) return;
  const btn = document.getElementById('btn-stop');
  await withLoading(btn, async () => {
    const res = await fetch(`/api/agents/${agentId}/stop`, { method: 'POST', headers: apiHeaders(), body: '{}' });
    if (res.ok) { showToast('Agent stopped', 'success'); } else { const e = await res.json().catch(() => ({})); showToast(e.error || 'Failed to stop', 'error'); }
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
    if (res.ok) showToast('Saved', 'success');
    else showToast('Failed to save', 'error');
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

// ─── Messages (Mail UI) ───

let allAgents = [];
let mailFolder = 'inbox';       // 'inbox' | 'sent'
let mailMessages = [];          // current folder messages
let mailSelectedId = null;      // currently viewed message id
let mailFilterText = '';        // search filter

async function loadMessages() {
  try {
    var endpoint = mailFolder === 'sent'
      ? '/api/agents/' + agentId + '/messages/sent?limit=50'
      : '/api/agents/' + agentId + '/messages?limit=50';
    var res = await fetch(endpoint, { headers: apiHeaders() });
    if (!res.ok) return;
    var data = await res.json();
    mailMessages = data.messages || [];

    // Update unread badge (always from inbox)
    if (mailFolder === 'inbox') {
      var unread = mailMessages.filter(function(m) { return m.status === 'unread'; }).length;
      var badge = document.getElementById('unread-badge');
      if (unread > 0) { badge.textContent = unread; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    }

    mailRenderList();
    // Re-render detail if selected message is still in list
    if (mailSelectedId) {
      var found = mailMessages.find(function(m) { return m.id === mailSelectedId; });
      if (found) mailShowDetail(found, true);
    }
  } catch(e) {}
}

function mailRenderList() {
  var container = document.getElementById('mail-list');
  var filtered = mailMessages;
  if (mailFilterText) {
    var q = mailFilterText.toLowerCase();
    filtered = mailMessages.filter(function(m) {
      var name = (mailFolder === 'sent' ? (m.to_name || '') : (m.from_name || '')).toLowerCase();
      var subj = (m.subject || '').toLowerCase();
      return name.indexOf(q) !== -1 || subj.indexOf(q) !== -1;
    });
  }
  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px">' +
      (mailFilterText ? 'No matching messages' : 'No messages') + '</div>';
    return;
  }
  container.innerHTML = filtered.map(function(m) {
    var isUnread = m.status === 'unread';
    var isSel = m.id === mailSelectedId;
    var cls = 'mail-item' + (isUnread ? ' unread' : '') + (isSel ? ' selected' : '');
    var personName = mailFolder === 'sent'
      ? (m.to_name || m.to_agent_id.slice(0,8))
      : (m.from_name || m.from_agent_id.slice(0,8));
    var subject = m.subject ? esc(m.subject) : '<i style="opacity:.5">(no subject)</i>';
    return '<div class="' + cls + '" data-mid="' + m.id + '" onclick="mailSelect(\'' + m.id + '\')">' +
      '<div class="mail-item-content">' +
        '<div class="mail-item-top">' +
          '<span class="mail-item-sender">' + esc(personName) + '</span>' +
          '<span class="mail-item-time">' + timeAgo(m.created_at) + '</span>' +
        '</div>' +
        '<div class="mail-item-subject">' + subject + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function mailSelect(msgId) {
  var msg = mailMessages.find(function(m) { return m.id === msgId; });
  if (!msg) return;
  mailSelectedId = msgId;
  // Highlight in list
  var items = document.querySelectorAll('#mail-list .mail-item');
  items.forEach(function(el) { el.classList.toggle('selected', el.dataset.mid === msgId); });
  mailShowDetail(msg, false);
  // Mark as read if unread inbox message
  if (mailFolder === 'inbox' && msg.status === 'unread') {
    msg.status = 'read';
    fetch('/api/agents/' + agentId + '/messages/' + msgId, { method: 'PUT', headers: apiHeaders() })
      .then(function() {
        // Update badge and list item styling
        var unread = mailMessages.filter(function(m) { return m.status === 'unread'; }).length;
        var badge = document.getElementById('unread-badge');
        if (unread > 0) { badge.textContent = unread; badge.style.display = ''; }
        else { badge.style.display = 'none'; }
        var el = document.querySelector('#mail-list .mail-item[data-mid="' + msgId + '"]');
        if (el) el.classList.remove('unread');
      });
  }
}

function mailShowDetail(msg, preserveReply) {
  var pane = document.getElementById('mail-detail');
  var isSent = mailFolder === 'sent';
  var personLabel = isSent ? 'To' : 'From';
  var personName = isSent ? (msg.to_name || msg.to_agent_id.slice(0,8)) : (msg.from_name || msg.from_agent_id.slice(0,8));
  var dateStr = msg.created_at ? new Date(msg.created_at + (msg.created_at.includes('Z') ? '' : 'Z')).toLocaleString() : '';

  pane.innerHTML =
    '<div class="mail-detail-content">' +
      '<div class="mail-detail-head">' +
        '<div class="mail-detail-subject">' + (msg.subject ? esc(msg.subject) : '<i style="opacity:.5">(no subject)</i>') + '</div>' +
        '<div class="mail-detail-meta">' +
          '<span>' + personLabel + ': <strong>' + esc(personName) + '</strong></span>' +
          '<span>' + dateStr + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="mail-detail-body">' + esc(msg.body) + '</div>' +
      (isSent ? '' :
        '<div class="mail-detail-actions">' +
          '<button class="btn btn-sm" onclick="mailShowReply()">Reply</button>' +
        '</div>') +
      '<div id="mail-reply-area"></div>' +
    '</div>';
}

function mailShowReply() {
  var msg = mailMessages.find(function(m) { return m.id === mailSelectedId; });
  if (!msg) return;
  var area = document.getElementById('mail-reply-area');
  if (area.innerHTML) { area.innerHTML = ''; return; }
  var reSubject = (msg.subject || '').startsWith('Re: ') ? msg.subject : 'Re: ' + (msg.subject || '');
  area.innerHTML =
    '<div class="mail-reply-box">' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">Reply to <strong>' + esc(msg.from_name || msg.from_agent_id.slice(0,8)) + '</strong> — ' + esc(reSubject) + '</div>' +
      '<textarea id="mail-reply-body" placeholder="Write your reply…"></textarea>' +
      '<div class="mail-reply-bar">' +
        '<button class="btn btn-sm" onclick="document.getElementById(\'mail-reply-area\').innerHTML=\'\'">Cancel</button>' +
        '<button class="btn btn-sm btn-primary" onclick="mailSendReply()">Send</button>' +
      '</div>' +
    '</div>';
  document.getElementById('mail-reply-body').focus();
}

async function mailSendReply() {
  var msg = mailMessages.find(function(m) { return m.id === mailSelectedId; });
  if (!msg) return;
  var body = document.getElementById('mail-reply-body').value;
  if (!body.trim()) { showToast('Message body is required', 'error'); return; }
  var reSubject = (msg.subject || '').startsWith('Re: ') ? msg.subject : 'Re: ' + (msg.subject || '');
  try {
    var res = await fetch('/api/agents/' + agentId + '/messages/send', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ to: msg.from_agent_id, subject: reSubject, body: body, reply_to_id: msg.id })
    });
    if (res.ok) {
      showToast('Reply sent', 'success');
      document.getElementById('mail-reply-area').innerHTML = '';
      loadMessages();
    } else {
      var err = await res.json();
      showToast(err.error || 'Failed to send', 'error');
    }
  } catch(e) { showToast('Network error', 'error'); }
}

function mailSwitchTab(folder) {
  mailFolder = folder;
  mailSelectedId = null;
  mailFilterText = '';
  var searchInput = document.querySelector('.mail-search-input');
  if (searchInput) searchInput.value = '';
  document.querySelectorAll('.mail-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.folder === folder);
  });
  document.getElementById('mail-detail').innerHTML = '<div class="mail-detail-empty">← Select a message</div>';
  loadMessages();
}

function mailFilter(text) {
  mailFilterText = text;
  mailRenderList();
}

async function mailMarkAllRead() {
  await fetch('/api/agents/' + agentId + '/messages/read-all', { method: 'POST', headers: apiHeaders() });
  showToast('All messages marked as read', 'success');
  loadMessages();
}

async function mailCompose(prefillTo, prefillSubject, prefillReplyTo) {
  // Load agents if not loaded
  if (allAgents.length === 0) {
    try {
      var aRes = await fetch('/api/agents/' + agentId, { headers: apiHeaders() });
      var me = await aRes.json();
      var pRes = await fetch('/api/projects/' + me.project_id + '/agents', { headers: apiHeaders() });
      allAgents = await pRes.json();
    } catch(e) {}
  }

  var existing = document.getElementById('send-msg-dialog');
  if (existing) { existing.remove(); return; }
  var opts = allAgents.filter(function(a) { return a.id !== agentId; }).map(function(a) {
    var sel = prefillTo && a.id === prefillTo ? ' selected' : '';
    return '<option value="' + a.id + '"' + sel + '>' + esc(a.name) + '</option>';
  }).join('');

  var overlay = document.createElement('div');
  overlay.id = 'send-msg-dialog';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:199;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML =
    '<div style="background:var(--header-bg);border:1px solid var(--border);border-radius:8px;padding:20px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:380px;max-width:90vw">' +
      '<div style="font-weight:600;margin-bottom:12px;font-size:15px">Compose Message</div>' +
      '<div style="margin-bottom:8px"><label style="font-size:12px;color:var(--text-secondary)">To</label>' +
        '<select id="msg-to" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px;margin-top:2px">' + opts + '</select></div>' +
      '<div style="margin-bottom:8px"><label style="font-size:12px;color:var(--text-secondary)">Subject</label>' +
        '<input type="text" id="msg-subject" value="' + esc(prefillSubject || '') + '" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px;margin-top:2px"></div>' +
      '<div style="margin-bottom:12px"><label style="font-size:12px;color:var(--text-secondary)">Message</label>' +
        '<textarea id="msg-body" rows="5" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px;margin-top:2px;font-family:inherit;resize:vertical"></textarea></div>' +
      (prefillReplyTo ? '<input type="hidden" id="msg-reply-to" value="' + prefillReplyTo + '">' : '') +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="btn btn-sm" onclick="document.getElementById(\'send-msg-dialog\').remove()">Cancel</button>' +
        '<button class="btn btn-sm btn-primary" onclick="mailSendCompose()">Send</button>' +
      '</div>' +
    '</div>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

async function mailSendCompose() {
  var to = document.getElementById('msg-to').value;
  var subject = document.getElementById('msg-subject').value;
  var body = document.getElementById('msg-body').value;
  var replyToEl = document.getElementById('msg-reply-to');
  var replyTo = replyToEl ? replyToEl.value : undefined;
  if (!to || !body.trim()) { showToast('Recipient and message are required', 'error'); return; }
  try {
    var payload = { to: to, subject: subject, body: body };
    if (replyTo) payload.reply_to_id = replyTo;
    var res = await fetch('/api/agents/' + agentId + '/messages/send', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('Message sent', 'success');
      var dialog = document.getElementById('send-msg-dialog');
      if (dialog) dialog.remove();
      loadMessages();
    } else {
      var err = await res.json();
      showToast(err.error || 'Failed to send', 'error');
    }
  } catch(e) { showToast('Network error', 'error'); }
}

// Keep old function names as aliases for compatibility
function showSendMessage() { mailCompose(); }
function markAllRead() { mailMarkAllRead(); }
function sendMessage() { mailSendCompose(); }

// ─── Init ───

initTerminal();
loadAgentInfo();
loadHistory();
loadMessages();

// Poll every 1 second for new logs (real-time feel)
setInterval(pollLogs, 1000);
// Refresh agent info every 3 seconds
setInterval(loadAgentInfo, 3000);
// Refresh messages every 10 seconds
setInterval(loadMessages, 10000);
