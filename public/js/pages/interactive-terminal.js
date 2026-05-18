const qs = new URLSearchParams(window.location.search);
const agentId = qs.get('agentId');
const initialNewSession = qs.get('newSession') === null ? true : qs.get('newSession') === 'true';
let term = null;
let fitAddon = null;
let ws = null;
let lastServerError = null;

function initTerminal() {
  const cs = getComputedStyle(document.documentElement);
  term = new Terminal({
    cursorBlink: true,
    theme: {
      background: cs.getPropertyValue('--bg').trim() || '#1e1e2e',
      foreground: cs.getPropertyValue('--fg').trim() || '#cdd6f4',
      cursor: cs.getPropertyValue('--accent').trim() || '#89b4fa',
      selectionBackground: cs.getPropertyValue('--selected-bg').trim() || '#45475a',
    },
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    scrollback: 50000,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  window.addEventListener('resize', () => {
    fitAddon.fit();
    sendResize();
  });

  // Forward user input to PTY via WebSocket
  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });
}

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN && term) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

let reconnectTimer = null;
let reconnectCountdown = 0;

function setStatus(text, state) {
  const el = document.getElementById('connection-status');
  // state: 'connected' | 'connecting' | 'disconnected' | 'error'
  const colors = { connected: '#3fb950', connecting: '#d29922', disconnected: '#8b949e', error: '#f85149' };
  const color = colors[state] || colors.disconnected;
  el.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>${text}`;
}

function showReconnectUI(seconds) {
  clearReconnectTimer();
  reconnectCountdown = seconds;
  const statusEl = document.getElementById('connection-status');
  const updateCountdown = () => {
    if (reconnectCountdown <= 0) {
      connectWebSocket(false);
      return;
    }
    statusEl.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d29922;margin-right:6px;vertical-align:middle"></span>` +
      `Reconnecting in ${reconnectCountdown}s... <button onclick="connectWebSocket(false)" style="margin-left:8px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:var(--header-bg);color:var(--fg);cursor:pointer;font-size:12px">Reconnect now</button>`;
    reconnectCountdown--;
    reconnectTimer = setTimeout(updateCountdown, 1000);
  };
  updateCountdown();
}

function clearReconnectTimer() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function connectWebSocket(newSession) {
  if (ws) {
    ws.close();
    ws = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const cols = term ? term.cols : 120;
  const rows = term ? term.rows : 30;
  const url = `${proto}//${location.host}/ws/terminal/${encodeURIComponent(agentId)}?newSession=${newSession}&cols=${cols}&rows=${rows}`;

  clearReconnectTimer();
  lastServerError = null;
  setStatus('Connecting...', 'connecting');
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus('Connected', 'connected');
    sendResize();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'connected':
          // If there's an existing session and we didn't ask for new, show dialog
          if (msg.hasExistingSession && !newSession && !window._sessionChosen) {
            showSessionDialog();
          } else {
            window._sessionChosen = true;
          }
          break;
        case 'output':
          // Decode base64 and write to terminal
          const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
          term.write(bytes);
          break;
        case 'exit':
          setStatus(`Process exited (code: ${msg.exitCode})`);
          term.writeln('\r\n\x1b[33m--- Process exited ---\x1b[0m');
          break;
        case 'error':
          lastServerError = msg;
          setStatus(msg.message || 'Terminal error', 'error');
          if (term) {
            term.writeln(`\r\n\x1b[31m--- ${msg.message || 'Terminal error'} (${msg.code || 'error'}) ---\x1b[0m`);
          }
          break;
      }
    } catch (e) {
      console.warn('WS message parse error', e);
    }
  };

  ws.onclose = (e) => {
    if (lastServerError) {
      setStatus(lastServerError.message || 'Terminal error', 'error');
      return;
    }
    // Don't auto-reconnect if intentionally closed (code 1000) or process exited
    if (e.code === 1000) {
      setStatus('Disconnected', 'disconnected');
    } else {
      setStatus('Connection closed', 'disconnected');
      showReconnectUI(5);
    }
  };

  ws.onerror = () => {
    setStatus('Connection failed', 'error');
    showReconnectUI(5);
  };
}

function showSessionDialog() {
  document.getElementById('sessionDialog').style.display = '';
}

function startSession(isNew) {
  window._sessionChosen = true;
  document.getElementById('sessionDialog').style.display = 'none';
  if (isNew) {
    // Reconnect with newSession=true
    connectWebSocket(true);
  }
  // If continuing, we're already connected — do nothing
}

async function reconnect(newSession) {
  if (newSession && !await showConfirm('Start a new session? This will kill the existing one.', {
    title: 'Start a new terminal session?',
    confirmLabel: 'Start new session',
  })) return;
  term.clear();
  connectWebSocket(newSession);
}

async function killSession() {
  if (!await showConfirm('Kill the terminal process?', {
    title: 'Kill terminal process?',
    confirmLabel: 'Kill process',
    tone: 'danger',
  })) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'kill' }));
  }
}

// Load agent info for breadcrumb
async function loadAgentInfo() {
  try {
    const res = await fetch(`/api/agents/${agentId}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const agent = await res.json();
    document.getElementById('agent-name').textContent = agent.name;
    document.getElementById('agent-link').textContent = agent.name;
    document.getElementById('agent-link').href = `/agents/${agentId}`;
    document.title = `HAICO - ${agent.name} Terminal`;

    // Load project info
    const pres = await fetch(`/api/projects/${agent.project_id}`, { headers: apiHeaders() });
    if (pres.ok) {
      const project = await pres.json();
      document.getElementById('project-link').textContent = project.name;
      document.getElementById('project-link').href = `/projects/${agent.project_id}`;
    }
  } catch (e) {
    console.error('Failed to load agent info', e);
  }
}

// Init
if (!agentId) {
  document.body.innerHTML = '<div style="padding:40px;color:var(--error)">Error: No agentId provided</div>';
} else {
  initTerminal();
  loadAgentInfo();
  // Start connection; default to new session to avoid attaching to stale blank PTY state
  connectWebSocket(initialNewSession);
}
