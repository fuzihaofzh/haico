(function() {
  const MONACO_LOADER_URL = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
  const MONACO_VS_PATH = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs';

  const state = {
    activePanel: 'terminal',
    agent: null,
    expandedDirs: new Set(['']),
    treeCache: new Map(),
    treeIndex: new Map(),
    loadingDirs: new Set(),
    selectedFilePath: '',
    originalContent: '',
    dirty: false,
    saving: false,
    monacoPromise: null,
    editor: null,
    bannerTimer: null,
  };

  function isFilesPanelVisible() {
    return state.activePanel === 'files';
  }

  function isNarrowViewport() {
    return window.matchMedia('(max-width: 800px)').matches;
  }

  function setWorkspaceTab(panel) {
    state.activePanel = panel;
    document.querySelectorAll('.workspace-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.panel === panel);
    });

    const terminalPanel = document.getElementById('workspace-terminal-panel');
    const filesPanel = document.getElementById('workspace-files-panel');
    if (terminalPanel) terminalPanel.hidden = panel !== 'terminal';
    if (filesPanel) filesPanel.hidden = panel !== 'files';

    if (panel === 'terminal') {
      window.setTimeout(() => {
        if (typeof fitAddon !== 'undefined' && fitAddon && typeof fitAddon.fit === 'function') {
          fitAddon.fit();
        }
      }, 0);
      return;
    }

    AgentFiles.activate();
  }

  function resetTreeState() {
    state.expandedDirs = new Set(['']);
    state.treeCache = new Map();
    state.treeIndex = new Map();
    state.loadingDirs = new Set();
    state.selectedFilePath = '';
    state.originalContent = '';
    state.dirty = false;
    updateCurrentFileLabel();
    updateSaveButton();
    setStatus('Select a file to preview and edit it.');
    hideBanner();
    renderTree();
    if (state.editor) {
      state.editor.setValue('');
      state.editor.updateOptions({ readOnly: true });
    }
  }

  function setStatus(message) {
    const status = document.getElementById('file-editor-status');
    if (status) status.textContent = message;
  }

  function showBanner(message, tone) {
    const banner = document.getElementById('file-editor-banner');
    if (!banner) return;
    banner.hidden = false;
    banner.className = `file-editor-banner${tone ? ` ${tone}` : ''}`;
    banner.textContent = message;
    if (state.bannerTimer) window.clearTimeout(state.bannerTimer);
    if (tone === 'success') {
      state.bannerTimer = window.setTimeout(() => hideBanner(), 2200);
    }
  }

  function hideBanner() {
    const banner = document.getElementById('file-editor-banner');
    if (!banner) return;
    banner.hidden = true;
    banner.className = 'file-editor-banner';
    banner.textContent = '';
    if (state.bannerTimer) {
      window.clearTimeout(state.bannerTimer);
      state.bannerTimer = null;
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function detectLanguage(filePath) {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const map = {
      c: 'c',
      cpp: 'cpp',
      css: 'css',
      go: 'go',
      h: 'c',
      html: 'html',
      java: 'java',
      js: 'javascript',
      json: 'json',
      jsx: 'javascript',
      md: 'markdown',
      mjs: 'javascript',
      py: 'python',
      rs: 'rust',
      sh: 'shell',
      sql: 'sql',
      svg: 'xml',
      ts: 'typescript',
      tsx: 'typescript',
      txt: 'plaintext',
      xml: 'xml',
      yml: 'yaml',
      yaml: 'yaml',
    };
    return map[ext] || 'plaintext';
  }

  function updateCurrentFileLabel() {
    const label = document.getElementById('file-current-path');
    if (!label) return;
    label.textContent = state.selectedFilePath ? `${state.selectedFilePath}${state.dirty ? ' *' : ''}` : 'No file selected';
  }

  function updateSaveButton() {
    const button = document.getElementById('file-save-btn');
    if (!button) return;
    button.disabled = state.saving || !state.selectedFilePath || !state.agent?.working_directory || !state.editor;
  }

  function ensureEditorContainerReady() {
    const editorEl = document.getElementById('file-editor');
    if (!editorEl) return false;
    if (state.editor) {
      state.editor.layout();
      return true;
    }
    return true;
  }

  function createEditor(monaco) {
    if (state.editor || !ensureEditorContainerReady()) return state.editor;
    const editorEl = document.getElementById('file-editor');
    state.editor = monaco.editor.create(editorEl, {
      value: '',
      language: 'plaintext',
      automaticLayout: true,
      minimap: { enabled: false },
      readOnly: true,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      theme: 'vs',
    });

    state.editor.onDidChangeModelContent(() => {
      if (!state.selectedFilePath) return;
      state.dirty = state.editor.getValue() !== state.originalContent;
      updateCurrentFileLabel();
    });

    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      AgentFiles.saveCurrentFile();
    });

    updateSaveButton();
    return state.editor;
  }

  function ensureMonaco() {
    if (window.monaco && window.monaco.editor) {
      return Promise.resolve(window.monaco);
    }
    if (state.monacoPromise) return state.monacoPromise;

    state.monacoPromise = new Promise((resolve, reject) => {
      const finishLoad = () => {
        if (!window.require) {
          reject(new Error('Monaco loader is unavailable'));
          return;
        }
        window.require.config({ paths: { vs: MONACO_VS_PATH } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
      };

      const existing = document.querySelector('script[data-monaco-loader="true"]');
      if (existing) {
        if (window.require) finishLoad();
        else existing.addEventListener('load', finishLoad, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = MONACO_LOADER_URL;
      script.async = true;
      script.dataset.monacoLoader = 'true';
      script.onload = finishLoad;
      script.onerror = () => reject(new Error('Failed to load Monaco Editor'));
      document.head.appendChild(script);
    }).then((monaco) => {
      createEditor(monaco);
      return monaco;
    }).catch((error) => {
      state.monacoPromise = null;
      throw error;
    });

    return state.monacoPromise;
  }

  function updateWorkingDirectoryState() {
    const rootLabel = document.getElementById('file-browser-root-label');
    const note = document.getElementById('files-workdir-note');
    const hasWorkdir = !!state.agent?.working_directory;

    if (rootLabel) {
      rootLabel.textContent = hasWorkdir ? state.agent.working_directory : 'Not configured';
    }

    if (!note) return;
    note.style.display = hasWorkdir ? 'none' : '';
    note.textContent = hasWorkdir
      ? ''
      : 'Please configure Working Directory above first to browse and edit files.';
  }

  function renderTree() {
    const tree = document.getElementById('file-tree');
    if (!tree) return;

    updateWorkingDirectoryState();

    if (!state.agent?.working_directory) {
      tree.innerHTML = '<div class="empty-state" style="padding:24px 12px">Working Directory is required for the Files panel.</div>';
      return;
    }

    const rootEntries = state.treeCache.get('');
    if (!rootEntries) {
      tree.innerHTML = '<div class="empty-state" style="padding:24px 12px">Open the Files tab to load the directory tree.</div>';
      return;
    }

    if (rootEntries.length === 0) {
      tree.innerHTML = '<div class="empty-state" style="padding:24px 12px">This directory has no visible files.</div>';
      return;
    }

    const rows = [];
    const pushEntries = (dirPath, depth) => {
      const entries = state.treeCache.get(dirPath) || [];
      entries.forEach((entry) => {
        state.treeIndex.set(entry.path, entry);
        const isDir = entry.type === 'dir';
        const isExpanded = isDir && state.expandedDirs.has(entry.path);
        const isLoading = isDir && state.loadingDirs.has(entry.path);
        const isSelected = state.selectedFilePath === entry.path;
        const indent = depth * 18;
        const encodedPath = encodeURIComponent(entry.path);
        const caret = isDir ? (isExpanded ? 'v' : '>') : '-';
        const meta = isDir ? '' : `<span class="file-tree-meta">${formatBytes(entry.size)}</span>`;
        rows.push(`
          <div class="file-tree-item${isSelected ? ' active' : ''}${isLoading ? ' loading' : ''}" onclick="AgentFiles.handleTreeClick('${encodedPath}')">
            <span class="file-tree-spacer" style="width:${indent}px"></span>
            <span class="file-tree-caret">${caret}</span>
            <span class="file-tree-name">${esc(entry.name)}</span>
            ${meta}
          </div>
        `);

        if (isDir && isExpanded) {
          if (state.treeCache.has(entry.path)) {
            pushEntries(entry.path, depth + 1);
          } else if (isLoading) {
            rows.push(`
              <div class="file-tree-item loading">
                <span class="file-tree-spacer" style="width:${(depth + 1) * 18}px"></span>
                <span class="file-tree-caret">.</span>
                <span class="file-tree-name">Loading...</span>
              </div>
            `);
          }
        }
      });
    };

    pushEntries('', 0);
    tree.innerHTML = rows.join('');
  }

  async function loadDirectory(dirPath) {
    if (!state.agent?.working_directory) return;
    if (state.loadingDirs.has(dirPath)) return;

    state.loadingDirs.add(dirPath);
    renderTree();

    const params = new URLSearchParams();
    if (dirPath) params.set('path', dirPath);
    if (document.getElementById('file-show-hidden')?.checked) {
      params.set('showHidden', '1');
    }

    try {
      const res = await fetch(`/api/agents/${agentId}/files?${params.toString()}`, { headers: apiHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to load directory');
      }
      const data = await res.json();
      state.treeCache.set(dirPath, Array.isArray(data.entries) ? data.entries : []);
      renderTree();
    } catch (error) {
      showBanner(error.message || 'Failed to load directory', 'error');
      renderTree();
    } finally {
      state.loadingDirs.delete(dirPath);
      renderTree();
    }
  }

  function applyMobileEditorFocus(shouldFocus) {
    const shell = document.getElementById('files-shell');
    if (!shell) return;
    shell.classList.toggle('mobile-editor-focus', shouldFocus && isNarrowViewport());
  }

  async function openFile(filePath) {
    if (!state.agent?.working_directory) return;

    state.selectedFilePath = filePath;
    state.dirty = false;
    updateCurrentFileLabel();
    updateSaveButton();
    setStatus(`Loading ${filePath}...`);
    hideBanner();
    renderTree();

    try {
      const monaco = await ensureMonaco();
      createEditor(monaco);

      const res = await fetch(`/api/agents/${agentId}/files/content?path=${encodeURIComponent(filePath)}`, { headers: apiHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to load file');
      }

      const content = await res.text();
      const language = detectLanguage(filePath);
      const model = state.editor.getModel();
      window.monaco.editor.setModelLanguage(model, language);
      state.editor.updateOptions({ readOnly: false });
      state.editor.setValue(content);
      state.originalContent = content;
      state.dirty = false;
      updateCurrentFileLabel();
      updateSaveButton();
      setStatus(`Loaded ${filePath}`);
      showBanner(`Loaded ${filePath}`, '');
      renderTree();
      applyMobileEditorFocus(true);
      state.editor.focus();
    } catch (error) {
      state.originalContent = '';
      state.dirty = false;
      updateCurrentFileLabel();
      updateSaveButton();
      setStatus(error.message || 'Failed to load file');
      showBanner(error.message || 'Failed to load file', 'error');
    }
  }

  async function activateFilesPanel() {
    updateWorkingDirectoryState();
    if (!state.agent?.working_directory) {
      renderTree();
      return;
    }

    setStatus('Loading file browser...');
    renderTree();

    try {
      await ensureMonaco();
    } catch (error) {
      setStatus('Monaco Editor failed to load');
      showBanner(error.message || 'Monaco Editor failed to load', 'error');
      return;
    }

    if (!state.treeCache.has('')) {
      await loadDirectory('');
    } else {
      renderTree();
    }

    if (!state.selectedFilePath) {
      setStatus('Select a file to preview and edit it.');
    } else if (state.editor) {
      state.editor.layout();
    }
  }

  function onAgentUpdated(agent) {
    const previousWorkdir = state.agent?.working_directory || '';
    state.agent = agent || null;
    updateWorkingDirectoryState();
    if ((agent?.working_directory || '') !== previousWorkdir) {
      resetTreeState();
      if (isFilesPanelVisible()) {
        activateFilesPanel();
      }
    }
  }

  async function saveCurrentFile() {
    if (!state.editor || !state.selectedFilePath || state.saving) return;
    state.saving = true;
    updateSaveButton();
    hideBanner();
    setStatus(`Saving ${state.selectedFilePath}...`);

    try {
      const res = await fetch(`/api/agents/${agentId}/files/content`, {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify({
          path: state.selectedFilePath,
          content: state.editor.getValue(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save file');
      }

      state.originalContent = state.editor.getValue();
      state.dirty = false;
      updateCurrentFileLabel();
      updateSaveButton();
      setStatus(`Saved ${state.selectedFilePath}`);
      showBanner(`Saved ${state.selectedFilePath}`, 'success');
      showToast('File saved', 'success');
      const parentPath = state.selectedFilePath.includes('/')
        ? state.selectedFilePath.slice(0, state.selectedFilePath.lastIndexOf('/'))
        : '';
      await loadDirectory(parentPath);
    } catch (error) {
      updateSaveButton();
      setStatus(error.message || 'Failed to save file');
      showBanner(error.message || 'Failed to save file', 'error');
      showToast(error.message || 'Failed to save file', 'error');
    } finally {
      state.saving = false;
      updateSaveButton();
    }
  }

  function toggleDirectory(entry) {
    if (state.expandedDirs.has(entry.path)) {
      state.expandedDirs.delete(entry.path);
      renderTree();
      return;
    }

    state.expandedDirs.add(entry.path);
    renderTree();
    if (!state.treeCache.has(entry.path)) {
      loadDirectory(entry.path);
    }
  }

  function handleTreeClick(encodedPath) {
    const filePath = decodeURIComponent(encodedPath);
    const entry = state.treeIndex.get(filePath);
    if (!entry) return;
    if (entry.type === 'dir') {
      toggleDirectory(entry);
      return;
    }
    openFile(entry.path);
  }

  function toggleHiddenFiles(checked) {
    const input = document.getElementById('file-show-hidden');
    if (input) input.checked = !!checked;
    resetTreeState();
    if (isFilesPanelVisible()) {
      activateFilesPanel();
    }
  }

  function showBrowser() {
    applyMobileEditorFocus(false);
  }

  function handleWorkingDirectoryChange() {
    resetTreeState();
    updateWorkingDirectoryState();
    if (isFilesPanelVisible()) {
      activateFilesPanel();
    }
  }

  function handleWindowResize() {
    if (state.editor && isFilesPanelVisible()) {
      state.editor.layout();
    }
    if (!isNarrowViewport()) {
      applyMobileEditorFocus(false);
    }
  }

  function handleSaveShortcut(event) {
    if (!isFilesPanelVisible()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveCurrentFile();
    }
  }

  window.switchAgentWorkspace = setWorkspaceTab;

  window.AgentFiles = {
    activate: activateFilesPanel,
    handleTreeClick,
    handleWorkingDirectoryChange,
    saveCurrentFile,
    setAgent: onAgentUpdated,
    showBrowser,
    toggleHiddenFiles,
  };

  window.addEventListener('keydown', handleSaveShortcut);
  window.addEventListener('resize', handleWindowResize);
  if (window.currentAgentState) {
    window.AgentFiles.setAgent(window.currentAgentState);
  }
})();
