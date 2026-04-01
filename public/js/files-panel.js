(function() {
  const MONACO_LOADER_URL = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
  const MONACO_VS_PATH = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs';

  class FilesPanel {
    constructor(options) {
      this.options = options;
      this.state = {
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
        canWrite: options.canWrite !== false,
      };

      this.handleWindowResize = this.handleWindowResize.bind(this);
      this.handleSaveShortcut = this.handleSaveShortcut.bind(this);
      window.addEventListener('resize', this.handleWindowResize);
      window.addEventListener('keydown', this.handleSaveShortcut);
    }

    get apiName() {
      return this.options.publicApiName || 'ProjectFiles';
    }

    getAgentId() {
      return this.state.agent?.id || '';
    }

    isVisible() {
      return typeof this.options.isVisible === 'function' ? !!this.options.isVisible() : true;
    }

    isNarrowViewport() {
      return window.matchMedia('(max-width: 800px)').matches;
    }

    el(name) {
      return document.getElementById(this.options[name]);
    }

    formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    detectLanguage(filePath) {
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

    setWriteEnabled(enabled) {
      this.state.canWrite = !!enabled;
      if (this.state.editor) {
        this.state.editor.updateOptions({ readOnly: !this.state.canWrite || !this.state.selectedFilePath });
      }
      this.updateSaveButton();
    }

    setAgent(agent) {
      const previousId = this.state.agent?.id || '';
      const previousWorkdir = this.state.agent?.working_directory || '';
      this.state.agent = agent || null;
      this.updateWorkingDirectoryState();
      this.setWriteEnabled(this.state.canWrite);

      if ((agent?.id || '') !== previousId || (agent?.working_directory || '') !== previousWorkdir) {
        this.resetTreeState();
      }

      if (this.isVisible()) {
        this.activate();
      }
    }

    resetTreeState() {
      this.state.expandedDirs = new Set(['']);
      this.state.treeCache = new Map();
      this.state.treeIndex = new Map();
      this.state.loadingDirs = new Set();
      this.state.selectedFilePath = '';
      this.state.originalContent = '';
      this.state.dirty = false;
      this.removePreviewIframe();
      this.updateCurrentFileLabel();
      this.updateSaveButton();
      this.setStatus(this.state.agent ? 'Select a file to preview and edit it.' : 'Select an agent to browse files.');
      this.hideBanner();
      this.renderTree();
      if (this.state.editor) {
        this.state.editor.setValue('');
        this.state.editor.updateOptions({ readOnly: true });
      }
    }

    setStatus(message) {
      const status = this.el('statusId');
      if (status) status.textContent = message;
    }

    showBanner(message, tone) {
      const banner = this.el('bannerId');
      if (!banner) return;
      banner.hidden = false;
      banner.className = `file-editor-banner${tone ? ` ${tone}` : ''}`;
      banner.textContent = message;
      if (this.state.bannerTimer) window.clearTimeout(this.state.bannerTimer);
      if (tone === 'success') {
        this.state.bannerTimer = window.setTimeout(() => this.hideBanner(), 2200);
      }
    }

    hideBanner() {
      const banner = this.el('bannerId');
      if (!banner) return;
      banner.hidden = true;
      banner.className = 'file-editor-banner';
      banner.textContent = '';
      if (this.state.bannerTimer) {
        window.clearTimeout(this.state.bannerTimer);
        this.state.bannerTimer = null;
      }
    }

    updateCurrentFileLabel() {
      const label = this.el('currentPathId');
      if (!label) return;
      label.textContent = this.state.selectedFilePath ? `${this.state.selectedFilePath}${this.state.dirty ? ' *' : ''}` : 'No file selected';
    }

    getPreviewMode(filePath) {
      const ext = (filePath.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') return 'pdf';
      if (ext === 'html' || ext === 'htm') return 'html';
      return 'text';
    }

    updateSaveButton() {
      const button = this.el('saveButtonId');
      if (!button) return;
      button.disabled = this.state.saving || !this.state.canWrite || !this.state.selectedFilePath || !this.state.agent?.working_directory || !this.state.editor || this.state.previewMode;
    }

    ensureEditorContainerReady() {
      const editorEl = this.el('editorId');
      if (!editorEl) return false;
      if (this.state.editor) {
        this.state.editor.layout();
      }
      return true;
    }

    createEditor(monaco) {
      if (this.state.editor || !this.ensureEditorContainerReady()) return this.state.editor;
      const editorEl = this.el('editorId');
      this.state.editor = monaco.editor.create(editorEl, {
        value: '',
        language: 'plaintext',
        automaticLayout: true,
        minimap: { enabled: false },
        readOnly: true,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        theme: 'vs',
      });

      this.state.editor.onDidChangeModelContent(() => {
        if (!this.state.selectedFilePath) return;
        this.state.dirty = this.state.editor.getValue() !== this.state.originalContent;
        this.updateCurrentFileLabel();
      });

      this.state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        this.saveCurrentFile();
      });

      this.updateSaveButton();
      return this.state.editor;
    }

    ensureMonaco() {
      if (window.monaco && window.monaco.editor) {
        return Promise.resolve(window.monaco);
      }
      if (this.state.monacoPromise) return this.state.monacoPromise;

      this.state.monacoPromise = new Promise((resolve, reject) => {
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
        this.createEditor(monaco);
        return monaco;
      }).catch((error) => {
        this.state.monacoPromise = null;
        throw error;
      });

      return this.state.monacoPromise;
    }

    updateWorkingDirectoryState() {
      const rootLabel = this.el('rootLabelId');
      const note = this.el('noteId');
      const hasAgent = !!this.state.agent;
      const hasWorkdir = !!this.state.agent?.working_directory;

      if (rootLabel) {
        if (!hasAgent) rootLabel.textContent = 'Select an agent';
        else rootLabel.textContent = hasWorkdir ? this.state.agent.working_directory : 'Not configured';
      }

      if (!note) return;
      note.style.display = (!hasAgent || !hasWorkdir) ? '' : 'none';
      if (!hasAgent) {
        note.textContent = 'Select an agent to browse files.';
      } else if (!hasWorkdir) {
        note.textContent = 'Working Directory is required for the selected agent.';
      } else {
        note.textContent = '';
      }
    }

    renderTree() {
      const tree = this.el('treeId');
      if (!tree) return;

      this.updateWorkingDirectoryState();

      if (!this.state.agent) {
        tree.innerHTML = '<div class="empty-state" style="padding:24px 12px">Select an agent to browse files.</div>';
        return;
      }

      if (!this.state.agent.working_directory) {
        tree.innerHTML = '<div class="empty-state" style="padding:24px 12px">Working Directory is required for the selected agent.</div>';
        return;
      }

      const rootEntries = this.state.treeCache.get('');
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
        const entries = this.state.treeCache.get(dirPath) || [];
        entries.forEach((entry) => {
          this.state.treeIndex.set(entry.path, entry);
          const isDir = entry.type === 'dir';
          const isExpanded = isDir && this.state.expandedDirs.has(entry.path);
          const isLoading = isDir && this.state.loadingDirs.has(entry.path);
          const isSelected = this.state.selectedFilePath === entry.path;
          const indent = depth * 18;
          const encodedPath = encodeURIComponent(entry.path);
          const caret = isDir ? (isExpanded ? 'v' : '>') : '-';
          const downloadBtn = isDir ? '' : `<button class="file-tree-action-btn" title="Download" onclick="event.stopPropagation();${this.apiName}.downloadFile('${encodedPath}')">&#8615;</button>`;
          const meta = isDir ? '' : `<span class="file-tree-meta">${this.formatBytes(entry.size)}</span>`;
          rows.push(`
            <div class="file-tree-item${isSelected ? ' active' : ''}${isLoading ? ' loading' : ''}" onclick="${this.apiName}.handleTreeClick('${encodedPath}')">
              <span class="file-tree-spacer" style="width:${indent}px"></span>
              <span class="file-tree-caret">${caret}</span>
              <span class="file-tree-name">${esc(entry.name)}</span>
              ${downloadBtn}
              ${meta}
            </div>
          `);

          if (isDir && isExpanded) {
            if (this.state.treeCache.has(entry.path)) {
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

    async loadDirectory(dirPath) {
      if (!this.state.agent?.working_directory || !this.getAgentId()) return;
      if (this.state.loadingDirs.has(dirPath)) return;

      this.state.loadingDirs.add(dirPath);
      this.renderTree();

      const params = new URLSearchParams();
      if (dirPath) params.set('path', dirPath);
      if (this.el('showHiddenId')?.checked) {
        params.set('showHidden', '1');
      }

      try {
        const res = await fetch(`/api/agents/${this.getAgentId()}/files?${params.toString()}`, { headers: apiHeaders() });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load directory');
        }
        const data = await res.json();
        this.state.treeCache.set(dirPath, Array.isArray(data.entries) ? data.entries : []);
        this.renderTree();
      } catch (error) {
        this.showBanner(error.message || 'Failed to load directory', 'error');
        this.renderTree();
      } finally {
        this.state.loadingDirs.delete(dirPath);
        this.renderTree();
      }
    }

    applyMobileEditorFocus(shouldFocus) {
      const shell = this.el('shellId');
      if (!shell) return;
      shell.classList.toggle('mobile-editor-focus', shouldFocus && this.isNarrowViewport());
    }

    removePreviewIframe() {
      const editorEl = this.el('editorId');
      if (!editorEl) return;
      const existing = editorEl.querySelector('.files-preview-iframe');
      if (existing) existing.remove();
      // Restore Monaco editor visibility if hidden
      if (this.state.editor) {
        this.state.editor.getDomNode().style.display = '';
      }
      this.state.previewMode = null;
    }

    showPreviewIframe(filePath, mode) {
      const editorEl = this.el('editorId');
      if (!editorEl) return;

      // Hide Monaco editor if it exists
      if (this.state.editor) {
        this.state.editor.getDomNode().style.display = 'none';
      }

      // Remove any existing iframe
      const existing = editorEl.querySelector('.files-preview-iframe');
      if (existing) existing.remove();

      const src = `/api/agents/${this.getAgentId()}/files/serve?path=${encodeURIComponent(filePath)}`;
      const iframe = document.createElement('iframe');
      iframe.className = 'files-preview-iframe';
      iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
      iframe.src = src;
      if (mode === 'html') {
        iframe.sandbox = 'allow-same-origin';
      }
      editorEl.appendChild(iframe);
      this.state.previewMode = mode;
    }

    async openFile(filePath) {
      if (!this.state.agent?.working_directory || !this.getAgentId()) return;

      this.state.selectedFilePath = filePath;
      this.state.dirty = false;
      this.state.previewMode = null;
      this.updateCurrentFileLabel();
      this.updateSaveButton();
      this.setStatus(`Loading ${filePath}...`);
      this.hideBanner();
      this.renderTree();

      const mode = this.getPreviewMode(filePath);

      if (mode === 'pdf' || mode === 'html') {
        // Preview mode: use iframe instead of Monaco
        this.removePreviewIframe();
        this.showPreviewIframe(filePath, mode);
        this.updateSaveButton();
        const label = mode === 'pdf' ? 'PDF' : 'HTML';
        this.setStatus(`Preview: ${filePath}`);
        this.showBanner(`${label} preview: ${filePath}`, '');
        this.renderTree();
        this.applyMobileEditorFocus(true);
        return;
      }

      try {
        this.removePreviewIframe();
        const monaco = await this.ensureMonaco();
        this.createEditor(monaco);

        const res = await fetch(`/api/agents/${this.getAgentId()}/files/content?path=${encodeURIComponent(filePath)}`, { headers: apiHeaders() });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load file');
        }

        const content = await res.text();
        const language = this.detectLanguage(filePath);
        const model = this.state.editor.getModel();
        window.monaco.editor.setModelLanguage(model, language);
        this.state.editor.updateOptions({ readOnly: !this.state.canWrite });
        this.state.editor.setValue(content);
        this.state.originalContent = content;
        this.state.dirty = false;
        this.updateCurrentFileLabel();
        this.updateSaveButton();
        this.setStatus(this.state.canWrite ? `Loaded ${filePath}` : `Loaded ${filePath} (read-only)`);
        this.showBanner(`Loaded ${filePath}`, '');
        this.renderTree();
        this.applyMobileEditorFocus(true);
        this.state.editor.focus();
      } catch (error) {
        this.state.originalContent = '';
        this.state.dirty = false;
        this.updateCurrentFileLabel();
        this.updateSaveButton();
        this.setStatus(error.message || 'Failed to load file');
        this.showBanner(error.message || 'Failed to load file', 'error');
      }
    }

    async activate() {
      this.updateWorkingDirectoryState();

      if (!this.state.agent) {
        this.renderTree();
        this.setStatus('Select an agent to browse files.');
        return;
      }

      if (!this.state.agent.working_directory) {
        this.renderTree();
        this.setStatus('Working Directory is required for the selected agent.');
        return;
      }

      this.setStatus('Loading file browser...');
      this.renderTree();

      try {
        await this.ensureMonaco();
      } catch (error) {
        this.setStatus('Monaco Editor failed to load');
        this.showBanner(error.message || 'Monaco Editor failed to load', 'error');
        return;
      }

      if (!this.state.treeCache.has('')) {
        await this.loadDirectory('');
      } else {
        this.renderTree();
      }

      if (!this.state.selectedFilePath) {
        this.setStatus(this.state.agent ? 'Select a file to preview and edit it.' : 'Select an agent to browse files.');
      } else if (this.state.editor) {
        this.state.editor.layout();
      }
    }

    async saveCurrentFile() {
      if (!this.state.canWrite) {
        showToast('Insufficient permission to save file', 'error');
        return;
      }
      if (!this.state.editor || !this.state.selectedFilePath || this.state.saving || !this.getAgentId()) return;
      this.state.saving = true;
      this.updateSaveButton();
      this.hideBanner();
      this.setStatus(`Saving ${this.state.selectedFilePath}...`);

      try {
        const res = await fetch(`/api/agents/${this.getAgentId()}/files/content`, {
          method: 'PUT',
          headers: apiHeaders(),
          body: JSON.stringify({
            path: this.state.selectedFilePath,
            content: this.state.editor.getValue(),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to save file');
        }

        this.state.originalContent = this.state.editor.getValue();
        this.state.dirty = false;
        this.updateCurrentFileLabel();
        this.updateSaveButton();
        this.setStatus(`Saved ${this.state.selectedFilePath}`);
        this.showBanner(`Saved ${this.state.selectedFilePath}`, 'success');
        showToast('File saved', 'success');
        const parentPath = this.state.selectedFilePath.includes('/')
          ? this.state.selectedFilePath.slice(0, this.state.selectedFilePath.lastIndexOf('/'))
          : '';
        await this.loadDirectory(parentPath);
      } catch (error) {
        this.updateSaveButton();
        this.setStatus(error.message || 'Failed to save file');
        this.showBanner(error.message || 'Failed to save file', 'error');
        showToast(error.message || 'Failed to save file', 'error');
      } finally {
        this.state.saving = false;
        this.updateSaveButton();
      }
    }

    toggleDirectory(entry) {
      if (this.state.expandedDirs.has(entry.path)) {
        this.state.expandedDirs.delete(entry.path);
        this.renderTree();
        return;
      }

      this.state.expandedDirs.add(entry.path);
      this.renderTree();
      if (!this.state.treeCache.has(entry.path)) {
        this.loadDirectory(entry.path);
      }
    }

    handleTreeClick(encodedPath) {
      const filePath = decodeURIComponent(encodedPath);
      const entry = this.state.treeIndex.get(filePath);
      if (!entry) return;
      if (entry.type === 'dir') {
        this.toggleDirectory(entry);
        return;
      }
      this.openFile(entry.path);
    }

    toggleHiddenFiles(checked) {
      const input = this.el('showHiddenId');
      if (input) input.checked = !!checked;
      this.resetTreeState();
      if (this.isVisible()) {
        this.activate();
      }
    }

    showBrowser() {
      this.applyMobileEditorFocus(false);
    }

    handleWindowResize() {
      if (this.state.editor && this.isVisible()) {
        this.state.editor.layout();
      }
      if (!this.isNarrowViewport()) {
        this.applyMobileEditorFocus(false);
      }
    }

    downloadFile(encodedPath) {
      const filePath = decodeURIComponent(encodedPath);
      if (!this.getAgentId()) return;
      const a = document.createElement('a');
      a.href = `/api/agents/${this.getAgentId()}/files/download?path=${encodeURIComponent(filePath)}`;
      a.download = filePath.split('/').pop() || filePath;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    triggerUpload() {
      if (!this.getAgentId() || !this.state.agent?.working_directory) {
        this.showBanner('Select an agent with a working directory first', 'error');
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', () => {
        if (input.files && input.files.length > 0) {
          this.uploadFiles(input.files);
        }
        document.body.removeChild(input);
      });
      document.body.appendChild(input);
      input.click();
    }

    async uploadFiles(files) {
      if (!this.getAgentId()) return;
      const currentDir = this.getCurrentBrowseDir();

      for (const file of files) {
        const formData = new FormData();
        formData.append('path', currentDir);
        formData.append('file', file);

        try {
          const res = await fetch(`/api/agents/${this.getAgentId()}/files/upload`, {
            method: 'POST',
            // No Content-Type header — let browser set multipart boundary
            body: formData,
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Upload failed');
          }
        } catch (error) {
          this.showBanner(`Failed to upload ${file.name}: ${error.message}`, 'error');
          if (typeof showToast === 'function') showToast(`Upload failed: ${file.name}`, 'error');
          return;
        }
      }

      this.showBanner(`Uploaded ${files.length} file(s)`, 'success');
      if (typeof showToast === 'function') showToast(`Uploaded ${files.length} file(s)`, 'success');
      await this.loadDirectory(currentDir);
    }

    getCurrentBrowseDir() {
      // Return the deepest expanded directory, or '' for root
      const expanded = Array.from(this.state.expandedDirs).filter(d => d !== '');
      if (expanded.length === 0) return '';
      // Return the longest path (deepest dir)
      expanded.sort((a, b) => b.length - a.length);
      return expanded[0];
    }

    handleSaveShortcut(event) {
      if (!this.isVisible()) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.saveCurrentFile();
      }
    }
  }

  window.ArgusFilesPanel = {
    create(options) {
      return new FilesPanel(options);
    },
  };
})();
