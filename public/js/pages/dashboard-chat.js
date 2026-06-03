import { initDashboardPage, loadDashboardProjects, setupDashboardWS } from './dashboard-core.js';
import { showToast } from '../components/toast.js';

// ── Constants ──
const STORAGE_KEY = 'haico.chat.store';
const OLD_PROFILE_KEY = 'haico.dashboardChat.profileId';
const OLD_PROJECT_KEY = 'haico.dashboardChat.projectId';
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 100;
const TRIM_TO = 80;

// ── State ──
let _store = { conversations: [], activeId: null };
let _projectsById = {};
let _profiles = [];
let _pending = false;

// ── Persistence ──

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { conversations: [], activeId: null };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.conversations)) return { conversations: [], activeId: null };
    // Validate each conversation
    parsed.conversations = parsed.conversations.filter((c) =>
      c && typeof c.id === 'string' && Array.isArray(c.messages)
    );
    return parsed;
  } catch (_) {
    return { conversations: [], activeId: null };
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_store));
  } catch (_) {
    // Quota exceeded — drop oldest conversation and retry
    if (_store.conversations.length > 1) {
      _store.conversations.sort((a, b) => a.updatedAt - b.updatedAt);
      _store.conversations.shift();
      if (_store.activeId && !_store.conversations.find((c) => c.id === _store.activeId)) {
        _store.activeId = _store.conversations.length ? _store.conversations[_store.conversations.length - 1].id : null;
      }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_store)); } catch (_2) { /* give up */ }
    }
  }
}

function migrateOldPreferences() {
  try {
    const oldProfileId = localStorage.getItem(OLD_PROFILE_KEY) || '';
    const oldProjectId = localStorage.getItem(OLD_PROJECT_KEY) || '';
    localStorage.removeItem(OLD_PROFILE_KEY);
    localStorage.removeItem(OLD_PROJECT_KEY);
    // Return for potential use — but don't auto-create a conversation
    return { profileId: oldProfileId, projectId: oldProjectId };
  } catch (_) {
    return { profileId: '', projectId: '' };
  }
}

// ── Conversation CRUD ──

