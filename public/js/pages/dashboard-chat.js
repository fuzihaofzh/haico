import { initDashboardPage, loadDashboardProjects, setupDashboardWS } from './dashboard-core.js';
import { showToast } from '../components/toast.js';

let _dashboardProjectsById = {};
let _dashboardChatMessages = [];
let _dashboardChatPending = false;
let _dashboardChatStatus = { message: '', type: '' };
let _dashboardChatProfileId = '';
let _dashboardChatProjectId = '';
const DASHBOARD_CHAT_PROFILE_STORAGE_KEY = 'haico.dashboardChat.profileId';
const DASHBOARD_CHAT_PROJECT_STORAGE_KEY = 'haico.dashboardChat.projectId';

function saveDashboardChatPreferences() {
  try {
    localStorage.setItem(DASHBOARD_CHAT_PROFILE_STORAGE_KEY, _dashboardChatProfileId || '');
    localStorage.setItem(DASHBOARD_CHAT_PROJECT_STORAGE_KEY, _dashboardChatProjectId || '');
  } catch (_) {}
}

function loadDashboardChatPreferences() {
  try {
    _dashboardChatProfileId = localStorage.getItem(DASHBOARD_CHAT_PROFILE_STORAGE_KEY) || '';
    _dashboardChatProjectId = localStorage.getItem(DASHBOARD_CHAT_PROJECT_STORAGE_KEY) || '';
  } catch (_) {}
}

function setDashboardChatStatus(message, type) {
  _dashboardChatStatus = { message: message || '', type: type || '' };
  const status = document.getElementById('dashboard-chat-status');
  if (!status) return;
  status.textContent = _dashboardChatStatus.message;
  status.className = 'compose-status dashboard-chat-status' + (_dashboardChatStatus.type ? ' compose-status-' + _dashboardChatStatus.type : '');
}

function formatDashboardChatMessage(content) {
  return esc(content || '').replace(/\n/g, '<br>');
}

function renderDashboardChatEmptyState() {
  const projectCount = Object.keys(_dashboardProjectsById || {}).length;
  return h`<div class="dashboard-chat-empty">
    <div class="dashboard-chat-empty-icon">&#128172;</div>
    <div class="dashboard-chat-empty-title">Ask HAICO</div>
    <div class="dashboard-chat-empty-copy">I can look up project progress, inspect issues, update records, and delegate longer work as a new issue.</div>
    <div class="dashboard-chat-empty-meta">${projectCount} project${projectCount === 1 ? '' : 's'} currently in scope</div>
  </div>`;
}

function renderDashboardChatTranscriptHtml() {
  const messages = _dashboardChatMessages || [];
  if (!messages.length && !_dashboardChatPending) {
    return renderDashboardChatEmptyState();
  }

  const rows = messages.map((message) => {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const label = role === 'user' ? 'You' : 'HAICO';
    return h`<div class="dashboard-chat-row dashboard-chat-row-${role}">
      <div class="dashboard-chat-avatar">${label.slice(0, 1)}</div>
      <div class="dashboard-chat-bubble-wrap">
        <div class="dashboard-chat-label">${label}</div>
        <div class="dashboard-chat-bubble dashboard-chat-bubble-${role}">${html(formatDashboardChatMessage(message.content))}</div>
      </div>
    </div>`;
  });

  if (_dashboardChatPending) {
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

function renderDashboardChatTranscript() {
  const transcript = document.getElementById('dashboard-chat-transcript');
  if (!transcript) return;
  transcript.innerHTML = renderDashboardChatTranscriptHtml();
  transcript.scrollTop = transcript.scrollHeight;
}

function populateDashboardChatProjectOptions() {
  const select = document.getElementById('dashboard-chat-project');
  if (!select) return;
  const projects = Object.values(_dashboardProjectsById || {}).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (_dashboardChatProjectId && !_dashboardProjectsById[_dashboardChatProjectId]) {
    _dashboardChatProjectId = '';
    saveDashboardChatPreferences();
  }
  select.innerHTML = h`<option value="">All projects</option>${html(projects.map((project) => {
    const remoteSuffix = project.is_remote ? ` · ${project.remote_instance_name || 'remote'}` : '';
    return h`<option value="${project.id}">${project.name}${remoteSuffix}</option>`;
  }).join(''))}`;
  select.value = _dashboardChatProjectId || '';
}

async function populateDashboardChatProfileOptions() {
  const select = document.getElementById('dashboard-chat-profile');
  if (!select) return;
  const manager = window.HAICOCommandProfiles || null;
  if (manager && typeof manager.ensureLoaded === 'function') {
    await manager.ensureLoaded();
  }
  const profiles = manager && typeof manager.getProfiles === 'function'
    ? manager.getProfiles()
    : [];

  if (profiles.length === 0) {
    _dashboardChatProfileId = '';
    select.innerHTML = h`<option value="">Default CLI</option>`;
    select.value = '';
    saveDashboardChatPreferences();
    return;
  }

  if (!_dashboardChatProfileId || !profiles.find((profile) => profile.id === _dashboardChatProfileId)) {
    _dashboardChatProfileId = profiles[0].id;
    saveDashboardChatPreferences();
  }

  select.innerHTML = profiles.map((profile) => {
    const label = manager?.formatLabel ? manager.formatLabel(profile) : `${profile.name} (${profile.type})`;
    return h`<option value="${profile.id}">${label}</option>`;
  }).join('');
  select.value = _dashboardChatProfileId;
}

async function loadProjects() {
  const projects = await loadDashboardProjects();
  _dashboardProjectsById = Object.fromEntries(projects.map((project) => [project.id, project]));
  populateDashboardChatProjectOptions();
  renderDashboardChatTranscript();
  return projects;
}

function handleDashboardChatProfileChange(value) {
  _dashboardChatProfileId = value || '';
  saveDashboardChatPreferences();
  setDashboardChatStatus('', '');
}

function handleDashboardChatProjectChange(value) {
  _dashboardChatProjectId = value || '';
  saveDashboardChatPreferences();
  setDashboardChatStatus('', '');
}

function handleDashboardChatInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendDashboardChat();
  }
}

