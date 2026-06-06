import { initDashboardPage, setupDashboardWS } from './dashboard-core.js';

let _usagePeriod = 'day';
const _projectColors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#39d2c0','#ff7b72','#79c0ff','#7ee787','#e3b341'];
let _costAlertDismissed = false;
const COST_ALERT_THRESHOLD = parseFloat(localStorage.getItem('haico-cost-threshold') || '10');

function switchUsagePeriod(period) {
  _usagePeriod = period;
  document.querySelectorAll('.usage-period-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === period);
  });
  loadUsageByProject();
}

async function loadUsageByProject() {
  const panel = document.getElementById('usage-by-project-panel');
  const container = document.getElementById('usage-by-project-chart');
  if (!panel || !container) return;

  try {
    const res = await fetch(`/api/dashboard/usage-by-project?period=${_usagePeriod}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const emptyPeriodLabel = {
      hour: 'this hour',
      day: 'today',
      week: 'this week',
      month: 'this month',
    }[_usagePeriod] || 'this period';

    if (!data.time_buckets || !data.time_buckets.length || !data.projects || !data.projects.length) {
      panel.style.display = '';
      container.innerHTML = h`<div class="empty-state" style="padding:32px 12px;text-align:center">
        <div style="font-size:14px;font-weight:600;margin-bottom:6px">No usage data for ${emptyPeriodLabel}.</div>
        <div style="font-size:12px;color:var(--text-secondary)">Usage and cost metrics will appear here after agents record activity. Try a broader period if you expected older data.</div>
      </div>`;
      return;
    }
    panel.style.display = '';

    const projects = data.projects;
    const buckets = data.time_buckets;
    const chartData = data.data;

    // Calculate max stacked cost per bucket
    let maxCost = 0.001;
    for (const t of buckets) {
      let sum = 0;
      for (const p of projects) {
        sum += (chartData[t] && chartData[t][p.id]) ? chartData[t][p.id].cost : 0;
      }
      if (sum > maxCost) maxCost = sum;
    }

    const W = 600, H = 200;
    const PAD_L = 50, PAD_R = 16, PAD_T = 12, PAD_B = 32;
    const cw = W - PAD_L - PAD_R, ch = H - PAD_T - PAD_B;
    const n = buckets.length;
    const barW = Math.max(2, (cw / n) * 0.7);
    const gap = cw / n;

    // Y-axis
    const yLabels = [0, maxCost / 2, maxCost].map(v => {
      const y = PAD_T + ch - (v / maxCost) * ch;
      return h`<text x="${PAD_L - 6}" y="${y + 3}" text-anchor="end" fill="var(--text-secondary)" font-size="9">$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}</text>
      <line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="var(--border)" stroke-width="0.5" opacity="0.5"/>`;
    }).join('');

    // X-axis
    const step = Math.max(1, Math.floor(n / 6));
    const xLabels = buckets.map((d, i) => {
      if (i % step !== 0 && i !== n - 1) return '';
      const x = PAD_L + i * gap + gap / 2;
      const label = d.length > 10 ? d.slice(5) : d.slice(5);
      return h`<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--text-secondary)" font-size="8">${label}</text>`;
    }).join('');

    // Stacked bars
    let bars = '';
    for (let i = 0; i < n; i++) {
      const t = buckets[i];
      const x = PAD_L + i * gap + (gap - barW) / 2;
      let yOffset = 0;
      for (let j = 0; j < projects.length; j++) {
        const p = projects[j];
        const entry = chartData[t] && chartData[t][p.id];
        const cost = entry ? entry.cost : 0;
        if (cost <= 0) continue;
        const barH = (cost / maxCost) * ch;
        const y = PAD_T + ch - yOffset - barH;
        const color = _projectColors[j % _projectColors.length];
        bars += h`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" opacity="0.85" rx="1">
          <title>${p.name} ${t}: $${cost.toFixed(4)}</title>
        </rect>`;
        yOffset += barH;
      }
    }

    // Legend
    const legend = projects.map((p, i) => {
      const color = _projectColors[i % _projectColors.length];
      const name = p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name;
      return h`<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary)">
        <span style="width:10px;height:10px;background:${color};border-radius:2px;display:inline-block"></span>${name}
      </span>`;
    }).join('');

    container.innerHTML = h`<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">
      ${html(yLabels)}${html(xLabels)}${html(bars)}
    </svg>
    <div style="margin-top:6px;line-height:1.8">${html(legend)}</div>`;
  } catch (e) {
    console.error('Failed to load usage by project', e);
    panel.style.display = '';
    container.innerHTML = renderError(e, 'loadUsageByProject()');
  }
}

async function checkCostAlert() {
  if (_costAlertDismissed) return;
  try {
    const res = await fetch('/api/dashboard/today-cost', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const banner = document.getElementById('cost-alert-banner');
    const text = document.getElementById('cost-alert-text');
    if (!banner || !text) return;

    if (data.today_cost_usd > COST_ALERT_THRESHOLD) {
      var projectBreakdown = Object.values(data.by_project).map(function(p) {
        return p.name + ': $' + p.cost.toFixed(2);
      }).join(', ');
      text.textContent = "Today's spending: $" + data.today_cost_usd.toFixed(2) + ' (threshold: $' + COST_ALERT_THRESHOLD.toFixed(2) + ')' + (projectBreakdown ? ' — ' + projectBreakdown : '');
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  } catch (e) {
    console.error('Failed to check cost alert', e);
  }
}

function dismissCostAlert() {
  _costAlertDismissed = true;
  var banner = document.getElementById('cost-alert-banner');
  if (banner) banner.style.display = 'none';
}

function bindUsageEvents() {
  document.body.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'usage-period') {
      switchUsagePeriod(actionEl.dataset.period || 'day');
    } else if (action === 'dismiss-cost-alert') {
      dismissCostAlert();
    }
  });
}

async function refreshUsagePage() {
  await Promise.all([loadUsageByProject(), checkCostAlert()]);
}

function startUsagePolling() {
  return setInterval(refreshUsagePage, 60000);
}

async function initUsagePage() {
  bindUsageEvents();
  await initDashboardPage('usage');
  await refreshUsagePage();
  startUsagePolling();
  setupDashboardWS(refreshUsagePage);
}

initUsagePage().catch((error) => {
  console.error('Failed to initialize usage dashboard', error);
});