function createConversation(profileId, profileName, projectId, projectName) {
  const conv = {
    id: crypto.randomUUID(),
    title: 'New Chat',
    profileId: profileId || '',
    profileName: profileName || 'Default CLI',
    projectId: projectId || '',
    projectName: projectName || 'Global',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  _store.conversations.unshift(conv);
  if (_store.conversations.length > MAX_CONVERSATIONS) {
    _store.conversations.length = MAX_CONVERSATIONS;
  }
  _store.activeId = conv.id;
  saveStore();
  return conv;
}

function deleteConversation(id) {
  const idx = _store.conversations.findIndex((c) => c.id === id);
  if (idx === -1) return;
  _store.conversations.splice(idx, 1);
  if (_store.activeId === id) {
    _store.activeId = _store.conversations.length ? _store.conversations[0].id : null;
  }
  saveStore();
}

function getActiveConversation() {
  if (!_store.activeId) return null;
  return _store.conversations.find((c) => c.id === _store.activeId) || null;
}

function setActiveConversation(id) {
  _store.activeId = id;
  saveStore();
}

function trimConversationMessages(conv) {
  if (conv.messages.length <= MAX_MESSAGES) return;
  conv.messages = conv.messages.slice(-TRIM_TO);
}

// ── Data loading ──

async function loadProjects() {
  const projects = await loadDashboardProjects();
  _projectsById = Object.fromEntries(projects.map((p) => [p.id, p]));
  return projects;
}

async function loadProfiles() {
  const manager = window.HAICOCommandProfiles || null;
  if (manager && typeof manager.ensureLoaded === 'function') {
    await manager.ensureLoaded();
  }
  _profiles = manager && typeof manager.getProfiles === 'function'
    ? manager.getProfiles()
    : [];
}

function getProfileLabel(profile) {
  const manager = window.HAICOCommandProfiles || null;
  return manager?.formatLabel ? manager.formatLabel(profile) : `${profile.name} (${profile.type})`;
}

// ── Time formatting ──

function relativeTime(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Rendering: conversation list ──

function renderConversationList() {
  const container = document.getElementById('chat-conv-list-items');
  if (!container) return;

  if (_store.conversations.length === 0) {
    container.innerHTML = h`<div class="chat-conv-list-empty" style="padding:14px;color:var(--text-secondary);font-size:12px;text-align:center">No conversations yet</div>`;
    return;
  }

  container.innerHTML = _store.conversations.map((conv) => {
    const active = conv.id === _store.activeId ? ' active' : '';
    const meta = `${conv.profileName} · ${conv.projectName}`;
    return h`<div class="chat-conv-item${active}" data-conv-id="${conv.id}">
      <div class="chat-conv-item-title">${conv.title}</div>
      <div class="chat-conv-item-meta">${meta}</div>
      <div class="chat-conv-item-time">${relativeTime(conv.updatedAt)}</div>
      <button class="chat-conv-item-delete" data-action="delete-conv" data-conv-id="${conv.id}" title="Delete">&times;</button>
    </div>`;
  }).join('');
}

// ── Rendering: main area ──

function renderChatMain() {
  const main = document.getElementById('chat-main');
  if (!main) return;

  const conv = getActiveConversation();
  if (!conv) {
    renderCreatePanel(main);
  } else {
    renderActiveChat(main, conv);
  }
}

// ── Rendering: creation panel ──

function renderCreatePanel(container) {
  const profileOptions = _profiles.length > 0
    ? _profiles.map((p) => h`<option value="${p.id}">${esc(getProfileLabel(p))}</option>`).join('')
    : h`<option value="" selected>Default CLI</option>`;

  const projects = Object.values(_projectsById).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const projectOptions = [
    h`<option value="" selected>Global</option>`,
    ...projects.map((p) => {
      const remoteSuffix = p.is_remote ? ` · ${p.remote_instance_name || 'remote'}` : '';
      return h`<option value="${p.id}">${esc(p.name)}${remoteSuffix}</option>`;
    }),
  ].join('');

  container.innerHTML = h`<div class="chat-create">
    <div class="chat-create-inner">
      <div class="chat-create-title">Start a New Chat</div>
      <div class="chat-create-section">
        <div class="chat-create-section-label">Agent Tool</div>
        <select class="chat-create-select" name="create-profile">${html(profileOptions)}</select>
      </div>
      <div class="chat-create-section">
        <div class="chat-create-section-label">Project Scope</div>
        <select class="chat-create-select" name="create-project">${html(projectOptions)}</select>
      </div>
      <button class="btn btn-primary chat-create-start" data-action="start-chat">Start Chat</button>
    </div>
  </div>`;
}

// ── Rendering: active conversation ──

function renderActiveChat(container, conv) {
  container.innerHTML = h`<div class="chat-context-header">
    <span class="chat-context-header-name">${esc(conv.profileName)}</span>
    <span class="chat-context-header-dot"></span>
    <span>${esc(conv.projectName)}</span>
  </div>
  <div class="dashboard-chat-transcript" id="dashboard-chat-transcript" style="flex:1;overflow-y:auto"></div>
  <div class="dashboard-chat-composer">
    <textarea id="dashboard-chat-input" rows="4" placeholder="Ask about progress, issues, or delegate work..." data-action="dashboard-chat-input"></textarea>
    <div class="dashboard-chat-actions">
      <div class="dashboard-chat-note">Long-running work will be delegated as an issue instead of being done inline.</div>
      <button class="btn btn-primary" id="dashboard-chat-send" data-action="send-dashboard-chat">Send</button>
    </div>
  </div>`;

  renderTranscript(conv);
  const sendButton = document.getElementById('dashboard-chat-send');
  if (sendButton) sendButton.disabled = _pending;
  const input = document.getElementById('dashboard-chat-input');
  if (input && !_pending) input.focus();
}

// ── Rendering: transcript ──

function formatChatMessage(content) {
  return esc(content || '').replace(/\n/g, '<br>');
}

function renderTranscript(conv) {
  const transcript = document.getElementById('dashboard-chat-transcript');
  if (!transcript) return;
  transcript.innerHTML = renderTranscriptHtml(conv);
  transcript.scrollTop = transcript.scrollHeight;
}

function renderTranscriptHtml(conv) {
  const messages = conv.messages || [];
  if (!messages.length && !_pending) {
    return renderEmptyState(conv);
  }

  const rows = messages.map((msg) => {
    const role = msg.role === 'user' ? 'user' : 'assistant';
    const label = role === 'user' ? 'You' : 'HAICO';
    return h`<div class="dashboard-chat-row dashboard-chat-row-${role}">
      <div class="dashboard-chat-avatar">${label.slice(0, 1)}</div>
      <div class="dashboard-chat-bubble-wrap">
        <div class="dashboard-chat-label">${label}</div>
        <div class="dashboard-chat-bubble dashboard-chat-bubble-${role}">${html(formatChatMessage(msg.content))}</div>
      </div>
    </div>`;
  });

  if (_pending && conv.id === _store.activeId) {
    rows.push(h`<div class="dashboard-chat-row dashboard-chat-row-assistant">
      <div class="dashboard-chat-avatar">H</div>
      <div class="dashboard-chat-bubble-wrap">
        <div class="dashboard-chat-label">HAICO</div>
        <div class="dashboard-chat-bubble dashboard-chat-bubble-assistant dashboard-chat-bubble-thinking">
          <span class="dashboard-chat-dot"></span>
          <span class="dashboard-chat-dot"></span>
          <span class="dashboard-chat-dot"></span>
        </div>
      </div>
    </div>`);
  }

  return rows.join('');
}

function renderEmptyState(conv) {
  const scopeLabel = conv.projectName || 'all projects';
  return h`<div class="dashboard-chat-empty">
    <div class="dashboard-chat-empty-icon">&#128172;</div>
    <div class="dashboard-chat-empty-title">Ask HAICO about ${esc(scopeLabel)}</div>
    <div class="dashboard-chat-empty-copy">I can look up project progress, inspect issues, update records, and delegate longer work as a new issue.</div>
  </div>`;
}

// ── Actions ──

function handleNewChat() {
  _store.activeId = null;
  saveStore();
  renderConversationList();
  renderChatMain();
}

function handleSelectConversation(id) {
  if (_pending) return;
  setActiveConversation(id);
  renderConversationList();
  renderChatMain();
}

function handleDeleteConversation(id) {
  deleteConversation(id);
  renderConversationList();
  renderChatMain();
}

function handleCreateStart() {
  const main = document.getElementById('chat-main');
  if (!main) return;

  const profileSelect = main.querySelector('select[name="create-profile"]');
  const projectSelect = main.querySelector('select[name="create-project"]');

  const profileId = profileSelect ? profileSelect.value : '';
  const projectId = projectSelect ? projectSelect.value : '';

  // Resolve display names
  let profileName = 'Default CLI';
  if (profileId) {
    const profile = _profiles.find((p) => p.id === profileId);
    profileName = profile ? getProfileLabel(profile) : 'Agent Tool';
  }

  let projectName = 'Global';
  if (projectId) {
    const project = _projectsById[projectId];
    projectName = project ? project.name : 'Project';
  }

  createConversation(profileId, profileName, projectId, projectName);
  renderConversationList();
  renderChatMain();
}

function dashboardChatTouchedMutableData(toolCalls) {
  const mutableTools = new Set([
    'create_issue', 'update_issue', 'add_issue_comment', 'delete_issue',
    'create_project_from_request', 'update_project', 'delete_project',
    'delegate_task',
  ]);
  return Array.isArray(toolCalls) && toolCalls.some((tc) => mutableTools.has(tc.tool));
}

async function handleSend() {
  if (_pending) return;
  const conv = getActiveConversation();
  if (!conv) return;

  const input = document.getElementById('dashboard-chat-input');
  const sendButton = document.getElementById('dashboard-chat-send');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;

  // Update title from first user message
  if (conv.messages.length === 0) {
    conv.title = message.length > 40 ? message.slice(0, 37) + '...' : message;
  }

  conv.messages.push({ role: 'user', content: message, ts: Date.now() });
  conv.updatedAt = Date.now();
  _pending = true;
  input.value = '';
  if (sendButton) sendButton.disabled = true;

  trimConversationMessages(conv);
  saveStore();
  renderConversationList();
  renderTranscript(conv);

  try {
    const res = await fetch('/api/dashboard-chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        message,
        messages: conv.messages.map((m) => ({ role: m.role, content: m.content })),
        project_id: conv.projectId || null,
        command_profile_id: conv.profileId || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Chat request failed');
    }
    if (data.message) {
      conv.messages.push({ role: 'assistant', content: data.message, ts: Date.now() });
    }
    if (dashboardChatTouchedMutableData(data.tool_calls)) {
      loadProjects().catch(() => {});
    }
  } catch (error) {
    const errorText = error.message || 'Chat request failed';
    conv.messages.push({ role: 'assistant', content: errorText, ts: Date.now() });
  } finally {
    _pending = false;
    conv.updatedAt = Date.now();
    trimConversationMessages(conv);
    saveStore();
    renderConversationList();
    renderTranscript(conv);
    const sendBtn = document.getElementById('dashboard-chat-send');
    if (sendBtn) sendBtn.disabled = false;
    const chatInput = document.getElementById('dashboard-chat-input');
    if (chatInput) chatInput.focus();
  }
}

// ── Event binding ──

function bindChatPageEvents() {
  // Profile changes from other pages
  window.addEventListener('haico:command-profiles-changed', () => {
    loadProfiles().catch((e) => console.error('Failed to refresh chat profiles', e));
  });

  document.body.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === 'new-chat') { handleNewChat(); return; }
      if (action === 'start-chat') { handleCreateStart(); return; }
      if (action === 'send-dashboard-chat') { handleSend(); return; }
      if (action === 'delete-conv') {
        event.stopPropagation();
        handleDeleteConversation(actionEl.dataset.convId);
        return;
      }
    }

    // Click on a conversation list item
    const convItem = event.target.closest('.chat-conv-item');
    if (convItem && convItem.dataset.convId) {
      handleSelectConversation(convItem.dataset.convId);
    }
  });

  document.body.addEventListener('keydown', (event) => {
    if (event.target.matches('[data-action="dashboard-chat-input"]')) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        handleSend();
      }
    }
  });

  // Mobile: toggle conversation list
  document.body.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-action="toggle-conv-list"]');
    if (toggle) {
      const list = document.getElementById('chat-conv-list');
      if (list) list.classList.toggle('show');
    }
    // Close mobile list when clicking outside
    const list = document.getElementById('chat-conv-list');
    if (list && list.classList.contains('show')) {
      const main = document.getElementById('chat-main');
      if (main && main.contains(event.target)) {
        list.classList.remove('show');
      }
    }
  });
}

// ── Init ──

async function initChatPage() {
  // Load persisted state
  _store = loadStore();
  migrateOldPreferences();

  bindChatPageEvents();
  await initDashboardPage('chat');

  await Promise.all([
    loadProjects(),
    loadProfiles(),
  ]);

  // If no active conversation but conversations exist, select most recent
  if (!_store.activeId && _store.conversations.length) {
    _store.activeId = _store.conversations[0].id;
    saveStore();
  }

  renderConversationList();
  renderChatMain();
  setupDashboardWS(() => loadProjects());
}

initChatPage().catch((error) => {
  console.error('Failed to initialize chat page', error);
});
