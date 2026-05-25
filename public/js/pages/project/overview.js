function updateProjectCostSummary(cost) {
  const costContainer = document.getElementById('project-cost');
  const costValue = document.getElementById('project-cost-value');
  if (!costContainer || !costValue) return;

  if (cost && (cost.total_cost_usd > 0 || cost.total_input_tokens > 0 || cost.total_output_tokens > 0)) {
    costContainer.style.display = '';
    const costText = cost.total_cost_usd > 0 ? `$${cost.total_cost_usd.toFixed(4)}` : 'Cost unavailable';
    costValue.textContent = `${costText} (${cost.total_input_tokens} in / ${cost.total_output_tokens} out)`;
    return;
  }

  costContainer.style.display = 'none';
  costValue.textContent = '';
}

async function hydrateProjectCommandProfileControls(commandTemplate, commandType, commandProfileId) {
  const select = document.getElementById('project-cmd-profile');
  const input = document.getElementById('project-cmd');
  if (!select || !input) return;

  const profiles = await populateCommandProfileSelect(select, {
    includeProjectDefault: false,
    includeCustom: false,
    emptyLabel: 'No Agent Tools configured - open Settings first',
  });
  setCommandProfileSelection(select, commandTemplate, commandType, commandProfileId);

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  input.value = selectedProfile?.command || String(commandTemplate || '').trim();
  input.dataset.commandType = selectedProfile?.type || commandType || '';
  select.disabled = !canManageProject() || (profiles.length === 0 && !input.value);
  updateCommandPreview('project-cmd-preview', input.value, input.dataset.commandType, 'Choose an Agent Tool configured in Settings.', select.value);
}

function handleProjectCommandProfileChange() {
  const select = document.getElementById('project-cmd-profile');
  const input = document.getElementById('project-cmd');
  if (!select || !input) return;

  const manager = getCommandProfileManager();
  const selectedProfile = manager?.getById(select.value) || null;
  if (selectedProfile) {
    input.value = selectedProfile.command || '';
    input.dataset.commandType = selectedProfile.type || '';
  }
  updateCommandPreview('project-cmd-preview', input.value, input.dataset.commandType, 'Choose an Agent Tool configured in Settings.', select.value);
}

function buildProjectCommandConfigPayload() {
  return buildSelectedCommandConfig('project-cmd-profile', 'project-cmd');
}

function selectProjectColor(color) {
  const colorInput = document.getElementById('project-color');
  if (colorInput) colorInput.value = color;
  document.querySelectorAll('#project-color-picker .color-swatch').forEach(el => {
    el.style.border = el.dataset.color === color ? '3px solid var(--fg)' : '3px solid transparent';
    el.classList.toggle('selected', el.dataset.color === color);
  });
}

function hydrateOverviewFields() {
  const fields = ['project-name-edit', 'project-desc-edit', 'project-task', 'project-cmd', 'project-cmd-profile'];
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !canManageProject();
  });

  document.getElementById('project-name-edit').value = projectData.name;
  document.getElementById('project-desc-edit').value = projectData.description || '';
  document.getElementById('project-task').value = projectData.task_description || '';
  document.getElementById('project-cmd').value = projectData.command_template || '';
  document.getElementById('project-cmd').dataset.commandType = projectData.command_type || '';
  document.getElementById('project-created').textContent = formatLocalDateTime(projectData.created_at);

  hydrateProjectCommandProfileControls(projectData.command_template, projectData.command_type, projectData.command_profile_id).catch((error) => {
    console.error('Failed to hydrate project command profile controls', error);
  });

  const colorPicker = document.getElementById('project-color-picker');
  const colorInput = document.getElementById('project-color');
  if (colorPicker && colorInput) {
    const currentColor = projectData.color || '#4A90E2';
    colorInput.value = currentColor;
    colorPicker.innerHTML = PROJECT_COLORS.map(c =>
      `<span class="color-swatch${c === currentColor ? ' selected' : ''}" data-color="${c}" style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${c === currentColor ? 'var(--fg)' : 'transparent'};display:inline-block" onclick="selectProjectColor('${c}')"></span>`
    ).join('');
  }

  const overviewReadonlyHint = document.getElementById('project-overview-readonly-hint');
  if (overviewReadonlyHint) {
    overviewReadonlyHint.style.display = canManageProject() ? 'none' : '';
    overviewReadonlyHint.textContent = canManageProject() ? '' : 'Shared members can view the project overview, but project settings and sharing are read-only.';
  }
}

async function saveOverview() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to update project settings', 'error'); return; }
  const commandConfig = buildProjectCommandConfigPayload();
  const body = {
    name: document.getElementById('project-name-edit').value.trim(),
    description: document.getElementById('project-desc-edit').value.trim(),
    task_description: document.getElementById('project-task').value.trim(),
    ...commandConfig,
    color: document.getElementById('project-color')?.value || '#4A90E2',
  };
  if (!body.name) { showToast('Name cannot be empty', 'error'); return; }
  if (!body.task_description) { showToast('Task description cannot be empty', 'error'); return; }
  if (!body.command_template) { showToast('Select an Agent Tool in Settings before saving', 'error'); return; }
  const btn = document.querySelector('button[onclick="saveOverview()"]');
  await withLoading(btn, async () => {
    const res = await fetch(projectApiPath(''), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) {
      await loadProjectShell();
      hydrateOverviewFields();
      showToast('Saved', 'success');
    }
    else showToast('Failed to save', 'error');
  });
}

