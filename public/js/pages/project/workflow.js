let _workflowData = null;

function cloneWorkflowTemplate(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function setWorkflowText(root, slotName, value) {
  var node = root.querySelector('[data-slot="' + slotName + '"]');
  if (node) node.textContent = value == null ? '' : String(value);
}

async function loadWorkflowTab() {
  await Promise.all([loadWorkflowGraph()]);
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
    container.innerHTML = h`<div class="empty-state">Failed to load workflow status.</div>`;
  }
}

async function loadTreasuryWorkflowLayer() {
  var container = document.getElementById('treasury-workflow-layer');
  if (!container) return;
  if (!window.HAICOTreasuryWorkflow || typeof window.HAICOTreasuryWorkflow.render !== 'function') {
    container.innerHTML = h`<div class="empty-state">Treasury workflow layer unavailable.</div>`;
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
      approvals: [],
      activeIssues: activeIssues,
    });
    container.innerHTML = window.HAICOTreasuryWorkflow.render(model);
  } catch (e) {
    container.innerHTML = h`<div class="empty-state">Failed to load treasury workflow layer.</div>`;
  }
}

function renderWorkflowGraph(container, data) {
  if (!data || !data.agents || data.agents.length === 0) {
    container.innerHTML = h`<div class="empty-state">No agents configured.</div>`;
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

  var svg = createWorkflowSvg('svg', {
    width: W,
    height: H,
    viewBox: '0 0 ' + W + ' ' + H,
    style: 'display:block;margin:0 auto',
  });

  // Draw hierarchy edges (parent -> child)
  agents.forEach(function(agent) {
    var pid = agent.parent_agent_id;
    if (!pid || !byId[pid]) return;
    var parentPos = positions[pid];
    var childPos = positions[agent.id];
    if (!parentPos || !childPos) return;
    svg.appendChild(createWorkflowSvg('line', {
      x1: parentPos.x,
      y1: parentPos.y + nodeH / 2,
      x2: childPos.x,
      y2: childPos.y - nodeH / 2,
      stroke: 'var(--border)',
      'stroke-width': '1.2',
      opacity: '0.7',
    }));
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
        svg.appendChild(createWorkflowSvg('line', {
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          stroke: 'var(--accent)',
          'stroke-width': '1.5',
          opacity: '0.4',
          'stroke-dasharray': '6,3',
        }));
        var dx = to.x - from.x;
        var dy = to.y - from.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          var mx = from.x + dx * 0.65;
          var my = from.y + dy * 0.65;
          svg.appendChild(createWorkflowSvg('circle', {
            cx: mx,
            cy: my,
            r: '3',
            fill: 'var(--accent)',
            opacity: '0.6',
          }));
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
    var issues = agent.current_issues || [];
    var issueCount = issues.length;
    var topIssue = issues[0];
    var statusLabel = agent.paused ? 'paused' : agent.status;
    var metaParts = [statusLabel, issueCount > 0 ? issueCount + ' issues' : null].filter(Boolean).join(' \u00b7 ');

    var group = createWorkflowSvg('g', { style: 'cursor:pointer' });
    group.addEventListener('click', function() { viewAgent(agent.id); });
    var rectAttrs = {
      x: pos.x - nw / 2,
      y: pos.y - nodeH / 2,
      width: nw,
      height: nodeH,
      rx: '8',
      fill: color + '22',
      stroke: color,
      'stroke-width': agent.is_controller ? '2.8' : '2',
    };
    if (agent.paused) rectAttrs['stroke-dasharray'] = '4,4';
    var rect = createWorkflowSvg('rect', rectAttrs);
    if (agent.status === 'running') {
      rect.appendChild(createWorkflowSvg('animate', {
        attributeName: 'opacity',
        values: '1;0.6;1',
        dur: '2s',
        repeatCount: 'indefinite',
      }));
    }
    group.appendChild(rect);
    group.appendChild(createWorkflowText(pos.x, pos.y - 2, agent.name, {
      'text-anchor': 'middle',
      fill: 'var(--fg)',
      'font-size': '11',
      'font-weight': '600',
    }));
    group.appendChild(createWorkflowText(pos.x, pos.y + 12, metaParts, {
      'text-anchor': 'middle',
      fill: color,
      'font-size': '8.5',
    }));
    if (topIssue) {
      group.appendChild(createWorkflowText(pos.x, pos.y + nodeH / 2 + 12, '#' + topIssue.number + (issueCount > 1 ? ' +' + (issueCount - 1) : ''), {
        'text-anchor': 'middle',
        fill: 'var(--accent)',
        'font-size': '8',
      }));
    }
    svg.appendChild(group);
  });

  var summary = cloneWorkflowTemplate('tmpl-workflow-graph-summary');
  var summaryText = agents.length + ' agents \u00b7 ' + data.total_active_issues + ' active issues';
  if (data.recent_messages && data.recent_messages.length > 0) {
    summaryText += ' \u00b7 ' + data.recent_messages.length + ' recent messages';
  }
  summary.textContent = summaryText;
  container.replaceChildren(svg, summary);
}

function createWorkflowSvg(tagName, attrs) {
  var node = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  Object.keys(attrs || {}).forEach(function(name) {
    node.setAttribute(name, String(attrs[name]));
  });
  return node;
}

function createWorkflowText(x, y, text, attrs) {
  var node = createWorkflowSvg('text', Object.assign({ x: x, y: y }, attrs || {}));
  node.textContent = text == null ? '' : String(text);
  return node;
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
    if (!events.length) { container.innerHTML = h`<div class="empty-state">No activity yet.</div>`; return; }

    container.replaceChildren(...events.map(renderWorkflowActivityEvent).filter(Boolean));
  } catch (e) {
    container.innerHTML = h`<div class="empty-state">Failed to load activity.</div>`;
  }
}

