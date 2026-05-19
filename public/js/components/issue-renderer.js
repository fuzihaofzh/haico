// ─── Shared Issue Renderer ───
// Used by both issue.js (full page) and dashboard-core.js (floating panel)

var IssueRenderer = (function() {
  var EMOJIS = ['👍','👎','❤️','🎉','😕','🚀'];

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
      return prefix + '<span style="color:#61afef;font-weight:500;background:#61afef18;padding:0 4px;border-radius:3px">@' + name + '</span>';
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

    var html = '';
    if (typeof marked !== 'undefined') {
      try { html = marked.parse(processed, { gfm: true }); } catch(e) { html = '<pre style="white-space:pre-wrap">' + esc(normalizedText) + '</pre>'; }
    } else {
      html = '<pre style="white-space:pre-wrap">' + esc(normalizedText) + '</pre>';
    }

    // Highlight @mentions
    var agentNames = agents.map(function(a) { return a.name; });
    html = highlightMentionsInHtml(html, agentNames);

    // Make file paths in <code> clickable — link to Files tab preview
    // Matches paths like src/foo/bar.ts, public/js/app.js, etc.
    html = html.replace(/<code>([^<]+?)<\/code>/g, function(m, path) {
      // Match file paths: start with a known dir or contain / with a file extension
      if (/^(?:src|public|dist|test|tests|lib|config|scripts|docs|\.github)\/[\w./-]+\.\w+$/.test(path) ||
          /^[\w.-]+\/[\w./-]+\.\w+$/.test(path)) {
        var fileAgentId = getFileLinkAgentId(authorId);
        return '<code class="file-link" data-file-path="' + esc(path) + '"' + (fileAgentId ? ' data-agent-id="' + esc(fileAgentId) + '"' : '') + ' title="Click to preview in Files tab" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:#61afef">' + esc(path) + '</code>';
      }
      return m;
    });

    // Restore LaTeX blocks with KaTeX rendering
    html = html.replace(/%%LATEX_BLOCK_(\d+)%%/g, function(_, idx) {
      var block = latexBlocks[parseInt(idx)];
      if (typeof katex !== 'undefined') {
        try { return katex.renderToString(block.tex, { displayMode: block.display, throwOnError: false }); }
        catch(e) { return '<code style="color:var(--error)">' + block.tex + '</code>'; }
      }
      return '<code>' + esc(block.tex) + '</code>';
    });

    return html;
  }

  function labelHtml(text) {
    var colors = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#b5bd68','#cc6666','#8abeb7'];
    var bg = colors[hashCode(text.trim()) % colors.length];
    return '<span style="font-size:11px;padding:1px 8px;border-radius:12px;background:' + bg + '22;color:' + bg + ';border:1px solid ' + bg + '44;font-weight:500">' + esc(text.trim()) + '</span>';
  }

  function statusIcon(s) {
    if (s === 'open') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#3fb950" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#3fb950"/></svg>';
    if (s === 'in_progress') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#d29922"/></svg>';
    if (s === 'pending') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2" stroke-dasharray="4 2"/><circle cx="8" cy="8" r="2" fill="#d29922"/></svg>';
    if (s === 'done') return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="gray" stroke-width="2"/><line x1="5" y1="5" x2="11" y2="11" stroke="gray" stroke-width="1.5"/><line x1="11" y1="5" x2="5" y2="11" stroke="gray" stroke-width="1.5"/></svg>';
  }

  function reactionBar(targetType, targetId, reactions) {
    var grouped = {};
    (reactions || []).forEach(function(r) { if (!grouped[r.emoji]) grouped[r.emoji] = []; grouped[r.emoji].push(r.user_id); });
    var html = Object.entries(grouped).map(function(entry) {
      var emoji = entry[0], users = entry[1];
      var title = users.map(function(u) { return nameOf(u); }).join(', ');
      if (_ctx.readOnly) {
        return '<span style="background:var(--selected-bg);border:1px solid var(--border);border-radius:12px;padding:1px 8px;font-size:12px" title="' + title + '">' + emoji + ' ' + users.length + '</span>';
      }
      return '<button onclick="IssueRenderer.toggleReaction(\'' + targetType + '\',\'' + targetId + '\',\'' + emoji + '\')" style="background:var(--selected-bg);border:1px solid var(--border);border-radius:12px;padding:1px 8px;cursor:pointer;font-size:12px" title="' + title + '">' + emoji + ' ' + users.length + '</button>';
    }).join(' ');
    if (!_ctx.readOnly) {
      html += ' <button onclick="IssueRenderer.showEmojiPicker(\'' + targetType + '\',\'' + targetId + '\')" style="background:none;border:1px solid var(--border);border-radius:12px;padding:1px 6px;cursor:pointer;font-size:12px" title="Add reaction">+</button>';
    }
    return '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' + html + '</div>';
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
    var readOnly = _ctx.readOnly;
    var openIssueHref = buildIssuePageHref({ issueId: issue.id, projectId: issue.project_id, issueNumber: issue.number });
    var openIssueAttrs = '';

    var labels = issue.labels ? issue.labels.split(',').filter(function(l) { return l.trim(); }).map(function(l) { return labelHtml(l); }).join(' ') : '';
    var assignOpts = '<option value="">Unassigned</option><option value="all" ' + ('all'===issue.assigned_to?'selected':'') + '>All</option><option value="user" ' + ('user'===issue.assigned_to?'selected':'') + '>User</option>' +
      agents.map(function(a) { return '<option value="' + a.id + '" ' + (a.id===issue.assigned_to?'selected':'') + '>' + esc(a.name) + '</option>'; }).join('');

    // Build timeline: events + comments
    var allEntries = issue.comments || [];
    var timeline = allEntries.map(function(c) {
      var entryDate = c.created_at ? new Date(c.created_at + (c.created_at.includes('Z') ? '' : 'Z')).toLocaleString() : '';
      if (c.event_type !== 'comment') {
        var icon = c.event_type === 'status_change' ? '🔄' : c.event_type === 'assignment' ? '👤' : '🏷️';
        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0 8px 40px;font-size:12px;color:var(--text-secondary)">' +
          '<span>' + icon + '</span>' +
          '<span><strong>' + esc(nameOf(c.author_id)) + '</strong> ' + esc(c.body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, function(id) { return nameOf(id); })) + ' <span title="' + esc(entryDate) + '" style="cursor:default">' + timeAgo(c.created_at) + '</span></span>' +
        '</div>';
      }
      return '<div class="timeline-item">' +
        '<div class="timeline-avatar" style="background:none;border:none">' + authorAvatarHtml(c.author_id, 24) + '</div>' +
        '<div class="timeline-comment">' +
          '<div class="timeline-comment-header" style="display:flex;justify-content:space-between;align-items:center">' +
            '<span><strong>' + esc(nameOf(c.author_id)) + '</strong> commented <span title="' + esc(entryDate) + '" style="cursor:default">' + timeAgo(c.created_at) + '</span></span>' +
            '<span style="display:flex;gap:4px">' +
              (c.author_id === 'user' ? '<button onclick="IssueRenderer.editComment(\'' + c.id + '\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">edit</button><button onclick="IssueRenderer.deleteComment(\'' + c.id + '\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">delete</button>' : '') +
            '</span>' +
          '</div>' +
          '<div class="timeline-comment-body markdown-body" id="ir-comment-body-' + c.id + '">' + renderMd(c.body, c.author_id) + '</div>' +
          reactionBar('comment', c.id, c.reactions) +
        '</div>' +
      '</div>';
    }).join('');

    var commentCount = allEntries.filter(function(c) { return c.event_type === 'comment'; }).length;

    container.innerHTML =
      '<div style="margin-bottom:16px">' +
        '<div style="display:flex;align-items:flex-start;gap:8px" id="ir-title-display">' +
          '<h2 style="flex:1;font-size:22px;font-weight:600">' + esc(issue.title) + ' <span style="color:var(--text-secondary);font-weight:400">#' + issue.number + '</span></h2>' +
          (readOnly
            ? '<span class="meta-chip meta-chip-remote" title="Remote issue mirrored into the local inbox">Remote read-only</span>'
            : '<button class="btn btn-sm" onclick="IssueRenderer.startEditTitle()">Edit</button>' +
              (openIssueHref
                ? '<a href="' + esc(openIssueHref) + '" class="btn btn-sm" title="Open in a new page" style="text-decoration:none"' + openIssueAttrs + '>↗</a>'
                : '')) +
        '</div>' +
        '<div id="ir-title-edit" style="display:none;margin-bottom:8px">' +
          '<div style="display:flex;gap:8px">' +
            '<input type="text" id="ir-edit-title-input" style="flex:1;padding:6px 10px;font-size:16px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg)">' +
            '<button class="btn btn-sm btn-primary" onclick="IssueRenderer.saveTitle()">Save</button>' +
            '<button class="btn btn-sm" onclick="IssueRenderer.cancelEditTitle()">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px">' +
          statusIcon(issue.status) +
          '<span style="font-weight:500">' + issue.status.replace('_',' ') + '</span>' +
          priorityBadge(issue.priority) + ' ' + labels +
          '<span style="color:var(--text-secondary)">' + esc(nameOf(issue.created_by)) + ' opened ' + timeAgo(issue.created_at) + ' · ' + commentCount + ' comments</span>' +
        '</div>' +
      '</div>' +

      '<div class="issue-detail-layout">' +
        '<div class="issue-detail-main">' +
          '<div class="issue-body">' +
            '<div class="issue-body-header" style="display:flex;justify-content:space-between;align-items:center">' +
              '<span style="display:flex;align-items:center;gap:6px">' + authorAvatarHtml(issue.created_by, 20) + ' <strong>' + esc(nameOf(issue.created_by)) + '</strong></span>' +
              (readOnly ? '<span style="font-size:11px;color:var(--text-secondary)">Remote mirror</span>' : '<button onclick="IssueRenderer.startEditBody()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">edit</button>') +
            '</div>' +
            '<div class="issue-body-content" id="ir-body-display">' +
              '<div class="markdown-body">' + renderMd(issue.body, issue.created_by) + '</div>' +
              reactionBar('issue', issue.id, issue.reactions) +
            '</div>' +
            '<div id="ir-body-edit" style="display:none;padding:12px">' +
              '<textarea id="ir-edit-body-input" rows="8" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:13px;font-family:inherit;resize:vertical"></textarea>' +
              '<div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">' +
                '<button class="btn btn-sm" onclick="IssueRenderer.cancelEditBody()">Cancel</button>' +
                '<button class="btn btn-sm btn-primary" onclick="IssueRenderer.saveBody()">Save</button>' +
              '</div>' +
            '</div>' +
          '</div>' +

          (timeline ? '<div class="timeline">' + timeline + '</div>' : '') +

          (readOnly
            ? '<div class="comment-box" style="margin-top:16px"><div style="font-size:12px;color:var(--text-secondary)">Remote issues are currently read-only inside the local dashboard.</div></div>'
            : '<div class="comment-box" style="margin-top:16px">' +
                '<textarea id="ir-comment-input" placeholder="Leave a comment... (Markdown supported)"></textarea>' +
                '<div class="comment-box-footer" style="display:flex;justify-content:space-between;align-items:center">' +
                  '<span style="font-size:11px;color:var(--text-secondary)">Markdown · #N auto-links · @agent-name to mention</span>' +
                  '<div style="display:flex;gap:8px;align-items:center">' +
                    (issue.status !== 'closed' && issue.status !== 'done'
                      ? '<button class="btn btn-sm" id="ir-close-issue-btn" onclick="IssueRenderer.closeWithComment()" style="color:var(--error);border-color:var(--error)">Close issue</button>'
                      : '<button class="btn btn-sm" id="ir-reopen-issue-btn" onclick="IssueRenderer.reopenWithComment()" style="color:var(--success);border-color:var(--success)">Reopen issue</button>') +
                    '<button class="btn btn-sm btn-primary" onclick="IssueRenderer.addComment()">Comment</button>' +
                  '</div>' +
                '</div>' +
              '</div>') +
        '</div>' +

        '<div class="issue-detail-sidebar">' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Status</div>' +
            (readOnly
              ? '<div style="font-size:12px;color:var(--fg)">' + esc(issue.status.replace('_', ' ')) + '</div>'
              : '<select id="ir-detail-status" onchange="IssueRenderer.updateField(\'status\',this.value)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">' +
                  '<option value="open" ' + (issue.status==='open'?'selected':'') + '>Open</option>' +
                  '<option value="in_progress" ' + (issue.status==='in_progress'?'selected':'') + '>In Progress</option>' +
                  '<option value="pending" ' + (issue.status==='pending'?'selected':'') + '>Pending</option>' +
                  '<option value="done" ' + (issue.status==='done'?'selected':'') + '>Done</option>' +
                  '<option value="closed" ' + (issue.status==='closed'?'selected':'') + '>Closed</option>' +
                '</select>') +
          '</div>' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Assignee</div>' +
            (readOnly
              ? '<div style="font-size:12px;color:var(--fg)">' + esc(nameOf(issue.assigned_to || '')) + '</div>'
              : '<select id="ir-detail-assign" onchange="IssueRenderer.updateField(\'assigned_to\',this.value||null)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">' +
                  assignOpts +
                '</select>') +
          '</div>' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Labels</div>' +
            (readOnly
              ? '<div style="font-size:12px;color:var(--fg)">' + (labels || '<span style="color:var(--text-secondary)">No labels</span>') + '</div>'
              : '<input type="text" id="ir-detail-labels" value="' + esc(issue.labels||'') + '" placeholder="bug, feature" onchange="IssueRenderer.updateField(\'labels\',this.value)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">') +
          '</div>' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Priority</div>' +
            priorityBadge(issue.priority) +
          '</div>' +
          (issue.parent_id && issue.parent_number ?
            '<div class="sidebar-section">' +
              '<div class="sidebar-section-title">Parent Issue</div>' +
              (readOnly
                ? '<div style="font-size:12px;display:flex;align-items:center;gap:4px">' + statusIcon(issue.parent_status || 'open') + ' #' + issue.parent_number + ' ' + esc(issue.parent_title || '') + '</div>'
                : '<a href="' + buildIssuePageHref({ issueId: issue.parent_id, projectId: issue.project_id, issueNumber: issue.parent_number }) + '" style="font-size:12px;text-decoration:none;display:flex;align-items:center;gap:4px">' +
                    statusIcon(issue.parent_status || 'open') + ' #' + issue.parent_number + ' ' + esc(issue.parent_title || '') +
                  '</a>') +
            '</div>' : '') +
          (issue.children && issue.children.length > 0 ? (function() {
            var done = issue.children.filter(function(c) { return c.status === 'done' || c.status === 'closed'; }).length;
            var total = issue.children.length;
            var pct = Math.round(done / total * 100);
            return '<div class="sidebar-section">' +
              '<div class="sidebar-section-title">Child Issues (' + done + '/' + total + ' done)</div>' +
              '<div style="background:var(--border);border-radius:4px;height:6px;margin-bottom:8px;overflow:hidden">' +
                '<div style="background:var(--success);height:100%;width:' + pct + '%;transition:width 0.3s"></div>' +
              '</div>' +
              issue.children.map(function(c) {
                return readOnly
                  ? '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;color:inherit;font-size:12px">' + statusIcon(c.status) + ' <span>#' + c.number + ' ' + esc(c.title) + '</span></div>'
                  : '<a href="' + buildIssuePageHref({ issueId: c.id, projectId: c.project_id || issue.project_id, issueNumber: c.number }) + '" style="display:flex;align-items:center;gap:6px;padding:3px 0;text-decoration:none;color:inherit;font-size:12px">' +
                      statusIcon(c.status) + ' <span>#' + c.number + ' ' + esc(c.title) + '</span></a>';
              }).join('') +
            '</div>';
          })() : '') +
          // ─── Dependencies / Relations ───
          (function() {
            var blocks = issue.blocks || [];
            var blocked_by = issue.blocked_by || [];
            var related_to = issue.related_to || [];
            if (blocks.length === 0 && blocked_by.length === 0 && related_to.length === 0 && !issue.is_blocked) {
              // Show add button even if no relations
              return '<div class="sidebar-section">' +
                '<div class="sidebar-section-title">Dependencies</div>' +
                '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">No dependencies</div>' +
                (readOnly ? '' : '<button class="btn btn-sm" onclick="IssueRenderer.showAddRelation()" style="font-size:11px;width:100%">+ Add dependency</button>') +
              '</div>';
            }
            var html = '<div class="sidebar-section">';
            html += '<div class="sidebar-section-title">Dependencies';
            if (issue.is_blocked) html += ' <span style="color:var(--error);font-size:10px;font-weight:600;background:var(--error)18;padding:1px 6px;border-radius:8px;margin-left:4px">BLOCKED</span>';
            html += '</div>';
            if (blocked_by.length > 0) {
              html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px;font-weight:600">Blocked by</div>';
              blocked_by.forEach(function(r) {
                var st = r.status || r.source_status || 'open';
                var resolved = (st === 'done' || st === 'closed');
                html += '<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px' + (resolved ? ';color:var(--text-secondary)' : '') + '">' +
                  statusIcon(st) +
                  ' ' + (readOnly
                    ? '<span style="' + (resolved ? 'color:var(--text-secondary);text-decoration:line-through' : 'color:inherit') + ';flex:1">#' + (r.number || r.source_number) + ' ' + esc(r.title || r.source_title || '') + '</span>'
                  : '<a href="' + buildIssuePageHref({ issueId: r.source_issue_id || r.id, projectId: r.project_id || issue.project_id, issueNumber: r.number || r.source_number }) + '" style="text-decoration:none;' + (resolved ? 'color:var(--text-secondary);text-decoration:line-through' : 'color:inherit') + ';flex:1">#' + (r.number || r.source_number) + ' ' + esc(r.title || r.source_title || '') + '</a>') +
                  (resolved ? '<span style="font-size:10px;color:var(--text-secondary);background:var(--bg-secondary);padding:0 4px;border-radius:4px;white-space:nowrap">Resolved</span>' : '') +
                  (readOnly ? '' : '<button onclick="IssueRenderer.removeRelation(\'' + r.relation_id + '\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:10px" title="Remove">✕</button>') +
                '</div>';
              });
            }
            if (blocks.length > 0) {
              html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px;margin-top:4px;font-weight:600">Blocks</div>';
              blocks.forEach(function(r) {
                html += '<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px">' +
                  statusIcon(r.status || r.target_status || 'open') +
                  ' ' + (readOnly
                    ? '<span style="color:inherit;flex:1">#' + (r.number || r.target_number) + ' ' + esc(r.title || r.target_title || '') + '</span>'
                    : '<a href="' + buildIssuePageHref({ issueId: r.target_issue_id || r.id, projectId: r.project_id || issue.project_id, issueNumber: r.number || r.target_number }) + '" style="text-decoration:none;color:inherit;flex:1">#' + (r.number || r.target_number) + ' ' + esc(r.title || r.target_title || '') + '</a>') +
                  (readOnly ? '' : '<button onclick="IssueRenderer.removeRelation(\'' + r.relation_id + '\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:10px" title="Remove">✕</button>') +
                '</div>';
              });
            }
            if (related_to.length > 0) {
              html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px;margin-top:4px;font-weight:600">Related to</div>';
              related_to.forEach(function(r) {
                var num = r.number || r.target_number || r.source_number;
                var title = r.title || r.target_title || r.source_title || '';
                var st = r.status || r.target_status || r.source_status || 'open';
                html += '<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px">' +
                  statusIcon(st) +
                  ' ' + (readOnly
                    ? '<span style="color:inherit;flex:1">#' + num + ' ' + esc(title) + '</span>'
                    : '<a href="' + buildIssuePageHref({ issueId: r.target_issue_id || r.source_issue_id || r.id, projectId: r.project_id || issue.project_id, issueNumber: num }) + '" style="text-decoration:none;color:inherit;flex:1">#' + num + ' ' + esc(title) + '</a>') +
                  (readOnly ? '' : '<button onclick="IssueRenderer.removeRelation(\'' + r.relation_id + '\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:10px" title="Remove">✕</button>') +
                '</div>';
              });
            }
            if (!readOnly) html += '<button class="btn btn-sm" onclick="IssueRenderer.showAddRelation()" style="font-size:11px;width:100%;margin-top:6px">+ Add dependency</button>';
            html += '</div>';
            return html;
          })() +

          (!readOnly && issue.status === 'open' ? '<div style="margin-top:12px"><button class="btn btn-sm btn-danger" onclick="IssueRenderer.deleteIssue()">Delete</button></div>' : '') +
        '</div>' +
      '</div>';

    // Setup @mention autocomplete
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
    el.innerHTML = '<textarea id="ir-edit-comment-' + cid + '" rows="4" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:13px;font-family:inherit">' + esc(c.body) + '</textarea>' +
      '<div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">' +
        '<button class="btn btn-sm" onclick="IssueRenderer._ctx.reload()">Cancel</button>' +
        '<button class="btn btn-sm btn-primary" onclick="IssueRenderer.saveComment(\'' + cid + '\')">Save</button>' +
      '</div>';
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
    var div = document.createElement('div');
    div.id = 'ir-add-relation-dialog';
    div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--header-bg);border:1px solid var(--border);border-radius:8px;padding:16px;z-index:200;box-shadow:0 4px 12px rgba(0,0,0,0.3);min-width:300px';
    div.innerHTML =
      '<div style="font-weight:600;margin-bottom:12px">Add Dependency</div>' +
      '<div style="margin-bottom:8px"><label style="font-size:12px;color:var(--text-secondary)">Type</label>' +
        '<select id="ir-rel-type" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px;margin-top:2px">' +
          '<option value="blocks">This issue blocks...</option>' +
          '<option value="blocked_by">This issue is blocked by...</option>' +
          '<option value="related_to">Related to...</option>' +
        '</select></div>' +
      '<div style="margin-bottom:12px"><label style="font-size:12px;color:var(--text-secondary)">Issue number (e.g. 42)</label>' +
        '<input type="text" id="ir-rel-target" placeholder="#" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px;margin-top:2px"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="btn btn-sm" onclick="document.getElementById(\'ir-add-relation-dialog\').remove()">Cancel</button>' +
        '<button class="btn btn-sm btn-primary" onclick="IssueRenderer.addRelation()">Add</button>' +
      '</div>';
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
    // On project page: switch to Files tab directly
    if (typeof switchTab === 'function') {
      // Switch agent in files panel if agentId is provided
      if (targetAgentId && typeof handleProjectFilesAgentChange === 'function') {
        handleProjectFilesAgentChange(targetAgentId);
        var sel = document.getElementById('project-files-agent');
        if (sel) sel.value = targetAgentId;
      }
      switchTab('files');
      // setAgent() is synchronous; call openFile immediately.
      // If agent is ready it fetches directly; otherwise pendingFile handles retry.
      var panel = window.ProjectFiles;
      if (panel && typeof panel.openFile === 'function') {
        panel.openFile(filePath);
      }
      return;
    }
    // On dashboard/other pages: navigate to the project page's Files tab
    var projectId = _ctx.issue && _ctx.issue.project_id;
    if (projectId) {
      var url = buildProjectPageHref(projectId) + '#files?file=' + encodeURIComponent(filePath);
      if (targetAgentId) url += '&agent=' + encodeURIComponent(targetAgentId);
      window.open(url, '_blank');
    }
  }

  function showEmojiPicker(type, id) {
    var picker = EMOJIS.map(function(e) { return '<span onclick="IssueRenderer.toggleReaction(\'' + type + '\',\'' + id + '\',\'' + e + '\')" style="cursor:pointer;font-size:18px;padding:2px">' + e + '</span>'; }).join('');
    var el = document.getElementById('ir-emoji-picker');
    if (el) { el.remove(); return; }
    var div = document.createElement('div');
    div.id = 'ir-emoji-picker';
    div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--header-bg);border:1px solid var(--border);border-radius:8px;padding:12px;z-index:200;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
    div.innerHTML = picker + '<div style="text-align:center;margin-top:8px"><button class="btn btn-sm" onclick="this.parentElement.parentElement.remove()">Close</button></div>';
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
