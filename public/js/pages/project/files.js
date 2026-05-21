let projectFilesAgentId = '';
let projectFilesPanel = null;

function getControllerAgent() {
  return agentsData.find((agent) => agent.is_controller);
}

function ensureProjectFilesPanel() {
  if (projectFilesPanel || !window.HAICOFilesPanel) return;
  projectFilesPanel = window.HAICOFilesPanel.create({
    publicApiName: 'ProjectFiles',
    shellId: 'project-files-shell',
    treeId: 'project-file-tree',
    rootLabelId: 'project-files-root-label',
    noteId: 'project-files-note',
    currentPathId: 'project-file-current-path',
    saveButtonId: 'project-file-save-btn',
    bannerId: 'project-file-editor-banner',
    statusId: 'project-file-editor-status',
    editorId: 'project-file-editor',
    showHiddenId: 'project-file-show-hidden',
    canWrite: canManageProject(),
    isVisible: () => true,
  });
  window.ProjectFiles = projectFilesPanel;
}

function getProjectFilesAgent() {
  return agentsData.find((agent) => agent.id === projectFilesAgentId) || null;
}

function normalizeProjectFilesAgentId(agentId) {
  if (!agentId) return '';
  if (!agentsData.length || agentsData.some((agent) => agent.id === agentId)) return agentId;
  return getControllerAgent()?.id || '';
}

function syncProjectFilesAgents() {
  ensureProjectFilesPanel();
  const select = document.getElementById('project-files-agent');
  if (!select) return;

  if (!agentsData.length) {
    select.innerHTML = '<option value="">No agents available</option>';
    select.disabled = true;
    projectFilesAgentId = '';
    if (projectFilesPanel) projectFilesPanel.setAgent(null);
    return;
  }

  const previousAgentId = projectFilesAgentId;
  const options = agentsData.map((agent) => {
    const suffix = agent.is_controller ? ' [controller]' : '';
    return `<option value="${agent.id}">${esc(agent.name)}${suffix}</option>`;
  }).join('');

  select.innerHTML = `<option value="">Select an agent</option>${options}`;
  select.disabled = false;

  let nextAgentId = normalizeProjectFilesAgentId(previousAgentId);
  if (!nextAgentId) {
    const preferredAgent = getControllerAgent()
      || agentsData.find((agent) => !!agent.working_directory)
      || agentsData[0];
    nextAgentId = preferredAgent?.id || '';
  }

  projectFilesAgentId = nextAgentId;
  select.value = nextAgentId || '';
  if (projectFilesPanel) {
    projectFilesPanel.setWriteEnabled(canManageProject());
    projectFilesPanel.setAgent(getProjectFilesAgent());
  }
}

function handleProjectFilesAgentChange(agentId) {
  projectFilesAgentId = normalizeProjectFilesAgentId(agentId);
  if (projectFilesPanel) {
    projectFilesPanel.setAgent(getProjectFilesAgent());
    projectFilesPanel.activate();
  }
}

function loadProjectFilesTab() {
  ensureProjectFilesPanel();
  syncProjectFilesAgents();
  if (projectFilesPanel) {
    projectFilesPanel.setWriteEnabled(canManageProject());
    projectFilesPanel.activate();
  }
}

window.handleProjectFilesAgentChange = handleProjectFilesAgentChange;

(async function initFilesPage() {
  await loadProjectShell();
  agentsData = await getProjectAgents().catch(() => []);
  loadProjectFilesTab();

  const params = new URLSearchParams(window.location.search);
  const agent = params.get('agent');
  if (agent) {
    handleProjectFilesAgentChange(agent);
    const select = document.getElementById('project-files-agent');
    if (select) select.value = projectFilesAgentId || agent;
  }

  const file = params.get('file');
  if (file && window.ProjectFiles && typeof window.ProjectFiles.openFile === 'function') {
    window.ProjectFiles.openFile(file);
  }

  const events = connectProjectEvents(projectId);
  events.on('agent_status', async () => {
    agentsData = await getProjectAgents().catch(() => agentsData);
    syncProjectFilesAgents();
  });
})();
