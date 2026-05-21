let _workflowData = null;
let _workflowApprovalsData = [];

async function loadWorkflowTab() {
  await Promise.all([loadWorkflowGraph(), loadWorkflowApprovals()]);
  await Promise.all([loadTreasuryWorkflowLayer(), loadWorkflowActivity()]);
}

async function loadWorkflowGraph() {
  const container = document.getElementById('workflow-graph-svg');
  if (!container) return;
  try {
    const res = await fetch(projectApiPath('/workflow-status'), { headers: apiHeaders() });
    if (!res.ok) throw new Error('failed');
    _workflowData = await res.json();
    renderWorkflowGraph(container, _workflowData);
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load workflow status.</div>';
  }
}

async function loadTreasuryWorkflowLayer() {
  var container = document.getElementById('treasury-workflow-layer');
  if (!container) return;
  if (!window.HAICOTreasuryWorkflow || typeof window.HAICOTreasuryWorkflow.render !== 'function') {
    container.innerHTML = '<div class="empty-state">Treasury workflow layer unavailable.</div>';
    return;
  }

  try {
    if (!_workflowData) {
      await loadWorkflowGraph();
    }
    const activeIssues = await getProjectActiveIssues({ force: true });
    const model = window.HAICOTreasuryWorkflow.buildModel({
      project: projectData,
      workflow: _workflowData,
      approvals: _workflowApprovalsData,
      activeIssues: activeIssues,
    });
    container.innerHTML = window.HAICOTreasuryWorkflow.render(model);
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load treasury workflow layer.</div>';
  }
}

function renderWorkflowGraph(container, data) {
  if (!data || !data.agents || data.agents.length === 0) {
    container.innerHTML = '<div class="empty-state">No agents configured.</div>';
    return;
  }

  renderWorkflowGraphHierarchy(container, data);
}

