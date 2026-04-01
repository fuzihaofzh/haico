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
      if (ext === 'docx') return 'docx';
      if (ext === 'xlsx') return 'xlsx';
      if (ext === 'pptx') return 'pptx';
      if (ext === 'sqlite' || ext === 'db' || ext === 'sqlite3' || ext === 'db3') return 'sqlite';
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
      // Also remove rich previews (docx/xlsx/pptx/sqlite)
      const richPreview = editorEl.querySelector('.files-rich-preview');
      if (richPreview) richPreview.remove();
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
        iframe.sandbox = 'allow-scripts allow-forms allow-popups';
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

      if (mode === 'docx' || mode === 'xlsx' || mode === 'pptx') {
        this.removePreviewIframe();
        this.showOfficePreview(filePath, mode);
        return;
      }

      if (mode === 'sqlite') {
        this.removePreviewIframe();
        this.showSqlitePreview(filePath);
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

    showRichPreview(filePath, label, contentHtml) {
      const editorEl = this.el('editorId');
      if (!editorEl) return;
      if (this.state.editor) this.state.editor.getDomNode().style.display = 'none';
      const existing = editorEl.querySelector('.files-rich-preview');
      if (existing) existing.remove();
      const container = document.createElement('div');
      container.className = 'files-rich-preview';
      container.style.cssText = 'width:100%;height:100%;overflow:auto;background:#fff;color:#222;padding:16px;box-sizing:border-box;font-size:14px;';
      container.innerHTML = contentHtml;
      editorEl.appendChild(container);
      this.state.previewMode = label;
      this.updateSaveButton();
      this.setStatus(`Preview: ${filePath}`);
      this.showBanner(`${label} preview: ${filePath}`, '');
      this.renderTree();
      this.applyMobileEditorFocus(true);
    }

    removeRichPreview() {
      const editorEl = this.el('editorId');
      if (!editorEl) return;
      const existing = editorEl.querySelector('.files-rich-preview');
      if (existing) existing.remove();
      if (this.state.editor) this.state.editor.getDomNode().style.display = '';
    }

    async loadOfficeLib(mode) {
      if (mode === 'docx') {
        if (!window.mammoth) {
          await this._loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js');
          // Wait for the global to become available
          await this._waitForGlobal('mammoth');
        }
      } else if (mode === 'xlsx') {
        if (!window.XLSX) {
          await this._loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
          await this._waitForGlobal('XLSX');
        }
      }
    }

    _waitForGlobal(name, timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (window[name]) return resolve();
        const start = Date.now();
        const check = () => {
          if (window[name]) return resolve();
          if (Date.now() - start > timeout) return reject(new Error(`${name} failed to load`));
          setTimeout(check, 50);
        };
        check();
      });
    }

    _loadScript(url) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load ' + url));
        document.head.appendChild(s);
      });
    }

    async showOfficePreview(filePath, mode) {
      this.setStatus(`Loading ${mode.toUpperCase()} preview...`);
      try {
        await this.loadOfficeLib(mode);
        const downloadUrl = `/api/agents/${this.getAgentId()}/files/download?path=${encodeURIComponent(filePath)}`;
        const res = await fetch(downloadUrl, { headers: typeof apiHeaders === 'function' ? apiHeaders() : {} });
        if (!res.ok) throw new Error('Failed to download file');
        const arrayBuffer = await res.arrayBuffer();

        let html = '';
        if (mode === 'docx') {
          if (!window.mammoth) throw new Error('mammoth library not available');
          const result = await window.mammoth.convertToHtml({ arrayBuffer });
          html = '<div style="max-width:800px;margin:0 auto;line-height:1.6">' + result.value + '</div>';
          if (result.messages && result.messages.length > 0) {
            html += '<div style="margin-top:16px;padding:8px;background:#fff3cd;border-radius:4px;font-size:12px;color:#856404">' +
              result.messages.map(m => m.message).join('<br>') + '</div>';
          }
        } else if (mode === 'xlsx') {
          const workbook = XLSX.read(arrayBuffer, { type: 'array' });
          html = '<div>';
          // Sheet tabs
          if (workbook.SheetNames.length > 1) {
            html += '<div style="margin-bottom:12px;display:flex;gap:4px;flex-wrap:wrap">';
            workbook.SheetNames.forEach((name, i) => {
              html += '<button onclick="this.closest(\'.files-rich-preview\').querySelectorAll(\'.xlsx-sheet\').forEach((s,j)=>{s.style.display=j===' + i + '?\'block\':\'none\'});this.parentElement.querySelectorAll(\'button\').forEach((b,j)=>{b.style.background=j===' + i + '?\'#0366d6\':\'#e1e4e8\';b.style.color=j===' + i + '?\'#fff\':\'#222\'})" style="padding:4px 12px;border:none;border-radius:4px;cursor:pointer;font-size:12px;' + (i === 0 ? 'background:#0366d6;color:#fff' : 'background:#e1e4e8;color:#222') + '">' + name + '</button>';
            });
            html += '</div>';
          }
          workbook.SheetNames.forEach((name, i) => {
            const sheet = workbook.Sheets[name];
            const sheetHtml = XLSX.utils.sheet_to_html(sheet, { editable: false });
            html += '<div class="xlsx-sheet" style="display:' + (i === 0 ? 'block' : 'none') + ';overflow-x:auto">' + sheetHtml + '</div>';
          });
          html += '</div>';
          // Style the generated tables
          html += '<style>.files-rich-preview table{border-collapse:collapse;font-size:13px;min-width:100%}.files-rich-preview td,.files-rich-preview th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;white-space:nowrap}.files-rich-preview tr:first-child td,.files-rich-preview th{background:#f6f8fa;font-weight:600}</style>';
        } else if (mode === 'pptx') {
          // Basic PPTX info — extract slide count from [Content_Types].xml inside the zip
          html = await this._renderPptxPreview(arrayBuffer);
        }

        this.removeRichPreview();
        this.removePreviewIframe();
        this.showRichPreview(filePath, mode.toUpperCase(), html);
      } catch (error) {
        this.setStatus(error.message || 'Preview failed');
        this.showBanner(error.message || 'Preview failed', 'error');
      }
    }

    async _renderPptxPreview(arrayBuffer) {
      // Use JSZip to extract slide info from PPTX
      if (!window.JSZip) {
        await this._loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
      }
      const zip = await JSZip.loadAsync(arrayBuffer);
      const slideFiles = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort();
      const slideCount = slideFiles.length;

      let html = '<div style="max-width:800px;margin:0 auto">';
      html += '<div style="margin-bottom:16px;font-size:16px;font-weight:600">PowerPoint Presentation — ' + slideCount + ' slide' + (slideCount !== 1 ? 's' : '') + '</div>';

      // Extract text content from each slide
      for (let i = 0; i < slideFiles.length; i++) {
        const xmlContent = await zip.file(slideFiles[i]).async('string');
        // Extract text between <a:t> tags
        const textMatches = xmlContent.match(/<a:t>([^<]*)<\/a:t>/g) || [];
        const texts = textMatches.map(m => m.replace(/<\/?a:t>/g, '')).filter(t => t.trim());

        html += '<div style="border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:12px;background:#f6f8fa">';
        html += '<div style="font-size:12px;color:#656d76;margin-bottom:8px;font-weight:600">Slide ' + (i + 1) + '</div>';
        if (texts.length > 0) {
          html += '<div style="line-height:1.5">' + texts.map(t => '<div>' + t.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>').join('') + '</div>';
        } else {
          html += '<div style="color:#8b949e;font-style:italic">No text content</div>';
        }
        html += '</div>';
      }
      html += '</div>';
      return html;
    }

    async showSqlitePreview(filePath) {
      this.setStatus('Loading SQLite preview...');
      try {
        const baseUrl = `/api/agents/${this.getAgentId()}/files/sqlite?path=${encodeURIComponent(filePath)}`;
        const res = await fetch(baseUrl, { headers: typeof apiHeaders === 'function' ? apiHeaders() : {} });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load SQLite file');
        }
        const data = await res.json();
        const tables = data.tables || [];

        let html = '<div style="max-width:100%;margin:0 auto" id="sqlite-preview-root">';
        html += '<div style="margin-bottom:16px;font-size:16px;font-weight:600">SQLite Database — ' + tables.length + ' table' + (tables.length !== 1 ? 's' : '') + '</div>';
        html += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:16px">';
        tables.forEach((t, i) => {
          html += '<button data-table="' + t.name + '" onclick="window[\'' + this.apiName + '\']._sqliteLoadTable(this)" style="padding:4px 12px;border:none;border-radius:4px;cursor:pointer;font-size:12px;' + (i === 0 ? 'background:#0366d6;color:#fff' : 'background:#e1e4e8;color:#222') + '">' + t.name + ' (' + t.rowCount + ')</button>';
        });
        html += '</div>';
        html += '<div id="sqlite-table-content" style="overflow-x:auto"></div>';
        html += '</div>';

        this.removeRichPreview();
        this.removePreviewIframe();
        this.showRichPreview(filePath, 'SQLite', html);

        // Store state for table loading
        this._sqliteFilePath = filePath;
        // Expose for onclick
        window[this.apiName]._sqliteLoadTable = (btn) => this._sqliteLoadTable(btn);

        // Load first table automatically
        if (tables.length > 0) {
          const firstBtn = this.el('editorId')?.querySelector('button[data-table]');
          if (firstBtn) this._sqliteLoadTable(firstBtn);
        }
      } catch (error) {
        this.setStatus(error.message || 'SQLite preview failed');
        this.showBanner(error.message || 'SQLite preview failed', 'error');
      }
    }

    async _sqliteLoadTable(btn) {
      const tableName = btn.dataset.table;
      if (!tableName) return;

      // Update tab button styles
      const container = btn.parentElement;
      if (container) {
        container.querySelectorAll('button').forEach(b => {
          b.style.background = b === btn ? '#0366d6' : '#e1e4e8';
          b.style.color = b === btn ? '#fff' : '#222';
        });
      }

      const contentEl = document.getElementById('sqlite-table-content');
      if (!contentEl) return;
      contentEl.innerHTML = '<div style="color:#656d76;padding:8px">Loading...</div>';

      try {
        const url = `/api/agents/${this.getAgentId()}/files/sqlite?path=${encodeURIComponent(this._sqliteFilePath)}&table=${encodeURIComponent(tableName)}&limit=200`;
        const res = await fetch(url, { headers: typeof apiHeaders === 'function' ? apiHeaders() : {} });
        if (!res.ok) throw new Error('Failed to load table');
        const data = await res.json();

        let html = '<div style="font-size:12px;color:#656d76;margin-bottom:8px">' + data.totalRows + ' rows total (showing ' + data.rows.length + ')</div>';
        html += '<table style="border-collapse:collapse;font-size:13px;min-width:100%"><thead><tr>';
        data.columns.forEach(col => {
          html += '<th style="border:1px solid #d0d7de;padding:4px 8px;background:#f6f8fa;font-weight:600;white-space:nowrap">' + col.name + '<span style="color:#8b949e;font-weight:400;margin-left:4px;font-size:11px">' + col.type + '</span></th>';
        });
        html += '</tr></thead><tbody>';
        data.rows.forEach(row => {
          html += '<tr>';
          data.columns.forEach(col => {
            const val = row[col.name];
            const display = val === null ? '<span style="color:#8b949e">NULL</span>' : String(val).length > 200 ? String(val).slice(0, 200) + '…' : String(val).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += '<td style="border:1px solid #d0d7de;padding:4px 8px;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis">' + display + '</td>';
          });
          html += '</tr>';
        });
        html += '</tbody></table>';
        contentEl.innerHTML = html;
      } catch (error) {
        contentEl.innerHTML = '<div style="color:#f85149;padding:8px">' + (error.message || 'Failed to load table') + '</div>';
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

  window.AgentopiaFilesPanel = {
    create(options) {
      return new FilesPanel(options);
    },
  };
})();
