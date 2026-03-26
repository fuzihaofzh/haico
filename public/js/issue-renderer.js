// ─── Shared Issue Renderer ───
// Used by both issue.js (full page) and dashboard.js (floating panel)

var IssueRenderer = (function() {
  var EMOJIS = ['👍','👎','❤️','🎉','😕','🚀'];

  // Current rendering context
  var _ctx = {
    issue: null,
    agents: [],
    container: null,
    reload: null,
    onAfterAction: null,
  };

  function nameOf(id) {
    if (id === 'user') return 'User';
    if (id === 'all') return 'All';
    var a = _ctx.agents.find(function(x) { return x.id === id; });
    if (a) return a.name;
    return (id || '').slice(0, 8);
  }

  function renderMd(text) {
    if (!text) return '';
    var agents = _ctx.agents;
    var issue = _ctx.issue;

    // Protect LaTeX blocks from markdown processing
    var latexBlocks = [];
    var processed = text;
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
      return issue && issue.project_id ? '[#' + n + '](/projects/' + issue.project_id + '/issues/' + n + ')' : m;
    });

    var html = '';
    if (typeof marked !== 'undefined') {
      try { html = marked.parse(processed); } catch(e) { html = '<pre style="white-space:pre-wrap">' + esc(text) + '</pre>'; }
    } else {
      html = '<pre style="white-space:pre-wrap">' + esc(text) + '</pre>';
    }

    // Highlight @mentions
    var agentNames = agents.map(function(a) { return a.name; });
    html = html.replace(/@([\w-]+)/g, function(m, name) {
      var isAgent = agentNames.includes(name);
      return '<span style="color:' + (isAgent ? '#61afef' : '#e5c07b') + ';font-weight:500;background:' + (isAgent ? '#61afef18' : '#e5c07b18') + ';padding:0 4px;border-radius:3px">' + m + '</span>';
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
    return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function reactionBar(targetType, targetId, reactions) {
    var grouped = {};
    (reactions || []).forEach(function(r) { if (!grouped[r.emoji]) grouped[r.emoji] = []; grouped[r.emoji].push(r.user_id); });
    var html = Object.entries(grouped).map(function(entry) {
      var emoji = entry[0], users = entry[1];
      var title = users.map(function(u) { return nameOf(u); }).join(', ');
      return '<button onclick="IssueRenderer.toggleReaction(\'' + targetType + '\',\'' + targetId + '\',\'' + emoji + '\')" style="background:var(--selected-bg);border:1px solid var(--border);border-radius:12px;padding:1px 8px;cursor:pointer;font-size:12px" title="' + title + '">' + emoji + ' ' + users.length + '</button>';
    }).join(' ');
    html += ' <button onclick="IssueRenderer.showEmojiPicker(\'' + targetType + '\',\'' + targetId + '\')" style="background:none;border:1px solid var(--border);border-radius:12px;padding:1px 6px;cursor:pointer;font-size:12px" title="Add reaction">+</button>';
    return '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' + html + '</div>';
  }

  // ─── Main render function ───
  function render(issue, agents, container, options) {
    options = options || {};
    _ctx.issue = issue;
    _ctx.agents = agents || [];
    _ctx.container = container;
    _ctx.reload = options.reload || function() {};
    _ctx.onAfterAction = options.onAfterAction || function() {};

    var labels = issue.labels ? issue.labels.split(',').filter(function(l) { return l.trim(); }).map(function(l) { return labelHtml(l); }).join(' ') : '';
    var assignOpts = '<option value="">Unassigned</option><option value="all" ' + ('all'===issue.assigned_to?'selected':'') + '>All</option><option value="user" ' + ('user'===issue.assigned_to?'selected':'') + '>User</option>' +
      agents.map(function(a) { return '<option value="' + a.id + '" ' + (a.id===issue.assigned_to?'selected':'') + '>' + esc(a.name) + '</option>'; }).join('');

    // Build timeline: events + comments
    var allEntries = issue.comments || [];
    var timeline = allEntries.map(function(c) {
      if (c.event_type !== 'comment') {
        var icon = c.event_type === 'status_change' ? '🔄' : c.event_type === 'assignment' ? '👤' : '🏷️';
        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0 8px 40px;font-size:12px;color:var(--text-secondary)">' +
          '<span>' + icon + '</span>' +
          '<span><strong>' + esc(nameOf(c.author_id)) + '</strong> ' + esc(c.body) + ' ' + timeAgo(c.created_at) + '</span>' +
        '</div>';
      }
      return '<div class="timeline-item">' +
        '<div class="timeline-avatar" style="background:none;border:none">' + avatarSvg(nameOf(c.author_id), 24) + '</div>' +
        '<div class="timeline-comment">' +
          '<div class="timeline-comment-header" style="display:flex;justify-content:space-between;align-items:center">' +
            '<span><strong>' + esc(nameOf(c.author_id)) + '</strong> commented ' + timeAgo(c.created_at) + '</span>' +
            '<span style="display:flex;gap:4px">' +
              (c.author_id === 'user' ? '<button onclick="IssueRenderer.editComment(\'' + c.id + '\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">edit</button><button onclick="IssueRenderer.deleteComment(\'' + c.id + '\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">delete</button>' : '') +
            '</span>' +
          '</div>' +
          '<div class="timeline-comment-body markdown-body" id="ir-comment-body-' + c.id + '">' + renderMd(c.body) + '</div>' +
          reactionBar('comment', c.id, c.reactions) +
        '</div>' +
      '</div>';
    }).join('');

    var commentCount = allEntries.filter(function(c) { return c.event_type === 'comment'; }).length;

    container.innerHTML =
      '<div style="margin-bottom:16px">' +
        '<div style="display:flex;align-items:flex-start;gap:8px" id="ir-title-display">' +
          '<h2 style="flex:1;font-size:22px;font-weight:600">' + esc(issue.title) + ' <span style="color:var(--text-secondary);font-weight:400">#' + issue.number + '</span></h2>' +
          '<button class="btn btn-sm" onclick="IssueRenderer.startEditTitle()">Edit</button>' +
          '<a href="/projects/' + issue.project_id + '/issues/' + issue.number + '" class="btn btn-sm" title="在新页面打开" style="text-decoration:none">↗</a>' +
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
              '<span style="display:flex;align-items:center;gap:6px">' + avatarSvg(nameOf(issue.created_by), 20) + ' <strong>' + esc(nameOf(issue.created_by)) + '</strong></span>' +
              '<button onclick="IssueRenderer.startEditBody()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px">edit</button>' +
            '</div>' +
            '<div class="issue-body-content" id="ir-body-display">' +
              '<div class="markdown-body">' + renderMd(issue.body) + '</div>' +
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

          '<div class="comment-box" style="margin-top:16px">' +
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
          '</div>' +
        '</div>' +

        '<div class="issue-detail-sidebar">' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Status</div>' +
            '<select id="ir-detail-status" onchange="IssueRenderer.updateField(\'status\',this.value)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">' +
              '<option value="open" ' + (issue.status==='open'?'selected':'') + '>Open</option>' +
              '<option value="in_progress" ' + (issue.status==='in_progress'?'selected':'') + '>In Progress</option>' +
              '<option value="pending" ' + (issue.status==='pending'?'selected':'') + '>Pending</option>' +
              '<option value="done" ' + (issue.status==='done'?'selected':'') + '>Done</option>' +
              '<option value="closed" ' + (issue.status==='closed'?'selected':'') + '>Closed</option>' +
            '</select>' +
          '</div>' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Assignee</div>' +
            '<select id="ir-detail-assign" onchange="IssueRenderer.updateField(\'assigned_to\',this.value||null)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">' +
              assignOpts +
            '</select>' +
          '</div>' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Labels</div>' +
            '<input type="text" id="ir-detail-labels" value="' + esc(issue.labels||'') + '" placeholder="bug, feature" onchange="IssueRenderer.updateField(\'labels\',this.value)" style="width:100%;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px">' +
          '</div>' +
          '<div class="sidebar-section">' +
            '<div class="sidebar-section-title">Priority</div>' +
            priorityBadge(issue.priority) +
          '</div>' +
          (issue.status === 'open' ? '<div style="margin-top:12px"><button class="btn btn-sm btn-danger" onclick="IssueRenderer.deleteIssue()">Delete</button></div>' : '') +
        '</div>' +
      '</div>';

    // Setup @mention autocomplete
    var commentInput = document.getElementById('ir-comment-input');
    if (commentInput && typeof setupMentionAutocomplete === 'function') {
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
    var v = document.getElementById('ir-edit-title-input').value.trim();
    if (!v) return;
    fetch('/api/issues/' + _ctx.issue.id, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ title: v, actor: 'user' }) })
      .then(function() { _ctx.reload(); });
  }
  function startEditBody() {
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
    var v = document.getElementById('ir-edit-body-input').value;
    fetch('/api/issues/' + _ctx.issue.id, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ body: v, actor: 'user' }) })
      .then(function() { _ctx.reload(); });
  }

  // ─── Actions ───

  function updateField(field, value) {
    var body = {}; body[field] = value; body.actor = 'user';
    fetch('/api/issues/' + _ctx.issue.id, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) })
      .then(function() { _ctx.reload(); _ctx.onAfterAction(); });
  }

  function deleteIssue() {
    if (!confirm('Delete this issue?')) return;
    fetch('/api/issues/' + _ctx.issue.id, { method: 'DELETE' })
      .then(function(res) {
        if (res.ok) { showToast('Issue已删除', 'success'); history.back(); }
        else showToast('只能删除open状态的issue', 'error');
      });
  }

  function closeWithComment() {
    var body = document.getElementById('ir-comment-input').value.trim();
    var p = Promise.resolve();
    if (body) {
      p = fetch('/api/issues/' + _ctx.issue.id + '/comments', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ author_id: 'user', body: body }) });
    }
    p.then(function() {
      return fetch('/api/issues/' + _ctx.issue.id, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: 'closed', actor: 'user' }) });
    }).then(function() {
      showToast(body ? '评论已添加并关闭Issue' : 'Issue已关闭', 'success');
      _ctx.reload();
      _ctx.onAfterAction();
    });
  }

  function reopenWithComment() {
    var body = document.getElementById('ir-comment-input').value.trim();
    var p = Promise.resolve();
    if (body) {
      p = fetch('/api/issues/' + _ctx.issue.id + '/comments', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ author_id: 'user', body: body }) });
    }
    p.then(function() {
      return fetch('/api/issues/' + _ctx.issue.id, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ status: 'open', actor: 'user' }) });
    }).then(function() {
      showToast(body ? '评论已添加并重新打开Issue' : 'Issue已重新打开', 'success');
      _ctx.reload();
      _ctx.onAfterAction();
    });
  }

  function addComment() {
    var body = document.getElementById('ir-comment-input').value.trim();
    if (!body) return;
    fetch('/api/issues/' + _ctx.issue.id + '/comments', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ author_id: 'user', body: body }) })
      .then(function(res) { if (res.ok) showToast('评论已添加', 'success'); _ctx.reload(); });
  }

  function editComment(cid) {
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
    var v = document.getElementById('ir-edit-comment-' + cid);
    if (!v || !v.value) return;
    fetch('/api/comments/' + cid, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ body: v.value }) })
      .then(function(res) { if (res.ok) showToast('评论已保存', 'success'); _ctx.reload(); });
  }

  function deleteComment(cid) {
    if (!confirm('Delete this comment?')) return;
    fetch('/api/comments/' + cid, { method: 'DELETE' })
      .then(function() { _ctx.reload(); });
  }

  function toggleReaction(type, id, emoji) {
    fetch('/api/reactions/' + type + '/' + id, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ user_id: 'user', emoji: emoji }) })
      .then(function() { _ctx.reload(); });
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

  return {
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
    _ctx: _ctx,
  };
})();