function renderWorkflowGraphHierarchy(container, data) {
  const agents = data.agents;
  const byId = {};
  agents.forEach(function(a) { byId[a.id] = a; });

  // Build children map
  var childrenMap = {};
  agents.forEach(function(a) {
    var pid = a.parent_agent_id;
    if (pid && byId[pid]) {
      if (!childrenMap[pid]) childrenMap[pid] = [];
      childrenMap[pid].push(a);
    }
  });

  // Identify roots
  var roots = agents.filter(function(a) {
    return !a.parent_agent_id || !byId[a.parent_agent_id];
  });

  // Build subtree sizes
  var subtreeSize = {};
  function calcSize(agent) {
    if (subtreeSize[agent.id] !== undefined) return subtreeSize[agent.id];
    var children = childrenMap[agent.id] || [];
    var size = children.length === 0 ? 1 : children.reduce(function(sum, c) { return sum + calcSize(c); }, 0);
    subtreeSize[agent.id] = size;
    return size;
  }
  roots.forEach(function(r) { calcSize(r); });

  // Walk tree to assign depth levels
  var visited = {};
  var depthMap = {};
  function walk(agent, depth) {
    if (!agent || visited[agent.id]) return;
    visited[agent.id] = true;
    depthMap[agent.id] = depth;
    (childrenMap[agent.id] || []).forEach(function(child) { walk(child, depth + 1); });
  }
  roots.forEach(function(root) { walk(root, 0); });
  agents.forEach(function(agent) {
    if (!visited[agent.id]) walk(agent, 0);
  });

  var maxDepth = 0;
  agents.forEach(function(a) {
    if ((depthMap[a.id] || 0) > maxDepth) maxDepth = depthMap[a.id];
  });

  var W = Math.min(Math.max(container.clientWidth || 760, 640), 960);
  var levelGap = 112;
  var topPadding = 56;
  var H = Math.max(280, topPadding + maxDepth * levelGap + 96);
  var nodeH = 40;
  var positions = {};

  // Position nodes using subtree sizes
  var totalLeaves = roots.reduce(function(sum, r) { return sum + (subtreeSize[r.id] || 1); }, 0);
  var leafWidth = W / (totalLeaves + 1);
  var leafCounter = 0;

  function positionSubtree(agent, depth) {
    var children = childrenMap[agent.id] || [];
    var y = topPadding + depth * levelGap;
    if (children.length === 0) {
      leafCounter++;
      positions[agent.id] = { x: leafCounter * leafWidth, y: y };
    } else {
      children.forEach(function(child) { positionSubtree(child, depth + 1); });
      var childPositions = children.map(function(c) { return positions[c.id]; }).filter(Boolean);
      var minX = Math.min.apply(null, childPositions.map(function(p) { return p.x; }));
      var maxX = Math.max.apply(null, childPositions.map(function(p) { return p.x; }));
      positions[agent.id] = { x: (minX + maxX) / 2, y: y };
    }
  }
  roots.forEach(function(root) { positionSubtree(root, 0); });

  var svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;margin:0 auto">';

  // Draw hierarchy edges (parent -> child)
  agents.forEach(function(agent) {
    var pid = agent.parent_agent_id;
    if (!pid || !byId[pid]) return;
    var parentPos = positions[pid];
    var childPos = positions[agent.id];
    if (!parentPos || !childPos) return;
    svg += '<line x1="' + parentPos.x + '" y1="' + (parentPos.y + nodeH / 2) + '" x2="' + childPos.x + '" y2="' + (childPos.y - nodeH / 2) + '" stroke="var(--border)" stroke-width="1.2" opacity="0.7"/>';
  });

  // Draw message edges
  if (data.recent_messages && data.recent_messages.length > 0) {
    var msgEdges = {};
    data.recent_messages.forEach(function(m) {
      var key = m.from_agent_id + '->' + m.to_agent_id;
      msgEdges[key] = (msgEdges[key] || 0) + 1;
    });
    Object.keys(msgEdges).forEach(function(key) {
      var parts = key.split('->');
      var from = positions[parts[0]];
      var to = positions[parts[1]];
      if (from && to) {
        svg += '<line x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" stroke="var(--accent)" stroke-width="1.5" opacity="0.4" stroke-dasharray="6,3"/>';
        var dx = to.x - from.x;
        var dy = to.y - from.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          var mx = from.x + dx * 0.65;
          var my = from.y + dy * 0.65;
          svg += '<circle cx="' + mx + '" cy="' + my + '" r="3" fill="var(--accent)" opacity="0.6"/>';
        }
      }
    });
  }

  // Draw nodes
  agents.forEach(function(agent) {
    var pos = positions[agent.id];
    if (!pos) return;
    var color = getWorkflowStatusColor(agent);
    var nw = Math.max(70, agent.name.length * 7.5 + 20);
    var pulse = agent.status === 'running'
      ? '<animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite"/>'
      : '';
    var issues = agent.current_issues || [];
    var issueCount = issues.length;
    var topIssue = issues[0];
    var statusLabel = agent.paused ? 'paused' : agent.status;
    var metaParts = [statusLabel, issueCount > 0 ? issueCount + ' issues' : null].filter(Boolean).join(' \u00b7 ');

    svg += '<g style="cursor:pointer" onclick="viewAgent(\'' + agent.id + '\')">';
    svg += '<rect x="' + (pos.x - nw / 2) + '" y="' + (pos.y - nodeH / 2) + '" width="' + nw + '" height="' + nodeH + '" rx="8" fill="' + color + '22" stroke="' + color + '" stroke-width="' + (agent.is_controller ? '2.8' : '2') + '"' + (agent.paused ? ' stroke-dasharray="4,4"' : '') + '>' + pulse + '</rect>';
    svg += '<text x="' + pos.x + '" y="' + (pos.y - 2) + '" text-anchor="middle" fill="var(--fg)" font-size="11" font-weight="600">' + esc(agent.name) + '</text>';
    svg += '<text x="' + pos.x + '" y="' + (pos.y + 12) + '" text-anchor="middle" fill="' + color + '" font-size="8.5">' + esc(metaParts) + '</text>';
    if (topIssue) {
      svg += '<text x="' + pos.x + '" y="' + (pos.y + nodeH / 2 + 12) + '" text-anchor="middle" fill="var(--accent)" font-size="8">#' + topIssue.number + (issueCount > 1 ? ' +' + (issueCount - 1) : '') + '</text>';
    }
    svg += '</g>';
  });

  // Pending approvals indicator
  if (data.pending_approvals && data.pending_approvals.length > 0) {
    svg += '<text x="' + (W - 10) + '" y="20" text-anchor="end" fill="var(--warning)" font-size="11" font-weight="600">\u26a0 ' + data.pending_approvals.length + ' pending approval(s)</text>';
  }

  svg += '</svg>';

  // Summary line
  var summary = '<div style="text-align:center;font-size:11px;color:var(--text-secondary);margin-top:8px">';
  summary += agents.length + ' agents \u00b7 ' + data.total_active_issues + ' active issues';
  if (data.recent_messages && data.recent_messages.length > 0) {
    summary += ' \u00b7 ' + data.recent_messages.length + ' recent messages';
  }
  summary += '</div>';
  container.innerHTML = svg + summary;
}

function getWorkflowStatusColor(agent) {
  if (agent.status === 'running') return 'var(--warning)';
  if (agent.status === 'error') return 'var(--error)';
  if (agent.status === 'waiting') return 'var(--accent)';
  return 'var(--success)';
}

