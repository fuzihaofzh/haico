// SharedWorker backing project-level live updates.
// Keeps at most one WebSocket per project across pages in the same browser profile.

const PROJECT_CLOSE_DELAY_MS = 10000;
const STALE_CLIENT_MS = 45000;
const STALE_SCAN_MS = 30000;
const MAX_RETRY_DELAY_MS = 15000;

const clients = new Map();
const projects = new Map();

function hasDebugClient() {
  for (const client of clients.values()) {
    if (client.debug) return true;
  }
  return false;
}

function debugLog() {
  if (!hasDebugClient()) return;
  const args = Array.prototype.slice.call(arguments);
  args.unshift('[HAICO WS Worker]');
  console.log.apply(console, args);
}

function getSocketStateName(ws) {
  if (!ws) return 'NONE';
  if (ws.readyState === WebSocket.CONNECTING) return 'CONNECTING';
  if (ws.readyState === WebSocket.OPEN) return 'OPEN';
  if (ws.readyState === WebSocket.CLOSING) return 'CLOSING';
  if (ws.readyState === WebSocket.CLOSED) return 'CLOSED';
  return String(ws.readyState);
}

function buildDebugSnapshot() {
  return {
    clientCount: clients.size,
    projectCount: projects.size,
    projects: Array.from(projects.values()).map(function(project) {
      return {
        projectId: project.projectId,
        subscriberCount: project.subscribers.size,
        state: project.state,
        socketState: getSocketStateName(project.ws),
        hasReconnectTimer: !!project.reconnectTimer,
        hasCloseTimer: !!project.closeTimer,
      };
    }),
  };
}

function buildWsUrl(projectId) {
  const proto = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + self.location.host + '/ws/projects/' + encodeURIComponent(projectId) + '/events';
}

function postToClient(clientId, payload) {
  const client = clients.get(clientId);
  if (!client) return false;

  try {
    client.port.postMessage(payload);
    return true;
  } catch (error) {
    debugLog('dropping client after postMessage failure', clientId, error && error.message);
    removeClient(clientId, 'postMessage failure');
    return false;
  }
}

function broadcastProject(projectId, payload) {
  const project = projects.get(projectId);
  if (!project) return;

  for (const clientId of Array.from(project.subscribers)) {
    postToClient(clientId, payload);
  }
}

function getOrCreateProject(projectId) {
  let project = projects.get(projectId);
  if (!project) {
    project = {
      projectId: projectId,
      ws: null,
      subscribers: new Set(),
      retryDelay: 1000,
      reconnectTimer: null,
      closeTimer: null,
      serverErrorSeen: false,
      closingExpected: false,
      state: 'disconnected',
    };
    projects.set(projectId, project);
  }
  return project;
}

function setProjectState(project, state) {
  project.state = state;
  broadcastProject(project.projectId, {
    type: 'status',
    projectId: project.projectId,
    state: state,
  });
}

function clearProjectTimers(project) {
  if (project.reconnectTimer) {
    clearTimeout(project.reconnectTimer);
    project.reconnectTimer = null;
  }
  if (project.closeTimer) {
    clearTimeout(project.closeTimer);
    project.closeTimer = null;
  }
}

function closeProject(projectId, reason) {
  const project = projects.get(projectId);
  if (!project) return;

  debugLog('closing project socket', projectId, reason || '');
  clearProjectTimers(project);
  project.closingExpected = true;

  const ws = project.ws;
  project.ws = null;
  projects.delete(projectId);

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try {
      ws.close(1000, reason || 'no subscribers');
    } catch (error) {
      debugLog('socket close failed', projectId, error && error.message);
    }
  }
}

function scheduleProjectClose(projectId) {
  const project = projects.get(projectId);
  if (!project || project.subscribers.size > 0 || project.closeTimer) return;

  project.closeTimer = setTimeout(function() {
    const latest = projects.get(projectId);
    if (!latest || latest.subscribers.size > 0) return;
    closeProject(projectId, 'no subscribers');
  }, PROJECT_CLOSE_DELAY_MS);

  debugLog('scheduled delayed close', projectId);
}

function scheduleReconnect(project) {
  if (project.reconnectTimer || project.subscribers.size === 0) return;

  const delay = project.retryDelay;
  project.reconnectTimer = setTimeout(function() {
    project.reconnectTimer = null;
    const latest = projects.get(project.projectId);
    if (!latest || latest.subscribers.size === 0) return;
    connectProject(latest);
  }, delay);
  project.retryDelay = Math.min(Math.round(project.retryDelay * 1.5), MAX_RETRY_DELAY_MS);
}

