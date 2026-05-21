// Page-side client for project-level live updates.
// Exposes window.HAICOProjectEventsClient.connect(projectId, { onStatus }).

(function() {
  const WORKER_URL = '/public/js/shared/ws-worker.js?v=1';
  const WORKER_NAME = 'haico-project-events';
  const HEARTBEAT_MS = 15000;

  const clientId = createClientId();
  const projectRecords = new Map();
  let worker = null;
  let port = null;
  let heartbeatTimer = null;
  let sharedWorkerDisabled = false;
  let nextDebugRequestId = 1;
  const pendingDebugRequests = new Map();

  function createClientId() {
    const random =
      window.crypto && window.crypto.getRandomValues
        ? Array.prototype.map.call(window.crypto.getRandomValues(new Uint32Array(2)), function(part) {
            return part.toString(36);
          }).join('-')
        : Math.random().toString(36).slice(2);
    return 'page-' + Date.now().toString(36) + '-' + random;
  }

  function debugEnabled() {
    try {
      return window.localStorage && window.localStorage.getItem('haicoWsDebug') === '1';
    } catch (_) {
      return false;
    }
  }

  function debugLog() {
    if (!debugEnabled()) return;
    const args = Array.prototype.slice.call(arguments);
    args.unshift('[HAICO WS Client]');
    console.log.apply(console, args);
  }

  function canUseSharedWorker() {
    return !sharedWorkerDisabled && typeof window.SharedWorker !== 'undefined';
  }

  function sendToWorker(message) {
    if (!port) return false;

    try {
      port.postMessage(Object.assign({ clientId: clientId, debug: debugEnabled() }, message));
      return true;
    } catch (error) {
      debugLog('port postMessage failed', error && error.message);
      disableSharedWorker();
      return false;
    }
  }

  function ensurePort() {
    if (port) return true;
    if (!canUseSharedWorker()) return false;

    try {
      worker = new SharedWorker(WORKER_URL, WORKER_NAME);
      port = worker.port;
      port.onmessage = handleWorkerMessage;
      port.onmessageerror = function(error) {
        debugLog('port message error', error);
        disableSharedWorker();
      };
      port.start();
      startHeartbeat();
      sendToWorker({ type: 'hello' });
      return true;
    } catch (error) {
      debugLog('SharedWorker unavailable', error && error.message);
      sharedWorkerDisabled = true;
      return false;
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = window.setInterval(function() {
      sendToWorker({ type: 'heartbeat' });
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function disableSharedWorker() {
    if (sharedWorkerDisabled) return;
    sharedWorkerDisabled = true;
    stopHeartbeat();

    if (port) {
      try {
        port.close();
      } catch (_) {
        // no-op
      }
    }
    port = null;
    worker = null;

    for (const record of projectRecords.values()) {
      record.subscribed = false;
      for (const handle of Array.from(record.handles)) {
        startDirectFallback(handle);
      }
    }
  }

  function getProjectRecord(projectId) {
    let record = projectRecords.get(projectId);
    if (!record) {
      record = {
        projectId: projectId,
        handles: new Set(),
        subscribed: false,
        status: 'disconnected',
      };
      projectRecords.set(projectId, record);
    }
    return record;
  }

  function ensureSubscribed(record) {
    if (record.subscribed || record.handles.size === 0) return true;
    if (!ensurePort()) return false;

    const sent = sendToWorker({ type: 'subscribe', projectId: record.projectId });
    if (sent) {
      record.subscribed = true;
      debugLog('subscribe', record.projectId, 'handles:', record.handles.size);
    }
    return sent;
  }

  function unsubscribeRecordIfIdle(record) {
    if (record.handles.size > 0 || !record.subscribed) return;

    sendToWorker({ type: 'unsubscribe', projectId: record.projectId });
    record.subscribed = false;
    projectRecords.delete(record.projectId);
    debugLog('unsubscribe', record.projectId);
  }

  function handleWorkerMessage(event) {
    const msg = event.data || {};

    if (msg.type === 'debugSnapshot') {
      const pending = pendingDebugRequests.get(msg.requestId);
      if (pending) {
        pendingDebugRequests.delete(msg.requestId);
        window.clearTimeout(pending.timer);
        pending.resolve(msg.snapshot);
      }
      return;
    }

    if (!msg.projectId) return;

    const record = projectRecords.get(msg.projectId);
    if (!record) return;

    if (msg.type === 'status') {
      record.status = msg.state || 'disconnected';
      for (const handle of Array.from(record.handles)) {
        notifyStatus(handle, record.status);
      }
      return;
    }

    if (msg.type === 'error') {
      for (const handle of Array.from(record.handles)) {
        notifyStatus(handle, 'error');
        emit(handle, 'error', msg.error || msg);
      }
      return;
    }

    if (msg.type === 'event' && msg.eventType) {
      for (const handle of Array.from(record.handles)) {
        emit(handle, msg.eventType, msg.data);
      }
    }
  }

  function notifyStatus(handle, state) {
    if (!handle || handle.closed || typeof handle.onStatus !== 'function') return;
    try {
      handle.onStatus(state);
    } catch (error) {
      console.error('WS status listener error:', error);
    }
  }

  function emit(handle, type, data) {
    if (!handle || handle.closed) return;

    const listeners = handle.listeners[type] || [];
    listeners.forEach(function(callback) {
      try {
        callback(data);
      } catch (error) {
        console.error('WS listener error:', error);
      }
    });

    const wildcardListeners = handle.listeners['*'] || [];
    if (wildcardListeners.length === 0) return;

    const wildcardPayload =
      data && typeof data === 'object'
        ? Object.assign({ type: type }, data)
        : { type: type, data: data };
    wildcardListeners.forEach(function(callback) {
      try {
        callback(wildcardPayload);
      } catch (_) {
        // Preserve existing best-effort wildcard behavior.
      }
    });
  }

  function createSharedHandle(projectId, options) {
    const record = getProjectRecord(projectId);
    const handle = {
      projectId: projectId,
      listeners: Object.create(null),
      closed: false,
      direct: null,
      onStatus: options && options.onStatus,
      on: function(type, callback) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(callback);
        if (this.direct) this.direct.on(type, callback);
        return this;
      },
      close: function() {
        if (this.closed) return;
        this.closed = true;
        if (this.direct) {
          this.direct.close();
          this.direct = null;
        }
        record.handles.delete(this);
        unsubscribeRecordIfIdle(record);
      },
    };

    record.handles.add(handle);
    if (!ensureSubscribed(record)) {
      startDirectFallback(handle);
    } else {
      notifyStatus(handle, record.status);
    }

    return handle;
  }

  function startDirectFallback(handle) {
    if (!handle || handle.closed || handle.direct) return;

    const direct = connectDirect(handle.projectId, { onStatus: handle.onStatus });
    Object.keys(handle.listeners).forEach(function(type) {
      handle.listeners[type].forEach(function(callback) {
        direct.on(type, callback);
      });
    });
    handle.direct = direct;
    debugLog('using direct fallback', handle.projectId);
  }

  function connectDirect(projectId, options) {
    const listeners = {};
    let ws = null;
    let closed = false;
    let retryDelay = 1000;
    let serverErrorSeen = false;

    function on(type, callback) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(callback);
      return api;
    }

    function emitDirect(type, data) {
      (listeners[type] || []).forEach(function(callback) {
        try {
          callback(data);
        } catch (error) {
          console.error('WS listener error:', error);
        }
      });

      (listeners['*'] || []).forEach(function(callback) {
        const wildcardPayload =
          data && typeof data === 'object'
            ? Object.assign({ type: type }, data)
            : { type: type, data: data };
        try {
          callback(wildcardPayload);
        } catch (_) {
          // Preserve existing best-effort wildcard behavior.
        }
      });
    }

    function updateStatus(state) {
      if (options && typeof options.onStatus === 'function') {
        try {
          options.onStatus(state);
        } catch (error) {
          console.error('WS status listener error:', error);
        }
      }
    }

    function connect() {
      if (closed) return;
      updateStatus('connecting');
      serverErrorSeen = false;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + window.location.host + '/ws/projects/' + encodeURIComponent(projectId) + '/events');

      ws.onopen = function() {
        retryDelay = 1000;
        updateStatus('connected');
      };

      ws.onmessage = function(event) {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'error') {
            serverErrorSeen = true;
            updateStatus('error');
            emitDirect('error', msg);
            return;
          }
          if (msg.type) emitDirect(msg.type, msg.data || msg);
        } catch (error) {
          console.warn('WS message parse error:', error);
        }
      };

      ws.onclose = function(event) {
        updateStatus(serverErrorSeen ? 'error' : 'disconnected');
        if (!closed && !serverErrorSeen && event.code !== 1000) {
          window.setTimeout(connect, retryDelay);
          retryDelay = Math.min(Math.round(retryDelay * 1.5), 15000);
        }
      };

      ws.onerror = function() {
        // onclose handles status and reconnect.
      };
    }

    const api = {
      on: on,
      close: function() {
        closed = true;
        if (ws) ws.close();
      },
    };

    connect();
    return api;
  }

  function connect(projectId, options) {
    if (!projectId) {
      return {
        on: function() {},
        close: function() {},
      };
    }

    if (!canUseSharedWorker()) {
      return connectDirect(projectId, options || {});
    }

    return createSharedHandle(projectId, options || {});
  }

  function suspendSharedConnections() {
    if (!port) return;

    sendToWorker({ type: 'closeClient' });
    stopHeartbeat();
    port = null;
    worker = null;

    for (const record of projectRecords.values()) {
      record.subscribed = false;
      record.status = 'disconnected';
    }
  }

  function resumeSharedConnections() {
    if (!canUseSharedWorker()) return;

    for (const record of projectRecords.values()) {
      if (record.handles.size > 0) ensureSubscribed(record);
    }
  }

  function debugSnapshot(timeoutMs) {
    const timeout = typeof timeoutMs === 'number' ? timeoutMs : 1000;
    if (!ensurePort()) {
      return Promise.resolve({
        sharedWorkerDisabled: true,
        clientCount: 0,
        projectCount: 0,
        projects: [],
      });
    }

    const requestId = 'debug-' + nextDebugRequestId++;
    return new Promise(function(resolve, reject) {
      const timer = window.setTimeout(function() {
        pendingDebugRequests.delete(requestId);
        reject(new Error('Timed out waiting for SharedWorker debug snapshot'));
      }, timeout);
      pendingDebugRequests.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      if (!sendToWorker({ type: 'debugSnapshot', requestId: requestId })) {
        window.clearTimeout(timer);
        pendingDebugRequests.delete(requestId);
        resolve({
          sharedWorkerDisabled: true,
          clientCount: 0,
          projectCount: 0,
          projects: [],
        });
      }
    });
  }

  window.addEventListener('pagehide', function() {
    suspendSharedConnections();
  });

  window.addEventListener('pageshow', function(event) {
    if (event.persisted) resumeSharedConnections();
  });

  window.addEventListener('beforeunload', function() {
    suspendSharedConnections();
  });

  window.HAICOProjectEventsClient = {
    connect: connect,
    _debugSnapshot: debugSnapshot,
    _debugState: function() {
      return {
        clientId: clientId,
        sharedWorkerDisabled: sharedWorkerDisabled,
        projects: Array.from(projectRecords.keys()),
      };
    },
  };
})();
