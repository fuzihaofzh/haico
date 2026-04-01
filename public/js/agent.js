(function() {
  function setWorkspaceTab(panel) {
    const targetPanel = panel === 'terminal' ? 'terminal' : 'terminal';
    document.querySelectorAll('.workspace-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.panel === targetPanel);
    });

    const terminalPanel = document.getElementById('workspace-terminal-panel');
    if (terminalPanel) terminalPanel.hidden = false;

    window.setTimeout(() => {
      if (typeof fitAddon !== 'undefined' && fitAddon && typeof fitAddon.fit === 'function') {
        fitAddon.fit();
      }
    }, 0);
  }

  window.switchAgentWorkspace = setWorkspaceTab;
})();