function dashboardChatTouchedMutableData(toolCalls) {
  const mutableTools = new Set([
    'create_issue',
    'update_issue',
    'add_issue_comment',
    'delete_issue',
    'create_project_from_request',
    'update_project',
    'delete_project',
    'delegate_task',
  ]);
  return Array.isArray(toolCalls) && toolCalls.some((toolCall) => mutableTools.has(toolCall.tool));
}

async function sendDashboardChat() {
  if (_dashboardChatPending) return;
  const input = document.getElementById('dashboard-chat-input');
  const sendButton = document.getElementById('dashboard-chat-send');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;

  _dashboardChatMessages.push({ role: 'user', content: message });
  _dashboardChatPending = true;
  setDashboardChatStatus('', '');
  input.value = '';
  if (sendButton) sendButton.disabled = true;
  renderDashboardChatTranscript();

  try {
    const res = await fetch('/api/dashboard-chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        message,
        messages: _dashboardChatMessages,
        project_id: _dashboardChatProjectId || null,
        command_profile_id: _dashboardChatProfileId || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Chat request failed');
    }
    if (data.message) {
      _dashboardChatMessages.push({ role: 'assistant', content: data.message });
    }
    if (dashboardChatTouchedMutableData(data.tool_calls)) {
      loadProjects().catch(() => {});
    }
    setDashboardChatStatus('', '');
  } catch (error) {
    const messageText = error.message || 'Chat request failed';
    _dashboardChatMessages.push({ role: 'assistant', content: messageText });
    setDashboardChatStatus(messageText, 'error');
  } finally {
    _dashboardChatPending = false;
    if (sendButton) sendButton.disabled = false;
    renderDashboardChatTranscript();
    input.focus();
  }
}

function bindChatPageEvents() {
  window.addEventListener('haico:command-profiles-changed', () => {
    populateDashboardChatProfileOptions().catch((error) => console.error('Failed to refresh dashboard chat profiles', error));
  });
  document.body.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('[data-action="dashboard-chat-profile"]')) handleDashboardChatProfileChange(target.value);
    if (target.matches('[data-action="dashboard-chat-project"]')) handleDashboardChatProjectChange(target.value);
  });
  document.body.addEventListener('keydown', (event) => {
    if (event.target.matches('[data-action="dashboard-chat-input"]')) handleDashboardChatInputKeydown(event);
  });
  document.body.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    if (actionEl.dataset.action === 'send-dashboard-chat') sendDashboardChat();
  });
}

async function initChatPage() {
  loadDashboardChatPreferences();
  bindChatPageEvents();
  await initDashboardPage('chat');
  await Promise.all([
    loadProjects(),
    populateDashboardChatProfileOptions(),
  ]);
  renderDashboardChatTranscript();
  setDashboardChatStatus(_dashboardChatStatus.message, _dashboardChatStatus.type);
  const input = document.getElementById('dashboard-chat-input');
  const sendButton = document.getElementById('dashboard-chat-send');
  if (sendButton) sendButton.disabled = _dashboardChatPending;
  if (input && !_dashboardChatPending) input.focus();
  setupDashboardWS(() => loadProjects());
}

initChatPage().catch((error) => {
  console.error('Failed to initialize chat page', error);
});