function renderWorkflowActivityEvent(event) {
  var row = cloneWorkflowTemplate('tmpl-workflow-activity-item');
  var icon = row.querySelector('[data-slot="icon"]');
  var link = row.querySelector('[data-slot="issue-link"]');
  var actorPrefix = row.querySelector('[data-slot="actor-prefix"]');
  var agentPrefix = row.querySelector('[data-slot="agent-prefix"]');
  var time = timeAgo(event.time);

  if (event.event_type === 'issue') {
    icon.textContent = event.status === 'open' ? '\u25cf' : '\u2713';
    icon.style.color = event.status === 'open' ? 'var(--success)' : 'var(--accent)';
    setWorkflowText(row, 'actor', nameOf(event.actor));
    setWorkflowText(row, 'action', event.status === 'open' ? 'opened' : 'updated');
    link.href = buildIssuePageHref({ issueId: event.id, projectId: event.project_id, issueNumber: event.number });
    link.textContent = '#' + event.number;
    setWorkflowText(row, 'title', event.title);
    setWorkflowText(row, 'time', time);
    agentPrefix.remove();
    return row;
  }

  if (event.event_type === 'comment') {
    icon.textContent = '\ud83d\udcac';
    icon.style.color = 'var(--text-secondary)';
    setWorkflowText(row, 'actor', nameOf(event.actor));
    setWorkflowText(row, 'action', 'commented on');
    link.href = buildIssuePageHref({ issueId: event.id, projectId: event.project_id, issueNumber: event.issue_number });
    link.textContent = '#' + event.issue_number;
    setWorkflowText(row, 'title', event.issue_title);
    setWorkflowText(row, 'time', time);
    agentPrefix.remove();
    return row;
  }

  if (event.event_type === 'agent_run') {
    var statusColor = event.agent_status === 'running' ? 'var(--success)' : (event.agent_status === 'error' ? 'var(--error)' : 'var(--text-secondary)');
    icon.textContent = '\u26a1';
    icon.style.color = statusColor;
    setWorkflowText(row, 'agent-name', event.name);
    setWorkflowText(row, 'agent-status', '[' + event.agent_status + ']');
    setWorkflowText(row, 'time', time);
    actorPrefix.remove();
    link.remove();
    row.querySelector('[data-slot="title"]').remove();
    return row;
  }

  return null;
}

// ─── Approval Requests (#616) ───

function viewAgent(agentId) { window.location.href = projectPagePath("agents") + "?agent=" + encodeURIComponent(agentId); }

(async function initWorkflowPage(){
  await loadProjectShell();
  await loadWorkflowTab();
  const events = connectProjectEvents(projectId);
  events.on("agent_status", () => { loadWorkflowGraph(); loadTreasuryWorkflowLayer(); });
  events.on("issue_created", () => { loadWorkflowGraph(); loadWorkflowActivity(); loadTreasuryWorkflowLayer(); });
  events.on("issue_updated", () => { loadWorkflowGraph(); loadWorkflowActivity(); loadTreasuryWorkflowLayer(); });
})();
