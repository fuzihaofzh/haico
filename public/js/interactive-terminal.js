const agentId = new URLSearchParams(window.location.search).get('agentId');
let term = null;
let fitAddon = null;
let ws = null;

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

function setStatus(text) {
  document.getElementById('connection-status').textContent = text;
}

function connectWebSocket(newSession) {
  if (ws) {
    ws.close();
    ws = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const cols = term ? term.cols : 120;
  const rows = term ? term.rows : 30;
  const url = `${proto}//${location.host}/ws/terminal/${agentId}?newSession=${newSession}&cols=${cols}&rows=${rows}`;

  setStatus('Connecting...');
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus('Connected');
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
      }
    } catch (e) {
      console.error('WS message parse error', e);
    }
  };

  ws.onclose = () => {
    setStatus('Disconnected');
  };

  ws.onerror = () => {
    setStatus('Connection error');
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

function reconnect(newSession) {
  if (newSession && !confirm('Start a new session? This will kill the existing one.')) return;
  term.clear();
  connectWebSocket(newSession);
}

function killSession() {
  if (!confirm('Kill the terminal process?')) return;
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
    document.title = `Argus - ${agent.name} Terminal`;

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
  // Start connection — first time, don't force new session
  connectWebSocket(false);
}