async function loadWorkflowActivity() {
  var container = document.getElementById('workflow-activity-timeline');
  if (!container) return;
  try {
    var res = await fetch(projectApiPath('/activity') + '?limit=30', { headers: apiHeaders() });
    if (!res.ok) throw new Error('failed');
    var events = await res.json();
    if (!events.length) { container.innerHTML = '<div class="empty-state">No activity yet.</div>'; return; }

    container.innerHTML = events.map(function(e) {
      var time = timeAgo(e.time);
      if (e.event_type === 'issue') {
        var icon = e.status === 'open' ? '<span style="color:var(--success)">\u25cf</span>' : '<span style="color:var(--accent)">\u2713</span>';
        return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          icon + '<div><strong>' + esc(nameOf(e.actor)) + '</strong> ' + (e.status === 'open' ? 'opened' : 'updated') + ' <a href="' + buildIssuePageHref({ issueId: e.id, projectId: e.project_id, issueNumber: e.number }) + '" style="color:var(--link)">#' + e.number + '</a> ' + esc(e.title) + ' <span style="color:var(--text-secondary)">' + time + '</span></div></div>';
      } else if (e.event_type === 'comment') {
        return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          '<span style="color:var(--text-secondary)">\ud83d\udcac</span><div><strong>' + esc(nameOf(e.actor)) + '</strong> commented on <a href="' + buildIssuePageHref({ issueId: e.id, projectId: e.project_id, issueNumber: e.issue_number }) + '" style="color:var(--link)">#' + e.issue_number + '</a> ' + esc(e.issue_title) + ' <span style="color:var(--text-secondary)">' + time + '</span></div></div>';
      } else if (e.event_type === 'agent_run') {
        var statusColor = e.agent_status === 'running' ? 'var(--success)' : (e.agent_status === 'error' ? 'var(--error)' : 'var(--text-secondary)');
        return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          '<span style="color:' + statusColor + '">\u26a1</span><div>Agent <strong>' + esc(e.name) + '</strong> [' + e.agent_status + '] <span style="color:var(--text-secondary)">' + time + '</span></div></div>';
      }
      return '';
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load activity.</div>';
  }
}

// ─── Approval Requests (#616) ───

async function loadWorkflowApprovals() {
  var panel = document.getElementById('workflow-approvals-container');
  var listEl = document.getElementById('workflow-approvals-list');
  var countEl = document.getElementById('workflow-approval-count');
  if (!panel || !listEl) return;

  try {
    var res = await fetch(projectApiPath('/approvals') + '?status=pending', { headers: apiHeaders() });
    if (!res.ok) throw new Error('failed');
    var approvals = await res.json();
    _workflowApprovalsData = Array.isArray(approvals) ? approvals : [];

    if (approvals.length === 0) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = '';
    if (countEl) { countEl.textContent = approvals.length; countEl.style.display = ''; }

    listEl.innerHTML = approvals.map(function(a) {
      var riskColors = { low: 'var(--success)', medium: 'var(--warning)', high: 'var(--error)', critical: 'var(--error)' };
      var riskColor = riskColors[a.risk_level] || 'var(--warning)';
      return '<div class="approval-card" style="border:1px solid ' + riskColor + '44;border-left:3px solid ' + riskColor + ';border-radius:6px;padding:10px 12px;margin-bottom:8px;background:' + riskColor + '08">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">' +
          '<div><strong style="font-size:13px">' + esc(a.title) + '</strong>' +
          '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">Agent: ' + esc(a.agent_name || 'unknown') + ' \u00b7 Risk: <span style="color:' + riskColor + ';font-weight:600">' + a.risk_level + '</span> \u00b7 ' + timeAgo(a.created_at) + '</div></div>' +
        '</div>' +
        (a.description ? '<div style="font-size:12px;color:var(--fg);margin-bottom:8px">' + esc(a.description) + '</div>' : '') +
        '<div style="display:flex;gap:6px">' +
          '<button class="btn btn-sm btn-primary" onclick="decideApproval(\'' + a.id + '\', \'approved\')">Approve</button>' +
          '<button class="btn btn-sm btn-danger" onclick="decideApproval(\'' + a.id + '\', \'rejected\')">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    _workflowApprovalsData = [];
    panel.style.display = 'none';
  }
}

async function decideApproval(approvalId, decision) {
  var note = '';
  if (decision === 'rejected') {
    note = prompt('Reason for rejection (optional):') || '';
  }
  try {
    var res = await fetch(buildApprovalApiPath(approvalId), {
      method: 'PUT',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: decision, decision_note: note, decided_by: 'user' })
    });
    if (res.ok) {
      showToast('Approval ' + decision, 'success');
      loadWorkflowApprovals();
    } else {
      var err = await res.json();
      showToast(err.error || 'Failed', 'error');
    }
  } catch (e) {
    showToast('Failed to submit decision', 'error');
  }
}

window.decideApproval = decideApproval;

function viewAgent(agentId) { window.location.href = projectPagePath("agents") + "?agent=" + encodeURIComponent(agentId); }

(async function initWorkflowPage(){
  await loadProjectShell();
  await loadWorkflowTab();
  const events = connectProjectEvents(projectId);
  events.on("agent_status", () => { loadWorkflowGraph(); loadTreasuryWorkflowLayer(); });
  events.on("issue_created", () => { loadWorkflowGraph(); loadWorkflowActivity(); loadTreasuryWorkflowLayer(); });
  events.on("issue_updated", () => { loadWorkflowGraph(); loadWorkflowActivity(); loadTreasuryWorkflowLayer(); });
  events.on("approval_created", () => { loadWorkflowApprovals(); loadTreasuryWorkflowLayer(); });
  events.on("approval_decided", () => { loadWorkflowApprovals(); loadTreasuryWorkflowLayer(); });
})();
