// ─── Shared Issue Renderer ───
// Used by both issue.js (full page) and dashboard-core.js (floating panel)

var IssueRenderer = (function() {
  var EMOJIS = ['👍','👎','❤️','🎉','😕','🚀'];
  var TEMPLATE_URL = '/public/templates/issue-renderer.html?v=1';
  var _templatesPromise = null;

  // Current rendering context
  var _ctx = {
    issue: null,
    agents: [],
    container: null,
    reload: null,
    refreshComments: null,
    onAfterAction: null,
    projectColor: null,
    readOnly: false,
  };

  function nameOf(id) {
    if (id === 'user') return 'User';
    if (id === 'all') return 'All';
    var a = _ctx.agents.find(function(x) { return x.id === id; });
    if (a) return a.name;
    return (id || '').slice(0, 8);
  }

  function findAgentById(id) {
    if (!id) return null;
    return _ctx.agents.find(function(x) { return x.id === id; }) || null;
  }

  function getControllerAgent() {
    return _ctx.agents.find(function(x) { return !!x.is_controller; }) || null;
  }

  function getFileLinkAgentId(authorId) {
    return findAgentById(authorId) ? authorId : '';
  }

  function resolveFileOpenAgentId(agentId) {
    var fileAgentId = getFileLinkAgentId(agentId);
    if (fileAgentId) return fileAgentId;
    var controller = getControllerAgent();
    return controller ? controller.id : '';
  }

  function isRemoteIssue() {
    return !!(_ctx.issue && _ctx.issue.is_remote && _ctx.issue.remote_instance_id);
  }

  function getRemoteInstanceId() {
    return isRemoteIssue() ? String(_ctx.issue.remote_instance_id || '') : '';
  }

  function getRemoteIssueId() {
    if (!isRemoteIssue()) return String((_ctx.issue && _ctx.issue.id) || '');
    return String(_ctx.issue.remote_issue_id || _ctx.issue.id || '');
  }

  function findCommentById(commentId) {
    return (_ctx.issue && Array.isArray(_ctx.issue.comments) ? _ctx.issue.comments : []).find(function(comment) {
      return String(comment.id) === String(commentId) || String(comment.remote_comment_id || '') === String(commentId);
    }) || null;
  }

  function getIssueApiBase(issueIdOverride) {
    if (issueIdOverride && isRemoteIssueId(issueIdOverride)) {
      return buildIssueApiPath(issueIdOverride);
    }
    if (isRemoteIssue()) {
      return '/api/remote-issues/' + encodeURIComponent(getRemoteInstanceId()) + '/' + encodeURIComponent(String(issueIdOverride || getRemoteIssueId()));
    }
    return buildIssueApiPath(issueIdOverride || (_ctx.issue && _ctx.issue.id) || '');
  }

  function getIssueCommentsApiPath() {
    return getIssueApiBase() + '/comments';
  }

  function getCommentApiPath(commentId) {
    if (!isRemoteIssue()) return '/api/comments/' + encodeURIComponent(String(commentId || ''));
    var comment = findCommentById(commentId);
    var remoteCommentId = comment ? (comment.remote_comment_id || comment.id) : commentId;
    return '/api/remote-comments/' + encodeURIComponent(getRemoteInstanceId()) + '/' + encodeURIComponent(String(remoteCommentId || ''));
  }

  function getReactionApiPath(type, targetId) {
    if (!isRemoteIssue()) {
      return '/api/reactions/' + encodeURIComponent(type) + '/' + encodeURIComponent(String(targetId || ''));
    }
    var remoteTargetId = targetId;
    if (type === 'issue') {
      remoteTargetId = getRemoteIssueId();
    } else if (type === 'comment') {
      var comment = findCommentById(targetId);
      remoteTargetId = comment ? (comment.remote_comment_id || comment.id) : targetId;
    }
    return '/api/remote-reactions/' + encodeURIComponent(getRemoteInstanceId()) + '/' + encodeURIComponent(type) + '/' + encodeURIComponent(String(remoteTargetId || ''));
  }

  function getIssueByNumberApiPath(issueNumber) {
    return buildProjectIssueLookupApiPath((_ctx.issue && _ctx.issue.project_id) || '', issueNumber);
  }

  function getRelationsApiBase(issueIdOverride) {
    return getIssueApiBase(issueIdOverride) + '/relations';
  }

  // Generate avatar HTML: use role-based avatar for agents, fallback to identicon
  function authorAvatarHtml(authorId, size) {
    var agent = _ctx.agents.find(function(x) { return x.id === authorId; });
    if (agent && agent.role) {
      var color = _ctx.projectColor || '#4A90E2';
      return roleAvatarHtml(agent.name, size, color);
    }
    return avatarSvg(nameOf(authorId), size);
  }

  function createAgentNameLookup(agentNames) {
    var lookup = Object.create(null);
    agentNames.forEach(function(name) {
      lookup[name] = true;
    });
    return lookup;
  }

  function highlightMentionsInSegment(text, agentNameLookup) {
    return text.replace(/(^|[^\w./+-])@([\w-]+)/g, function(match, prefix, name) {
      if (!agentNameLookup[name]) return match;
      return prefix + h`<span style="color:#61afef;font-weight:500;background:#61afef18;padding:0 4px;border-radius:3px">@${name}</span>`;
    });
  }

  function shouldSkipMentionHighlightNode(node) {
    if (!node || !node.parentElement || !node.parentElement.closest) return false;
    // marked may auto-link emails and URLs into anchors; rewriting their text nodes risks
    // leaking HTML fragments into visible content when @mentions are highlighted.
    return !!node.parentElement.closest('a, code, pre');
  }

  function shouldSkipMentionHighlightTag(tagName) {
    return tagName === 'a' || tagName === 'code' || tagName === 'pre';
  }

  function highlightMentionsInHtml(html, agentNames) {
    if (!html || !agentNames.length) return html;
    var agentNameLookup = createAgentNameLookup(agentNames);

    var skipTagDepth = 0;
    return html.split(/(<[^>]+>)/g).map(function(part) {
      if (!part) return part;
      if (part.charAt(0) === '<') {
        var tagMatch = part.match(/^<\s*(\/)?\s*([a-z0-9-]+)/i);
        if (tagMatch) {
          var isClosingTag = !!tagMatch[1];
          var tagName = tagMatch[2].toLowerCase();
          if (shouldSkipMentionHighlightTag(tagName)) {
            if (isClosingTag) {
              skipTagDepth = Math.max(0, skipTagDepth - 1);
            } else if (!/\/\s*>$/.test(part)) {
              skipTagDepth += 1;
            }
          }
        }
        return part;
      }
      if (skipTagDepth > 0) return part;
      return highlightMentionsInSegment(part, agentNameLookup);
    }).join('');
  }

  function renderMd(text, authorId) {
    if (!text) return '';
    var agents = _ctx.agents;
    var issue = _ctx.issue;
    var normalizedText = String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '  ');

    // Protect LaTeX blocks from markdown processing
    var latexBlocks = [];
    var processed = normalizedText;
    // Block math: $$...$$
    processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, function(_, tex) {
      var idx = latexBlocks.length;
      latexBlocks.push({ tex: tex.trim(), display: true });
      return '%%LATEX_BLOCK_' + idx + '%%';
    });
    // Inline math: $...$
    processed = processed.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, function(_, tex) {
      var idx = latexBlocks.length;
      latexBlocks.push({ tex: tex.trim(), display: false });
      return '%%LATEX_BLOCK_' + idx + '%%';
    });
    // Auto-link #N to issue pages
    processed = processed.replace(/#(\d+)/g, function(m, n) {
      return issue && issue.project_id ? '[#' + n + '](' + buildIssuePageHref({ issueId: '', projectId: issue.project_id, issueNumber: n }) + ')' : m;
    });

    var renderedHtml = '';
    if (typeof marked !== 'undefined') {
      try { renderedHtml = marked.parse(processed, { gfm: true }); } catch(e) { renderedHtml = h`<pre style="white-space:pre-wrap">${normalizedText}</pre>`; }
    } else {
      renderedHtml = h`<pre style="white-space:pre-wrap">${normalizedText}</pre>`;
    }

    // Highlight @mentions
    var agentNames = agents.map(function(a) { return a.name; });
    renderedHtml = highlightMentionsInHtml(renderedHtml, agentNames);

    // Make file paths in <code> clickable — link to Files tab preview
    // Matches paths like src/foo/bar.ts, public/js/app.js, etc.
    renderedHtml = renderedHtml.replace(/<code>([^<]+?)<\/code>/g, function(m, path) {
      // Match file paths: start with a known dir or contain / with a file extension
      if (/^(?:src|public|dist|test|tests|lib|config|scripts|docs|\.github)\/[\w./-]+\.\w+$/.test(path) ||
          /^[\w.-]+\/[\w./-]+\.\w+$/.test(path)) {
        var fileAgentId = getFileLinkAgentId(authorId);
        var agentAttr = fileAgentId ? h` data-agent-id="${fileAgentId}"` : '';
        return h`<code class="file-link" data-file-path="${path}"${html(agentAttr)} title="Click to preview in Files tab" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:#61afef">${path}</code>`;
      }
      return m;
    });

    // Restore LaTeX blocks with KaTeX rendering
    renderedHtml = renderedHtml.replace(/%%LATEX_BLOCK_(\d+)%%/g, function(_, idx) {
      var block = latexBlocks[parseInt(idx)];
      if (typeof katex !== 'undefined') {
        try { return katex.renderToString(block.tex, { displayMode: block.display, throwOnError: false }); }
        catch(e) { return h`<code style="color:var(--error)">${block.tex}</code>`; }
      }
      return h`<code>${block.tex}</code>`;
    });

    return renderedHtml;
  }

  function labelHtml(text) {
    var colors = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#b5bd68','#cc6666','#8abeb7'];
    var bg = colors[hashCode(text.trim()) % colors.length];
    return h`<span style="font-size:11px;padding:1px 8px;border-radius:12px;background:${bg}22;color:${bg};border:1px solid ${bg}44;font-weight:500">${text.trim()}</span>`;
  }

  function statusIcon(s) {
    if (s === 'open') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#3fb950" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#3fb950"/></svg>';
    if (s === 'in_progress') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#d29922"/></svg>';
    if (s === 'pending') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2" stroke-dasharray="4 2"/><circle cx="8" cy="8" r="2" fill="#d29922"/></svg>';
    if (s === 'done') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="gray" stroke-width="2"/><line x1="5" y1="5" x2="11" y2="11" stroke="gray" stroke-width="1.5"/><line x1="11" y1="5" x2="5" y2="11" stroke="gray" stroke-width="1.5"/></svg>';
  }

  function reactionBar(targetType, targetId, reactions) {
    var wrapper = document.createElement('div');
    wrapper.appendChild(createReactionBarNode(targetType, targetId, reactions));
    return wrapper.innerHTML;
  }

  function cloneIssueTemplate(id) {
    var template = document.getElementById(id);
    if (!template) return null;
    return template.content.firstElementChild.cloneNode(true);
  }

  function ensureTemplatesLoaded() {
    if (document.getElementById('tmpl-ir-timeline-comment')) {
      return Promise.resolve();
    }
    if (!_templatesPromise) {
      _templatesPromise = fetch(TEMPLATE_URL, { headers: typeof apiHeaders === 'function' ? apiHeaders() : {} })
        .then(function(res) {
          if (!res.ok) throw new Error('Failed to load issue renderer templates');
          return res.text();
        })
        .then(function(html) {
          var host = document.createElement('div');
          host.setAttribute('data-issue-renderer-templates', '');
          host.style.display = 'none';
          host.innerHTML = html;
          document.body.appendChild(host);
        })
        .catch(function(err) {
          _templatesPromise = null;
          throw err;
        });
    }
    return _templatesPromise;
  }

  function textNode(value) {
    return document.createTextNode(value == null ? '' : String(value));
  }

  function createEl(tagName, attrs) {
    var node = document.createElement(tagName);
    Object.keys(attrs || {}).forEach(function(name) {
      if (name === 'className') node.className = attrs[name];
      else if (name === 'textContent') node.textContent = attrs[name] == null ? '' : String(attrs[name]);
      else if (name === 'style') node.style.cssText = attrs[name];
      else node.setAttribute(name, attrs[name]);
    });
    for (var i = 2; i < arguments.length; i++) {
      appendChildValue(node, arguments[i]);
    }
    return node;
  }

  function appendChildValue(parent, value) {
    if (value == null || value === false) return;
    if (Array.isArray(value)) {
      value.forEach(function(item) { appendChildValue(parent, item); });
    } else if (value instanceof Node) {
      parent.appendChild(value);
    } else {
      parent.appendChild(textNode(value));
    }
  }

  function setSlot(root, slotName, value) {
    var node = root.querySelector('[data-slot="' + slotName + '"]');
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function createStaticHtmlNode(html) {
    var wrapper = document.createElement('span');
    wrapper.innerHTML = html;
    return wrapper.firstElementChild || wrapper;
  }

  function createStatusIconNode(status) {
    return createStaticHtmlNode(statusIcon(status));
  }

  function createAvatarNode(authorId, size) {
    var agent = findAgentById(authorId);
    if (agent && agent.role) {
      var span = document.createElement('span');
      span.className = 'role-avatar';
      span.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + agentHslColor(agent.name) + ';color:#fff;font-size:' + Math.round(size * 0.4) + 'px;font-weight:600;line-height:1;flex-shrink:0;text-transform:uppercase;letter-spacing:-0.5px';
      span.textContent = getNameInitials(agent.name || '?');
      return span;
    }
    return createStaticHtmlNode(avatarSvg(nameOf(authorId), size));
  }

  function createPriorityBadgeNode(priority) {
    var badge = document.createElement('span');
    badge.style.cssText = 'font-size:10px;padding:1px 6px;border-radius:8px';
    if (priority >= 10) {
      badge.style.background = 'rgba(220,50,47,0.15)';
      badge.style.color = 'var(--error)';
      badge.textContent = 'USER';
    } else if (priority >= 5) {
      badge.style.background = 'rgba(181,137,0,0.15)';
      badge.style.color = 'var(--warning)';
      badge.textContent = 'CTRL';
    } else {
      badge.style.background = 'rgba(88,110,117,0.15)';
      badge.style.color = 'var(--text-secondary)';
      badge.textContent = 'AGENT';
    }
    return badge;
  }

  function createLabelNode(label) {
    var text = String(label || '').trim();
    var colors = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#b5bd68','#cc6666','#8abeb7'];
    var bg = colors[hashCode(text) % colors.length];
    var node = document.createElement('span');
    node.style.cssText = 'font-size:11px;padding:1px 8px;border-radius:12px;background:' + bg + '22;color:' + bg + ';border:1px solid ' + bg + '44;font-weight:500';
    node.textContent = text;
    return node;
  }

  function createMarkdownNode(text, authorId) {
    var node = createEl('div', { className: 'markdown-body' });
    node.innerHTML = renderMd(text, authorId);
    return node;
  }

  function createReactionBarNode(targetType, targetId, reactions) {
    var bar = createEl('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;margin-top:4px' });
    var grouped = {};
    (reactions || []).forEach(function(r) {
      if (!grouped[r.emoji]) grouped[r.emoji] = [];
      grouped[r.emoji].push(r.user_id);
    });
    Object.entries(grouped).forEach(function(entry) {
      var emoji = entry[0];
      var users = entry[1];
      var tag = _ctx.readOnly ? 'span' : 'button';
      var node = createEl(tag, {
        title: users.map(function(u) { return nameOf(u); }).join(', '),
        style: 'background:var(--selected-bg);border:1px solid var(--border);border-radius:12px;padding:1px 8px;cursor:pointer;font-size:12px',
      }, emoji + ' ' + users.length);
      if (!_ctx.readOnly) {
        node.addEventListener('click', function() { toggleReaction(targetType, targetId, emoji); });
      }
      bar.appendChild(node);
    });
    if (!_ctx.readOnly) {
      var add = createEl('button', {
        title: 'Add reaction',
        style: 'background:none;border:1px solid var(--border);border-radius:12px;padding:1px 6px;cursor:pointer;font-size:12px',
      }, '+');
      add.addEventListener('click', function() { showEmojiPicker(targetType, targetId); });
      bar.appendChild(add);
    }
    return bar;
  }

  function createIssueSelect(id, value, options, onChange) {
    var select = createEl('select', {
      id: id,
      style: 'width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px',
    });
    options.forEach(function(option) {
      var opt = document.createElement('option');
      opt.value = option.value == null ? '' : String(option.value);
      opt.textContent = option.label;
      opt.selected = opt.value === String(value == null ? '' : value);
      select.appendChild(opt);
    });
    select.addEventListener('change', function() { onChange(select.value); });
    return select;
  }

  function createSidebarSection(title, content) {
    return createEl('div', { className: 'sidebar-section' },
      createEl('div', { className: 'sidebar-section-title' }, title),
      content
    );
  }

  function createIssueLinkRow(item, status, label, href, readOnly, extraStyle) {
    var row = createEl(readOnly ? 'div' : 'a', {
      style: 'display:flex;align-items:center;gap:6px;padding:3px 0;text-decoration:none;color:inherit;font-size:12px' + (extraStyle || ''),
    }, createStatusIconNode(status), createEl('span', {}, label));
    if (!readOnly) row.href = href;
    return row;
  }

  function createTimelineEntry(comment) {
    var entryDate = comment.created_at ? new Date(comment.created_at + (comment.created_at.includes('Z') ? '' : 'Z')).toLocaleString() : '';
    if (comment.event_type !== 'comment') {
      var eventRow = cloneIssueTemplate('tmpl-ir-timeline-event') || createEl('div', {});
      var icon = comment.event_type === 'status_change' ? '🔄' : comment.event_type === 'assignment' ? '👤' : '🏷️';
      setSlot(eventRow, 'icon', icon);
      setSlot(eventRow, 'actor', nameOf(comment.author_id));
      setSlot(eventRow, 'body', String(comment.body || '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, function(id) { return nameOf(id); }));
      setSlot(eventRow, 'time', timeAgo(comment.created_at));
      var eventTime = eventRow.querySelector('[data-slot="time"]');
      if (eventTime) eventTime.title = entryDate;
      return eventRow;
    }

    var row = cloneIssueTemplate('tmpl-ir-timeline-comment') || createEl('div', { className: 'timeline-item' });
    row.querySelector('[data-slot="avatar"]').replaceChildren(createAvatarNode(comment.author_id, 24));
    setSlot(row, 'author', nameOf(comment.author_id));
    setSlot(row, 'time', timeAgo(comment.created_at));
    var timeNode = row.querySelector('[data-slot="time"]');
    if (timeNode) timeNode.title = entryDate;
    var actions = row.querySelector('[data-slot="actions"]');
    if (comment.author_id === 'user' && !_ctx.readOnly) {
      var edit = createEl('button', { style: 'background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px' }, 'edit');
      var remove = createEl('button', { style: 'background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px' }, 'delete');
      edit.addEventListener('click', function() { editComment(comment.id); });
      remove.addEventListener('click', function() { deleteComment(comment.id); });
      actions.replaceChildren(edit, remove);
    } else {
      actions.replaceChildren();
    }
    var body = row.querySelector('[data-slot="body"]');
    body.id = 'ir-comment-body-' + comment.id;
    body.replaceChildren(createMarkdownNode(comment.body, comment.author_id));
    row.querySelector('[data-slot="reactions"]').replaceChildren(createReactionBarNode('comment', comment.id, comment.reactions));
    return row;
  }

  function createDependenciesSection(issue, readOnly) {
    var blocks = issue.blocks || [];
    var blockedBy = issue.blocked_by || [];
    var relatedTo = issue.related_to || [];
    var content = createEl('div', {});
    if (blocks.length === 0 && blockedBy.length === 0 && relatedTo.length === 0 && !issue.is_blocked) {
      content.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-secondary);margin-bottom:6px' }, 'No dependencies'));
      if (!readOnly) content.appendChild(createAddDependencyButton('font-size:11px;width:100%'));
      return createSidebarSection('Dependencies', content);
    }

    function addGroup(title, rows, config) {
      if (!rows.length) return;
      content.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-secondary);margin-bottom:2px;margin-top:4px;font-weight:600' }, title));
      rows.forEach(function(relation) {
        content.appendChild(createRelationRow(relation, config, issue, readOnly));
      });
    }

    addGroup('Blocked by', blockedBy, { idKey: 'source_issue_id', numberKey: 'source_number', titleKey: 'source_title' });
    addGroup('Blocks', blocks, { idKey: 'target_issue_id', numberKey: 'target_number', titleKey: 'target_title' });
    addGroup('Related to', relatedTo, { idKey: 'target_issue_id', fallbackIdKey: 'source_issue_id', numberKey: 'target_number', fallbackNumberKey: 'source_number', titleKey: 'target_title', fallbackTitleKey: 'source_title' });
    if (!readOnly) content.appendChild(createAddDependencyButton('font-size:11px;width:100%;margin-top:6px'));

    var section = createSidebarSection('Dependencies', content);
    if (issue.is_blocked) {
      section.querySelector('.sidebar-section-title').appendChild(createEl('span', { style: 'color:var(--error);font-size:10px;font-weight:600;background:var(--error)18;padding:1px 6px;border-radius:8px;margin-left:4px' }, 'BLOCKED'));
    }
    return section;
  }

  function createRelationRow(relation, config, issue, readOnly) {
    var status = relation.status || relation.source_status || relation.target_status || 'open';
    var resolved = status === 'done' || status === 'closed';
    var number = relation.number || relation[config.numberKey] || relation[config.fallbackNumberKey];
    var title = relation.title || relation[config.titleKey] || relation[config.fallbackTitleKey] || '';
    var issueId = relation[config.idKey] || relation[config.fallbackIdKey] || relation.id;
    var row = createEl('div', {
      style: 'display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px' + (resolved ? ';color:var(--text-secondary)' : ''),
    }, createStatusIconNode(status));
    var label = '#' + number + ' ' + title;
    var link = readOnly
      ? createEl('span', { style: (resolved ? 'color:var(--text-secondary);text-decoration:line-through' : 'color:inherit') + ';flex:1' }, label)
      : createEl('a', { href: buildIssuePageHref({ issueId: issueId, projectId: relation.project_id || issue.project_id, issueNumber: number }), style: 'text-decoration:none;' + (resolved ? 'color:var(--text-secondary);text-decoration:line-through' : 'color:inherit') + ';flex:1' }, label);
    row.appendChild(link);
    if (resolved) row.appendChild(createEl('span', { style: 'font-size:10px;color:var(--text-secondary);background:var(--bg-secondary);padding:0 4px;border-radius:4px;white-space:nowrap' }, 'Resolved'));
    if (!readOnly) {
      var remove = createEl('button', { title: 'Remove', style: 'background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:10px' }, '✕');
      remove.addEventListener('click', function() { removeRelation(relation.relation_id); });
      row.appendChild(remove);
    }
    return row;
  }

  function createAddDependencyButton(style) {
    var button = createEl('button', { className: 'btn btn-sm', style: style }, '+ Add dependency');
    button.addEventListener('click', showAddRelation);
    return button;
  }

  function renderIssueDom(issue, agents, container) {
    var readOnly = _ctx.readOnly;
    var allEntries = issue.comments || [];
    var commentCount = allEntries.filter(function(c) { return c.event_type === 'comment'; }).length;
    var root = document.createDocumentFragment();

    var titleRow = createEl('div', { style: 'margin-bottom:16px' });
    var titleDisplay = createEl('div', { id: 'ir-title-display', style: 'display:flex;align-items:flex-start;gap:8px' });
    titleDisplay.appendChild(createEl('h2', { style: 'flex:1;font-size:22px;font-weight:600' }, issue.title + ' ', createEl('span', { style: 'color:var(--text-secondary);font-weight:400' }, '#' + issue.number)));
    if (readOnly) {
      titleDisplay.appendChild(createEl('span', { className: 'meta-chip meta-chip-remote', title: 'Remote issue mirrored into the local inbox' }, 'Remote read-only'));
    } else {
      var editTitle = createEl('button', { className: 'btn btn-sm' }, 'Edit');
      editTitle.addEventListener('click', startEditTitle);
      titleDisplay.appendChild(editTitle);
      var openIssueHref = buildIssuePageHref({ issueId: issue.id, projectId: issue.project_id, issueNumber: issue.number });
      if (openIssueHref) titleDisplay.appendChild(createEl('a', { href: openIssueHref, className: 'btn btn-sm', title: 'Open in a new page', style: 'text-decoration:none' }, '↗'));
    }
    titleRow.appendChild(titleDisplay);

    var titleEdit = createEl('div', { id: 'ir-title-edit', style: 'display:none;margin-bottom:8px' },
      createEl('div', { style: 'display:flex;gap:8px' },
        createEl('input', { type: 'text', id: 'ir-edit-title-input', style: 'flex:1;padding:6px 10px;font-size:16px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg)' })
      )
    );
    var titleButtons = titleEdit.firstElementChild;
    var saveTitleButton = createEl('button', { className: 'btn btn-sm btn-primary' }, 'Save');
    saveTitleButton.addEventListener('click', saveTitle);
    var cancelTitleButton = createEl('button', { className: 'btn btn-sm' }, 'Cancel');
    cancelTitleButton.addEventListener('click', cancelEditTitle);
    titleButtons.append(saveTitleButton, cancelTitleButton);
    titleRow.appendChild(titleEdit);

    var meta = createEl('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px' },
      createStatusIconNode(issue.status),
      createEl('span', { style: 'font-weight:500' }, String(issue.status || '').replace('_', ' ')),
      createPriorityBadgeNode(issue.priority)
    );
    String(issue.labels || '').split(',').filter(function(label) { return label.trim(); }).forEach(function(label) {
      meta.appendChild(createLabelNode(label));
    });
    meta.appendChild(createEl('span', { style: 'color:var(--text-secondary)' }, nameOf(issue.created_by) + ' opened ' + timeAgo(issue.created_at) + ' · ' + commentCount + ' comments'));
    titleRow.appendChild(meta);
    root.appendChild(titleRow);

    var layout = createEl('div', { className: 'issue-detail-layout' });
    var main = createEl('div', { className: 'issue-detail-main' });
    var body = createEl('div', { className: 'issue-body' });
    var bodyHeader = createEl('div', { className: 'issue-body-header', style: 'display:flex;justify-content:space-between;align-items:center' },
      createEl('span', { style: 'display:flex;align-items:center;gap:6px' }, createAvatarNode(issue.created_by, 20), createEl('strong', {}, nameOf(issue.created_by)))
    );
    if (readOnly) {
      bodyHeader.appendChild(createEl('span', { style: 'font-size:11px;color:var(--text-secondary)' }, 'Remote mirror'));
    } else {
      var editBody = createEl('button', { style: 'background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px' }, 'edit');
      editBody.addEventListener('click', startEditBody);
      bodyHeader.appendChild(editBody);
    }
    body.appendChild(bodyHeader);
    body.appendChild(createEl('div', { className: 'issue-body-content', id: 'ir-body-display' }, createMarkdownNode(issue.body, issue.created_by), createReactionBarNode('issue', issue.id, issue.reactions)));
    var bodyEdit = createEl('div', { id: 'ir-body-edit', style: 'display:none;padding:12px' },
      createEl('textarea', { id: 'ir-edit-body-input', rows: '8', style: 'width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:13px;font-family:inherit;resize:vertical' }),
      createEl('div', { style: 'display:flex;gap:8px;margin-top:8px;justify-content:flex-end' })
    );
    var bodyEditActions = bodyEdit.lastElementChild;
    var cancelBodyButton = createEl('button', { className: 'btn btn-sm' }, 'Cancel');
    cancelBodyButton.addEventListener('click', cancelEditBody);
    var saveBodyButton = createEl('button', { className: 'btn btn-sm btn-primary' }, 'Save');
    saveBodyButton.addEventListener('click', saveBody);
    bodyEditActions.append(cancelBodyButton, saveBodyButton);
    body.appendChild(bodyEdit);
    main.appendChild(body);

    if (allEntries.length) {
      main.appendChild(createEl('div', { className: 'timeline' }, allEntries.map(createTimelineEntry)));
    }

    if (readOnly) {
      main.appendChild(createEl('div', { className: 'comment-box', style: 'margin-top:16px' }, createEl('div', { style: 'font-size:12px;color:var(--text-secondary)' }, 'Remote issues are currently read-only inside the local dashboard.')));
    } else {
      var commentBox = createEl('div', { className: 'comment-box', style: 'margin-top:16px' },
        createEl('textarea', { id: 'ir-comment-input', placeholder: 'Leave a comment... (Markdown supported)' }),
        createEl('div', { className: 'comment-box-footer', style: 'display:flex;justify-content:space-between;align-items:center' },
          createEl('span', { style: 'font-size:11px;color:var(--text-secondary)' }, 'Markdown · #N auto-links · @agent-name to mention'),
          createEl('div', { style: 'display:flex;gap:8px;align-items:center' })
        )
      );
      var commentActions = commentBox.querySelector('.comment-box-footer div');
      var closeButton = createEl('button', { className: 'btn btn-sm', id: issue.status !== 'closed' && issue.status !== 'done' ? 'ir-close-issue-btn' : 'ir-reopen-issue-btn', style: issue.status !== 'closed' && issue.status !== 'done' ? 'color:var(--error);border-color:var(--error)' : 'color:var(--success);border-color:var(--success)' }, issue.status !== 'closed' && issue.status !== 'done' ? 'Close issue' : 'Reopen issue');
      closeButton.addEventListener('click', issue.status !== 'closed' && issue.status !== 'done' ? closeWithComment : reopenWithComment);
      var addCommentButton = createEl('button', { className: 'btn btn-sm btn-primary' }, 'Comment');
      addCommentButton.addEventListener('click', addComment);
      commentActions.append(closeButton, addCommentButton);
      main.appendChild(commentBox);
    }

    var sidebar = createEl('div', { className: 'issue-detail-sidebar' });
    sidebar.appendChild(createSidebarSection('Status', readOnly
      ? createEl('div', { style: 'font-size:12px;color:var(--fg)' }, String(issue.status || '').replace('_', ' '))
      : createIssueSelect('ir-detail-status', issue.status, [
        { value: 'open', label: 'Open' },
        { value: 'in_progress', label: 'In Progress' },
        { value: 'pending', label: 'Pending' },
        { value: 'done', label: 'Done' },
        { value: 'closed', label: 'Closed' },
      ], function(value) { updateField('status', value); })));
    var assigneeOptions = [{ value: '', label: 'Unassigned' }, { value: 'all', label: 'All' }, { value: 'user', label: 'User' }].concat(agents.map(function(agent) { return { value: agent.id, label: agent.name }; }));
    sidebar.appendChild(createSidebarSection('Assignee', readOnly
      ? createEl('div', { style: 'font-size:12px;color:var(--fg)' }, nameOf(issue.assigned_to || ''))
      : createIssueSelect('ir-detail-assign', issue.assigned_to || '', assigneeOptions, function(value) { updateField('assigned_to', value || null); })));
    var labels = String(issue.labels || '').split(',').filter(function(label) { return label.trim(); });
    sidebar.appendChild(createSidebarSection('Labels', readOnly
      ? createEl('div', { style: 'font-size:12px;color:var(--fg)' }, labels.length ? labels.map(createLabelNode) : createEl('span', { style: 'color:var(--text-secondary)' }, 'No labels'))
      : (function() {
        var input = createEl('input', { type: 'text', id: 'ir-detail-labels', value: issue.labels || '', placeholder: 'bug, feature', style: 'width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px' });
        input.addEventListener('change', function() { updateField('labels', input.value); });
        return input;
      })()));
    sidebar.appendChild(createSidebarSection('Priority', createPriorityBadgeNode(issue.priority)));
    if (issue.parent_id && issue.parent_number) {
      sidebar.appendChild(createSidebarSection('Parent Issue', createIssueLinkRow(issue, issue.parent_status || 'open', '#' + issue.parent_number + ' ' + (issue.parent_title || ''), buildIssuePageHref({ issueId: issue.parent_id, projectId: issue.project_id, issueNumber: issue.parent_number }), readOnly)));
    }
    if (issue.children && issue.children.length > 0) {
      var done = issue.children.filter(function(child) { return child.status === 'done' || child.status === 'closed'; }).length;
      var total = issue.children.length;
      var pct = Math.round(done / total * 100);
      var childrenContent = createEl('div', {},
        createEl('div', { style: 'background:var(--border);border-radius:4px;height:6px;margin-bottom:8px;overflow:hidden' }, createEl('div', { style: 'background:var(--success);height:100%;width:' + pct + '%;transition:width 0.3s' })),
        issue.children.map(function(child) {
          return createIssueLinkRow(child, child.status, '#' + child.number + ' ' + child.title, buildIssuePageHref({ issueId: child.id, projectId: child.project_id || issue.project_id, issueNumber: child.number }), readOnly);
        })
      );
      sidebar.appendChild(createSidebarSection('Child Issues (' + done + '/' + total + ' done)', childrenContent));
    }
    sidebar.appendChild(createDependenciesSection(issue, readOnly));
    if (!readOnly && issue.status === 'open') {
      var deleteWrap = createEl('div', { style: 'margin-top:12px' });
      var deleteButton = createEl('button', { className: 'btn btn-sm btn-danger' }, 'Delete');
      deleteButton.addEventListener('click', deleteIssue);
      deleteWrap.appendChild(deleteButton);
      sidebar.appendChild(deleteWrap);
    }
    layout.append(main, sidebar);
    root.appendChild(layout);
    container.replaceChildren(root);

    var commentInput = document.getElementById('ir-comment-input');
    if (!readOnly && commentInput && typeof setupMentionAutocomplete === 'function') {
      setupMentionAutocomplete(commentInput, agents);
      commentInput.addEventListener('input', function() {
        var btn = document.getElementById('ir-close-issue-btn');
        if (btn) btn.textContent = this.value.trim() ? 'Close with comment' : 'Close issue';
        var reopenBtn = document.getElementById('ir-reopen-issue-btn');
        if (reopenBtn) reopenBtn.textContent = this.value.trim() ? 'Reopen with comment' : 'Reopen issue';
      });
    }
  }

  // ─── Main render function ───
  function render(issue, agents, container, options) {
    options = options || {};
    _ctx.issue = issue;
    _ctx.agents = agents || [];
    _ctx.container = container;
    _ctx.reload = options.reload || function() {};
    _ctx.refreshComments = options.refreshComments || null;
    _ctx.onAfterAction = options.onAfterAction || function() {};
    _ctx.projectColor = options.projectColor || issue.project_color || null;
    _ctx.readOnly = options.readOnly === true;
    ensureTemplatesLoaded()
      .then(function() { renderIssueDom(issue, agents || [], container); })
      .catch(function(err) {
        console.error('Failed to render issue', err);
        container.replaceChildren(createEl('div', { className: 'empty-state' }, 'Failed to load issue view.'));
      });
  }

  // ─── Inline editing ───

  function startEditTitle() {
    if (_ctx.readOnly) return;
    document.getElementById('ir-title-display').style.display = 'none';
    document.getElementById('ir-title-edit').style.display = '';
    document.getElementById('ir-edit-title-input').value = _ctx.issue.title;
    document.getElementById('ir-edit-title-input').focus();
  }
  function cancelEditTitle() {
    document.getElementById('ir-title-display').style.display = '';
    document.getElementById('ir-title-edit').style.display = 'none';
  }
  function saveTitle() {
    if (_ctx.readOnly) return;
    var v = document.getElementById('ir-edit-title-input').value.trim();
    if (!v) return;
    fetch(getIssueApiBase(), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ title: v, actor: 'user' }) })
      .then(function() { _ctx.reload(); });
  }
  function startEditBody() {
    if (_ctx.readOnly) return;
    document.getElementById('ir-body-display').style.display = 'none';
    document.getElementById('ir-body-edit').style.display = '';
    document.getElementById('ir-edit-body-input').value = _ctx.issue.body;
    document.getElementById('ir-edit-body-input').focus();
  }
  function cancelEditBody() {
    document.getElementById('ir-body-display').style.display = '';
    document.getElementById('ir-body-edit').style.display = 'none';
  }
  function saveBody() {
    if (_ctx.readOnly) return;
    var v = document.getElementById('ir-edit-body-input').value;
    fetch(getIssueApiBase(), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ body: v, actor: 'user' }) })
      .then(function() { _ctx.reload(); });
  }

  // ─── Actions ───

  function updateField(field, value) {
    if (_ctx.readOnly) return;
    var body = {}; body[field] = value; body.actor = 'user';
    fetch(getIssueApiBase(), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) })
      .then(function() { _ctx.reload(); _ctx.onAfterAction(); });
  }

  async function deleteIssue() {
    if (_ctx.readOnly) return;
    if (!await showConfirm('Delete this issue?', {
      title: 'Delete issue?',
      confirmLabel: 'Delete issue',
      tone: 'danger',
    })) return;
    fetch(getIssueApiBase(), { method: 'DELETE' })
      .then(function(res) {
        if (res.ok) { showToast('Issue deleted', 'success'); history.back(); }
        else showToast('Only open issues can be deleted', 'error');
      });
  }

  function closeWithComment() {
    if (_ctx.readOnly) return;
    var body = document.getElementById('ir-comment-input').value.trim();
    var p = Promise.resolve();
    if (body) {
      p = fetch(getIssueCommentsApiPath(), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ author_id: 'user', body: body }) });
    }
    p.then(function() {
      return fetch(getIssueApiBase(), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: 'closed', actor: 'user' }) });
    }).then(function() {
      showToast(body ? 'Comment added and issue closed' : 'Issue closed', 'success');
      _ctx.reload();
      _ctx.onAfterAction();
    });
  }

  function reopenWithComment() {
    if (_ctx.readOnly) return;
    var body = document.getElementById('ir-comment-input').value.trim();
    var p = Promise.resolve();
    if (body) {
      p = fetch(getIssueCommentsApiPath(), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ author_id: 'user', body: body }) });
    }
    p.then(function() {
      return fetch(getIssueApiBase(), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: 'open', actor: 'user' }) });
    }).then(function() {
      showToast(body ? 'Comment added and issue reopened' : 'Issue reopened', 'success');
      _ctx.reload();
      _ctx.onAfterAction();
    });
  }

  function addComment() {
    if (_ctx.readOnly) return;
    var body = document.getElementById('ir-comment-input').value.trim();
    if (!body) return;
    fetch(getIssueCommentsApiPath(), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ author_id: 'user', body: body }) })
      .then(function(res) {
        if (!res.ok) throw new Error('Failed to add comment');
        return res.json();
      })
      .then(function(comment) {
        showToast('Comment added', 'success');
        var input = document.getElementById('ir-comment-input');
        if (input) input.value = '';
        if (_ctx.refreshComments) _ctx.refreshComments(comment);
        else _ctx.reload();
        _ctx.onAfterAction();
      })
      .catch(function() { showToast('Failed to add comment', 'error'); });
  }

  function editComment(cid) {
    if (_ctx.readOnly) return;
    var c = (_ctx.issue.comments || []).find(function(x) { return x.id === cid; });
    if (!c) return;
    var el = document.getElementById('ir-comment-body-' + cid);
    if (!el) return;
    var editor = cloneIssueTemplate('tmpl-ir-comment-edit');
    var textarea = editor.querySelector('[data-slot="textarea"]');
    textarea.id = 'ir-edit-comment-' + cid;
    textarea.value = c.body || '';
    editor.querySelector('[data-action="cancel"]').addEventListener('click', function() { _ctx.reload(); });
    editor.querySelector('[data-action="save"]').addEventListener('click', function() { saveComment(cid); });
    el.replaceChildren(editor);
  }

  function saveComment(cid) {
    if (_ctx.readOnly) return;
    var v = document.getElementById('ir-edit-comment-' + cid);
    if (!v || !v.value) return;
    fetch(getCommentApiPath(cid), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ body: v.value }) })
      .then(function(res) { if (res.ok) showToast('Comment saved', 'success'); _ctx.reload(); });
  }

  async function deleteComment(cid) {
    if (_ctx.readOnly) return;
    if (!await showConfirm('Delete this comment?', {
      title: 'Delete comment?',
      confirmLabel: 'Delete comment',
      tone: 'danger',
    })) return;
    fetch(getCommentApiPath(cid), { method: 'DELETE' })
      .then(function() { _ctx.reload(); });
  }

  function toggleReaction(type, id, emoji) {
    if (_ctx.readOnly) return;
    fetch(getReactionApiPath(type, id), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ user_id: 'user', emoji: emoji }) })
      .then(function() { _ctx.reload(); });
  }

  function showAddRelation() {
    if (_ctx.readOnly) return;
    var existing = document.getElementById('ir-add-relation-dialog');
    if (existing) { existing.remove(); return; }
    var div = cloneIssueTemplate('tmpl-ir-add-relation-dialog');
    div.id = 'ir-add-relation-dialog';
    div.querySelector('[data-action="cancel"]').addEventListener('click', function() { div.remove(); });
    div.querySelector('[data-action="add"]').addEventListener('click', addRelation);
    document.body.appendChild(div);
    document.getElementById('ir-rel-target').focus();
  }

  function addRelation() {
    if (_ctx.readOnly) return;
    var typeSelect = document.getElementById('ir-rel-type');
    var targetInput = document.getElementById('ir-rel-target');
    if (!typeSelect || !targetInput) return;
    var relType = typeSelect.value;
    var targetNum = targetInput.value.replace('#', '').trim();
    if (!targetNum) return;

    // For blocked_by: we need to reverse — from=target blocks to=this
    // For the API: POST /api/issues/:id/relations with {type, target_issue_id}
    // The API expects: from_issue_id = :id, to_issue_id = target_issue_id for "blocks"
    // For "blocked_by", we need to call from the target's perspective
    var issueId = _ctx.issue.id;
    var projectId = _ctx.issue.project_id;

    // First resolve issue number to ID
    fetch(getIssueByNumberApiPath(targetNum), { headers: apiHeaders() })
      .then(function(res) { if (!res.ok) throw new Error('Issue not found'); return res.json(); })
      .then(function(targetIssue) {
        var fromId, toId, apiType, relationApiBase;
        if (relType === 'blocked_by') {
          // Target blocks this issue
          fromId = targetIssue.id;
          toId = issueId;
          apiType = 'blocks';
          relationApiBase = getRelationsApiBase(fromId);
          return fetch(relationApiBase, {
            method: 'POST', headers: apiHeaders(),
            body: JSON.stringify({ type: apiType, target_issue_id: toId, actor: 'user' })
          });
        } else {
          apiType = relType;
          toId = isRemoteIssue() ? (targetIssue.remote_issue_id || targetIssue.id) : targetIssue.id;
          return fetch(getRelationsApiBase(), {
            method: 'POST', headers: apiHeaders(),
            body: JSON.stringify({ type: apiType, target_issue_id: toId, actor: 'user' })
          });
        }
      })
      .then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        var dialog = document.getElementById('ir-add-relation-dialog');
        if (dialog) dialog.remove();
        showToast('Dependency added', 'success');
        _ctx.reload();
      })
      .catch(function(err) { showToast(err.message, 'error'); });
  }

  function removeRelation(relationId) {
    if (_ctx.readOnly) return;
    fetch(getRelationsApiBase() + '/' + encodeURIComponent(String(relationId || '')), { method: 'DELETE', headers: apiHeaders() })
      .then(function(res) {
        if (res.ok) { showToast('Dependency removed', 'success'); _ctx.reload(); }
        else showToast('Failed to remove', 'error');
      });
  }

  function openFileInFilesTab(filePath, agentId) {
    if (_ctx.readOnly && _ctx.issue && _ctx.issue.is_remote) {
      showToast('Remote file previews are not available in the local dashboard yet', 'error');
      return;
    }
    var targetAgentId = resolveFileOpenAgentId(agentId);
    // On the project files page, open directly if the files panel is already mounted.
    if (window.ProjectFiles && typeof window.ProjectFiles.openFile === 'function') {
      if (targetAgentId && typeof handleProjectFilesAgentChange === 'function') {
        handleProjectFilesAgentChange(targetAgentId);
        var sel = document.getElementById('project-files-agent');
        if (sel) sel.value = targetAgentId;
      }
      window.ProjectFiles.openFile(filePath);
      return;
    }
    // On dashboard/other project pages: navigate to the project Files route.
    var projectId = _ctx.issue && _ctx.issue.project_id;
    if (projectId) {
      var url = buildProjectPageHref(projectId) + '/files?file=' + encodeURIComponent(filePath);
      if (targetAgentId) url += '&agent=' + encodeURIComponent(targetAgentId);
      window.open(url, '_blank');
    }
  }

  function showEmojiPicker(type, id) {
    var el = document.getElementById('ir-emoji-picker');
    if (el) { el.remove(); return; }
    var div = cloneIssueTemplate('tmpl-ir-emoji-picker');
    div.id = 'ir-emoji-picker';
    var options = div.querySelector('[data-slot="options"]');
    options.replaceChildren(...EMOJIS.map(function(emoji) {
      var button = createEl('button', { type: 'button', style: 'background:none;border:none;cursor:pointer;font-size:18px;padding:2px' }, emoji);
      button.addEventListener('click', function() { toggleReaction(type, id, emoji); });
      return button;
    }));
    div.querySelector('[data-action="close"]').addEventListener('click', function() { div.remove(); });
    document.body.appendChild(div);
  }

  var api = {
    render: render,
    renderMd: renderMd,
    labelHtml: labelHtml,
    statusIcon: statusIcon,
    reactionBar: reactionBar,
    // Actions (called from onclick handlers)
    startEditTitle: startEditTitle,
    cancelEditTitle: cancelEditTitle,
    saveTitle: saveTitle,
    startEditBody: startEditBody,
    cancelEditBody: cancelEditBody,
    saveBody: saveBody,
    updateField: updateField,
    deleteIssue: deleteIssue,
    closeWithComment: closeWithComment,
    reopenWithComment: reopenWithComment,
    addComment: addComment,
    editComment: editComment,
    saveComment: saveComment,
    deleteComment: deleteComment,
    toggleReaction: toggleReaction,
    showEmojiPicker: showEmojiPicker,
    showAddRelation: showAddRelation,
    addRelation: addRelation,
    removeRelation: removeRelation,
    openFileInFilesTab: openFileInFilesTab,
    _ctx: _ctx,
  };

  if (typeof module !== 'undefined' && module.exports) {
    api._test = {
      highlightMentionsInHtml: highlightMentionsInHtml,
    };
  }

  return api;
})();

// Delegated click handler for clickable file paths in comments
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', function(e) {
    var el = e.target.closest('.file-link');
    if (!el) return;
    e.preventDefault();
    var filePath = el.getAttribute('data-file-path');
    var agentId = el.getAttribute('data-agent-id');
    if (filePath) IssueRenderer.openFileInFilesTab(filePath, agentId);
  });
}