async function loadDashboard(options) {
  const el = document.getElementById('project-dashboard');
  if (!el) return;
  try {
    const opts = options || {};
    const [agents, issueCounts, cost] = await Promise.all([
      Array.isArray(opts.agents) ? opts.agents : getProjectAgents(),
      opts.issueCounts || getProjectIssueCounts(),
      Object.prototype.hasOwnProperty.call(opts, 'cost') ? opts.cost : getProjectCostSummary().catch(() => null),
    ]);
    agentsData = agents;

    const running = agents.filter(a => a.status === 'running').length;
    const errors = agents.filter(a => a.status === 'error').length;
    const paused = agents.filter(a => a.paused).length;
    const openIssues = (issueCounts.open || 0) + (issueCounts.in_progress || 0);
    const doneIssues = (issueCounts.done || 0) + (issueCounts.closed || 0);
    const totalIssues = issueCounts.total || 0;
    const fmtCostOverview = v => !v ? '$0' : v < 0.01 ? '<$0.01' : '$' + v.toFixed(2);
    const fmtTokensOverview = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;
    const card = (label, value, color, sub) => `
      <div style="padding:12px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:4px">${label}</div>
        <div style="font-size:22px;font-weight:700;color:${color || 'var(--fg)'}">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${sub}</div>` : ''}
      </div>`;

    const costValue = cost?.total_cost_usd > 0 ? fmtCostOverview(cost.total_cost_usd) : (cost?.total_input_tokens > 0 ? fmtTokensOverview(cost.total_input_tokens) + '↑' + fmtTokensOverview(cost.total_output_tokens) + '↓' : '$0');
    const costLabel = cost?.total_cost_usd > 0 ? 'Total Cost' : (cost?.total_input_tokens > 0 ? 'Token Usage' : 'Total Cost');

    el.innerHTML =
      card('Agents', `${running}/${agents.length}`, running > 0 ? 'var(--success)' : 'var(--fg)',
        `${errors > 0 ? `<span style="color:var(--error)">${errors} error</span>` : ''}${paused > 0 ? ` <span style="color:var(--warning)">${paused} paused</span>` : ''}`) +
      card('Open Issues', openIssues, openIssues > 0 ? 'var(--warning)' : 'var(--fg)', `${doneIssues} completed`) +
      card(costLabel, costValue, 'var(--accent)', cost ? `${cost.total_runs || 0} runs` : '') +
      card('Issues Progress', totalIssues > 0 ? Math.round(doneIssues / totalIssues * 100) + '%' : '-', 'var(--fg)', `${doneIssues}/${totalIssues} total`);
  } catch { el.innerHTML = ''; }
}

const _agentColors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#39d2c0','#ff7b72','#79c0ff','#7ee787','#e3b341'];
let _currentCostPeriod = 'hour';

function switchCostPeriod(period) {
  _currentCostPeriod = period;
  document.querySelectorAll('.cost-period-btn').forEach(b => {
    b.style.background = b.dataset.period === period ? 'var(--accent)' : '';
    b.style.color = b.dataset.period === period ? '#fff' : '';
  });
  loadCostChart();
}

async function loadCostChart() {
  try {
    const res = await fetch(`${projectApiPath('/costs')}?period=${_currentCostPeriod}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const panel = document.getElementById('cost-chart-panel');
    if (!data.time_series || data.time_series.length === 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    document.querySelectorAll('.cost-period-btn').forEach(b => {
      b.style.background = b.dataset.period === _currentCostPeriod ? 'var(--accent)' : '';
      b.style.color = b.dataset.period === _currentCostPeriod ? '#fff' : '';
    });

    const allAgentNames = new Set();
    if (data.time_series_by_agent) Object.keys(data.time_series_by_agent).forEach(n => allAgentNames.add(n));
    if (data.by_agent) Object.keys(data.by_agent).forEach(n => allAgentNames.add(n));
    const colorMap = {};
    [...allAgentNames].sort().forEach((name, i) => { colorMap[name] = _agentColors[i % _agentColors.length]; });

    const agentsEl = document.getElementById('cost-chart-agents');
    if (data.time_series_by_agent && Object.keys(data.time_series_by_agent).length > 0) {
      agentsEl.innerHTML = renderStackedBarChart(Object.entries(data.time_series_by_agent), data.time_series, 600, 200, colorMap);
    } else {
      agentsEl.innerHTML = '';
    }
    renderAgentCostComparison(data.by_agent || {}, colorMap);
  } catch {}
}