function connectProject(project) {
  if (project.closeTimer) {
    clearTimeout(project.closeTimer);
    project.closeTimer = null;
  }
  if (project.ws && (project.ws.readyState === WebSocket.OPEN || project.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (project.subscribers.size === 0) {
    scheduleProjectClose(project.projectId);
    return;
  }

  project.serverErrorSeen = false;
  project.closingExpected = false;
  setProjectState(project, 'connecting');

  const ws = new WebSocket(buildWsUrl(project.projectId));
  project.ws = ws;

  ws.onopen = function() {
    if (projects.get(project.projectId) !== project || project.ws !== ws) return;
    project.retryDelay = 1000;
    setProjectState(project, 'connected');
  };

  ws.onmessage = function(event) {
    if (projects.get(project.projectId) !== project || project.ws !== ws) return;

    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'error') {
        project.serverErrorSeen = true;
        setProjectState(project, 'error');
        broadcastProject(project.projectId, {
          type: 'error',
          projectId: project.projectId,
          error: msg,
        });
        return;
      }

      if (!msg.type) return;
      broadcastProject(project.projectId, {
        type: 'event',
        projectId: msg.projectId || project.projectId,
        eventType: msg.type,
        data: msg.data || msg,
      });
    } catch (error) {
      debugLog('message parse error', project.projectId, error && error.message);
    }
  };

  ws.onclose = function(event) {
    if (projects.get(project.projectId) !== project || project.ws !== ws) return;

    project.ws = null;
    setProjectState(project, project.serverErrorSeen ? 'error' : 'disconnected');

    if (project.subscribers.size === 0) {
      scheduleProjectClose(project.projectId);
      return;
    }
    if (!project.closingExpected && !project.serverErrorSeen && event.code !== 1000) {
      scheduleReconnect(project);
    }
  };

  ws.onerror = function() {
    // Browser/WebSocket will follow with close. Keep reconnect policy centralized there.
  };
}

function registerClient(clientId, port, debug) {
  if (!clientId) return null;

  const existing = clients.get(clientId);
  if (existing && existing.port !== port) {
    removeClient(clientId, 'replaced');
  }

  let client = clients.get(clientId);
  if (!client) {
    client = {
      clientId: clientId,
      port: port,
      projects: new Set(),
      lastSeen: Date.now(),
      debug: !!debug,
    };
    clients.set(clientId, client);
  } else {
    client.port = port;
    client.lastSeen = Date.now();
    client.debug = !!debug;
  }

  return client;
}

function subscribe(clientId, port, projectId, debug) {
  if (!projectId) return;

  const client = registerClient(clientId, port, debug);
  if (!client) return;

  client.lastSeen = Date.now();
  client.projects.add(projectId);

  const project = getOrCreateProject(projectId);
  project.subscribers.add(clientId);
  if (project.closeTimer) {
    clearTimeout(project.closeTimer);
    project.closeTimer = null;
  }

  postToClient(clientId, {
    type: 'status',
    projectId: projectId,
    state: project.state,
  });
  connectProject(project);
  debugLog('subscribed', clientId, projectId, 'subscribers:', project.subscribers.size);
}

function unsubscribe(clientId, projectId) {
  const client = clients.get(clientId);
  if (client) {
    client.lastSeen = Date.now();
    client.projects.delete(projectId);
  }

  const project = projects.get(projectId);
  if (!project) return;

  project.subscribers.delete(clientId);
  debugLog('unsubscribed', clientId, projectId, 'subscribers:', project.subscribers.size);
  if (project.subscribers.size === 0) scheduleProjectClose(projectId);
}

function removeClient(clientId, reason) {
  const client = clients.get(clientId);
  if (!client) return;

  debugLog('removing client', clientId, reason || '');
  for (const projectId of Array.from(client.projects)) {
    unsubscribe(clientId, projectId);
  }
  clients.delete(clientId);

  try {
    client.port.close();
  } catch (_) {
    // no-op
  }
}

function handleMessage(port, event) {
  const msg = event.data || {};
  if (!msg || !msg.type) return;

  if (msg.type === 'hello') {
    registerClient(msg.clientId, port, msg.debug);
    return;
  }

  if (msg.type === 'heartbeat') {
    const client = registerClient(msg.clientId, port, msg.debug);
    if (client) client.lastSeen = Date.now();
    return;
  }

  if (msg.type === 'subscribe') {
    subscribe(msg.clientId, port, msg.projectId, msg.debug);
    return;
  }

  if (msg.type === 'unsubscribe') {
    unsubscribe(msg.clientId, msg.projectId);
    return;
  }

  if (msg.type === 'closeClient') {
    removeClient(msg.clientId, 'page closed');
    return;
  }

  if (msg.type === 'debugSnapshot') {
    registerClient(msg.clientId, port, msg.debug);
    postToClient(msg.clientId, {
      type: 'debugSnapshot',
      requestId: msg.requestId,
      snapshot: buildDebugSnapshot(),
    });
  }
}

self.onconnect = function(event) {
  const port = event.ports[0];
  port.onmessage = function(messageEvent) {
    handleMessage(port, messageEvent);
  };
  port.start();
};

setInterval(function() {
  const now = Date.now();
  for (const client of Array.from(clients.values())) {
    if (now - client.lastSeen > STALE_CLIENT_MS) {
      removeClient(client.clientId, 'heartbeat timeout');
    }
  }
}, STALE_SCAN_MS);
