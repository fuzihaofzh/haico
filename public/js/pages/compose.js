import { initDashboardPage, loadDashboardProjects } from './dashboard-core.js';
import { showToast } from '../components/toast.js';

let _dashboardProjectsById = {};
let _globalComposeAgentsByProject = {};

function setGlobalComposeStatus(message, type) {
  const status = document.getElementById('global-compose-status');
  if (!status) return;
  status.textContent = message || '';
  status.className = 'compose-status' + (type ? ' compose-status-' + type : '');
}

async function updateGlobalComposeRecipients(selectedTo) {
  const projectSelect = document.getElementById('global-compose-project');
  const toSelect = document.getElementById('global-compose-to');
  const sendButton = document.getElementById('global-compose-send');
  if (!projectSelect || !toSelect) return;

  const selectedProjectId = projectSelect.value;
  if (!selectedProjectId) {
    toSelect.innerHTML = h`<option value="">Select a project first</option>`;
    toSelect.disabled = true;
    if (sendButton) sendButton.disabled = true;
    return false;
  }

  toSelect.innerHTML = h`<option value="">Loading recipients...</option>`;
  toSelect.disabled = true;
  if (sendButton) sendButton.disabled = true;
  setGlobalComposeStatus('', '');

  try {
    let agents = _globalComposeAgentsByProject[selectedProjectId];
    if (!agents) {
      const res = await fetch(buildProjectApiPath(selectedProjectId, '/agents'), { headers: apiHeaders() });
      if (!res.ok) throw new Error('Failed to load recipients');
      agents = await res.json();
      _globalComposeAgentsByProject[selectedProjectId] = agents;
    }

    const controllerId = agents.find(a => a.is_controller)?.id
      || _dashboardProjectsById[selectedProjectId]?.stats?.controllerAgentId
      || '';
    const selectedValue = selectedTo !== undefined ? selectedTo : controllerId;
    toSelect.innerHTML = h`<option value="">Select a recipient</option><option value="all">All (broadcast)</option><option value="user">User (me)</option>${html(
      agents.map(agent =>
        h`<option value="${agent.id}">${agent.name}${agent.is_controller ? ' [controller]' : ''}</option>`
      ).join('')
    )}`;
    toSelect.value = selectedValue || '';
    toSelect.disabled = false;
    if (sendButton) sendButton.disabled = false;
    return true;
  } catch (e) {
    toSelect.innerHTML = h`<option value="">Failed to load recipients</option>`;
    setGlobalComposeStatus(e.message || 'Failed to load recipients', 'error');
    return false;
  }
}

async function sendGlobalCompose() {
  const projectSelect = document.getElementById('global-compose-project');
  const toSelect = document.getElementById('global-compose-to');
  const subjectInput = document.getElementById('global-compose-subject');
  const bodyInput = document.getElementById('global-compose-body');
  const btn = document.getElementById('global-compose-send');
  if (!projectSelect || !toSelect || !subjectInput || !bodyInput) return;

  await withLoading(btn, async () => {
    const targetProjectId = projectSelect.value;
    const subject = subjectInput.value.trim();
    const body = bodyInput.value.trim();
    const assignedTo = toSelect.value.trim();

    if (!targetProjectId) { setGlobalComposeStatus('Project is required.', 'error'); return; }
    if (!assignedTo) { setGlobalComposeStatus('To is required.', 'error'); toSelect.focus(); return; }
    if (!subject) { setGlobalComposeStatus('Subject is required.', 'error'); subjectInput.focus(); return; }
    if (!_dashboardProjectsById[targetProjectId]?.can_manage) {
      setGlobalComposeStatus('Insufficient permission to create issues in this project.', 'error');
      return;
    }

    const res = await fetch(buildProjectApiPath(targetProjectId, '/issues'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ title: subject, body, created_by: 'user', assigned_to: assignedTo }),
    });

    if (res.ok) {
      showToast('Issue created', 'success');
      window.location.href = '/inbox';
    } else {
      const err = await res.json().catch(() => ({}));
      setGlobalComposeStatus(err.error || 'Failed to send message', 'error');
    }
  });
}

function bindComposeEvents() {
  document.body.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    if (actionEl.dataset.action === 'send-global-compose') sendGlobalCompose();
  });
  document.body.addEventListener('change', (event) => {
    if (event.target.matches('[data-action="global-compose-project"]')) updateGlobalComposeRecipients();
  });
}

async function initComposePage() {
  bindComposeEvents();
  await initDashboardPage('compose');

  // Read query params for pre-filling
  const params = new URLSearchParams(window.location.search);
  const defaultProjectId = params.get('projectId') || '';
  const defaultTo = params.get('to') || '';
  const defaultSubject = params.get('subject') || '';
  const defaultBody = params.get('body') || '';

  const subjectInput = document.getElementById('global-compose-subject');
  const bodyInput = document.getElementById('global-compose-body');
  if (subjectInput) subjectInput.value = defaultSubject;
  if (bodyInput) bodyInput.value = defaultBody;

  // Load projects
  const projectSelect = document.getElementById('global-compose-project');
  const toSelect = document.getElementById('global-compose-to');
  const sendButton = document.getElementById('global-compose-send');

  try {
    const projects = await loadDashboardProjects();
    _dashboardProjectsById = Object.fromEntries(projects.map(p => [p.id, p]));
    const writable = projects.filter(p => p && p.can_manage);

    if (!writable.length) {
      if (projectSelect) projectSelect.innerHTML = h`<option value="">No writable projects</option>`;
      setGlobalComposeStatus('You need editor or owner access to a project before composing.', 'error');
      return;
    }

    const selectedProject = defaultProjectId
      ? writable.find(p => p.id === defaultProjectId) || null
      : null;

    if (projectSelect) {
      projectSelect.innerHTML = h`<option value="">— Select a project —</option>${html(writable.map(p =>
        h`<option value="${p.id}">${p.name}</option>`
      ).join(''))}`;
      projectSelect.value = selectedProject?.id || '';
      projectSelect.disabled = false;
    }

    const recipientsLoaded = await updateGlobalComposeRecipients(defaultTo);
    if (sendButton) sendButton.disabled = !recipientsLoaded;
    if (selectedProject && subjectInput) subjectInput.focus();
    else if (projectSelect) projectSelect.focus();
  } catch (e) {
    if (projectSelect) projectSelect.innerHTML = h`<option value="">Failed to load projects</option>`;
    setGlobalComposeStatus(e.message || 'Failed to load compose data', 'error');
  }
}

initComposePage().catch(e => console.error('Failed to initialize compose page', e));