function renderAgentCostComparison(byAgent, colorMap) {
  const el = document.getElementById('cost-agent-comparison');
  if (!el) return;
  const entries = Object.entries(byAgent).filter(([, v]) => v.cost > 0 || v.input_tokens > 0 || v.output_tokens > 0).sort((a, b) => b[1].cost - a[1].cost);
  if (entries.length === 0) { el.innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">No data</div>'; return; }
  const totalCost = entries.reduce((s, [, v]) => s + v.cost, 0);
  const hasCost = totalCost > 0;
  const totalTokens = entries.reduce((s, [, v]) => s + (v.input_tokens || 0) + (v.output_tokens || 0), 0);
  const metric = hasCost ? (v) => v.cost : (v) => (v.input_tokens || 0) + (v.output_tokens || 0);
  const maxMetric = Math.max(...entries.map(([, v]) => metric(v)), 1);
  const totalMetric = hasCost ? totalCost : totalTokens;
  const fmtTokensComp = v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v;

  el.innerHTML = entries.map(([name, v], idx) => {
    const val = metric(v);
    const pct = totalMetric > 0 ? (val / totalMetric * 100).toFixed(1) : '0';
    const barWidth = maxMetric > 0 ? (val / maxMetric * 100).toFixed(1) : '0';
    const color = (colorMap && colorMap[name]) || _agentColors[idx % _agentColors.length];
    const label = hasCost ? ('$' + (v.cost < 0.01 ? v.cost.toFixed(4) : v.cost.toFixed(2))) : (fmtTokensComp((v.input_tokens||0)+(v.output_tokens||0)) + ' tokens');
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="width:120px;font-size:11px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(name)}">${esc(name)}</div>
      <div style="flex:1;height:18px;background:var(--bg);border:1px solid var(--border);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${barWidth}%;background:${color};opacity:0.8;border-radius:3px;transition:width 0.3s"></div>
      </div>
      <div style="width:80px;font-size:11px;color:var(--text-secondary);text-align:right">${label}</div>
      <div style="width:40px;font-size:10px;color:var(--text-secondary);text-align:right">${pct}%</div>
    </div>`;
  }).join('') +
  `<div style="margin-top:8px;font-size:12px;color:var(--fg);font-weight:600">Total: ${hasCost ? '$' + (totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)) : fmtTokensComp(totalTokens) + ' tokens'}</div>`;
}

function renderStackedBarChart(agents, totalSeries, width, height, colorMap) {
  const PAD_L = 50, PAD_R = 16, PAD_T = 12, PAD_B = 32;
  const W = width, H = height;
  const cw = W - PAD_L - PAD_R, ch = H - PAD_T - PAD_B;
  const allDates = totalSeries.map(d => d.period_start);
  const n = allDates.length;
  const maxCost = Math.max(...totalSeries.map(d => d.cost), 0.001);
  const barW = Math.max(2, (cw / n) * 0.7);
  const gap = cw / n;
  const yLabels = [0, maxCost / 2, maxCost].map(v => {
    const y = PAD_T + ch - (v / maxCost) * ch;
    return `<text x="${PAD_L - 6}" y="${y + 3}" text-anchor="end" fill="var(--text-secondary)" font-size="9">$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}</text>
    <line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="var(--border)" stroke-width="0.5" opacity="0.5"/>`;
  }).join('');
  const step = Math.max(1, Math.floor(n / 6));
  const xLabels = allDates.map((d, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    const x = PAD_L + i * gap + gap / 2;
    return `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--text-secondary)" font-size="8">${d.slice(5)}</text>`;
  }).join('');
  const agentDateMaps = agents.map(([, series]) => {
    const m = {};
    series.forEach(d => { m[d.period_start] = d; });
    return m;
  });
  let bars = '';
  allDates.forEach((date, i) => {
    const x = PAD_L + i * gap + (gap - barW) / 2;
    let yOffset = 0;
    agents.forEach(([agentName], idx) => {
      const cost = agentDateMaps[idx][date]?.cost || 0;
      if (cost <= 0) return;
      const barH = (cost / maxCost) * ch;
      const y = PAD_T + ch - yOffset - barH;
      const color = (colorMap && colorMap[agentName]) || _agentColors[idx % _agentColors.length];
      const runs = agentDateMaps[idx][date]?.runs || 0;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" opacity="0.85" rx="1">
        <title>${agentName} ${date}: $${cost.toFixed(4)} (${runs} runs)</title>
      </rect>`;
      yOffset += barH;
    });
  });
  const legend = agents.map(([name], idx) => {
    const color = (colorMap && colorMap[name]) || _agentColors[idx % _agentColors.length];
    return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary)">
      <span style="width:10px;height:10px;background:${color};border-radius:2px;display:inline-block"></span>${name.length > 15 ? name.slice(0, 14) + '...' : name}
    </span>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">${yLabels}${xLabels}${bars}</svg>
  <div style="margin-top:6px;line-height:1.8">${legend}</div>`;
}

(async function initOverviewPage() {
  await loadProjectShell();
  hydrateOverviewFields();
  const cost = await getProjectCostSummary().catch(() => null);
  updateProjectCostSummary(cost);
  await Promise.all([loadDashboard({ cost }), loadCostChart()]);
  const events = connectProjectEvents(projectId);
  events.on('agent_status', () => loadDashboard());
  events.on('issue_created', () => loadDashboard());
  events.on('issue_updated', () => loadDashboard());
})();
