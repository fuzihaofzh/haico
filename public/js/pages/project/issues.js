let currentIssueFilter = 'open';
let currentIssuePage = 1;

// Restore filter/search state from URL params
(function restoreIssueFilterState() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('status')) currentIssueFilter = params.get('status');
  if (params.has('page')) currentIssuePage = parseInt(params.get('page')) || 1;
  if (params.has('q')) {
    setTimeout(() => {
      const el = document.getElementById('issue-search');
      if (el) el.value = params.get('q');
    }, 0);
  }
})();

function updateIssueUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const q = document.getElementById('issue-search')?.value?.trim() || '';
  if (currentIssueFilter) params.set('status', currentIssueFilter); else params.delete('status');
  if (q) params.set('q', q); else params.delete('q');
  if (currentIssuePage > 1) params.set('page', currentIssuePage); else params.delete('page');
  const newUrl = params.toString() ? `${window.location.pathname}?${params}${window.location.hash}` : `${window.location.pathname}${window.location.hash}`;
  history.replaceState(null, '', newUrl);
}

function renderActiveFilters() {
  const el = document.getElementById('issue-active-filters');
  if (!el) return;
  const q = document.getElementById('issue-search')?.value?.trim() || '';
  const chips = [];
  if (currentIssueFilter) {
    chips.push(h`<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--selected-bg);border-radius:4px;font-size:11px">Status: ${currentIssueFilter} <span onclick="clearIssueFilter()" style="cursor:pointer;opacity:0.6;font-weight:bold" title="Clear">&times;</span></span>`);
  }
  if (q) {
    chips.push(h`<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--selected-bg);border-radius:4px;font-size:11px">Search: "${q}" <span onclick="clearIssueSearch()" style="cursor:pointer;opacity:0.6;font-weight:bold" title="Clear">&times;</span></span>`);
  }
  if (chips.length > 1) {
    chips.push(h`<span onclick="clearAllIssueFilters()" style="cursor:pointer;color:var(--accent);font-size:11px;text-decoration:underline">Clear all filters</span>`);
  }
  el.style.display = chips.length ? 'flex' : 'none';
  el.innerHTML = chips.join('');
}

function clearIssueFilter() { currentIssueFilter = ''; currentIssuePage = 1; loadIssues(); }
function clearIssueSearch() {
  const el = document.getElementById('issue-search');
  if (el) el.value = '';
  currentIssuePage = 1;
  loadIssues();
}
function clearAllIssueFilters() {
  currentIssueFilter = '';
  const el = document.getElementById('issue-search');
  if (el) el.value = '';
  currentIssuePage = 1;
  loadIssues();
}

const LABEL_COLORS = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#b5bd68','#cc6666','#8abeb7'];
function issueLabelHtml(text) {
  const hash = hashCode(text.trim());
  const bg = LABEL_COLORS[hash % LABEL_COLORS.length];
  return h`<span style="font-size:10px;padding:1px 6px;border-radius:12px;background:${bg}22;color:${bg};border:1px solid ${bg}44">${text.trim()}</span>`;
}

async function loadIssues() {
  const sort = document.getElementById('issue-sort')?.value || 'priority';
  const q = document.getElementById('issue-search')?.value?.trim() || '';

  // Fetch counts via lightweight endpoint
  const countsRes = await fetch(projectApiPath('/issues/counts'), { headers: apiHeaders() });
  const counts = await countsRes.json();
  issueCount = counts.total || 0;
  updateTabCounts();

  // Filter tabs
  const tabs = document.getElementById('issue-filter-tabs');
  if (tabs) {
    const filters = [
      { key: 'open', label: 'Open', count: counts.open, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#3fb950" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#3fb950"/>' },
      { key: 'in_progress', label: 'In Progress', count: counts.in_progress, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#d29922"/>' },
      { key: 'pending', label: 'Pending', count: counts.pending, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2" stroke-dasharray="4 2"/><circle cx="8" cy="8" r="2" fill="#d29922"/>' },
      { key: 'done', label: 'Done', count: counts.done, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
      { key: 'closed', label: 'Closed', count: counts.closed, icon: '<circle cx="8" cy="8" r="7" fill="none" stroke="gray" stroke-width="2"/><line x1="5" y1="5" x2="11" y2="11" stroke="gray" stroke-width="1.5"/><line x1="11" y1="5" x2="5" y2="11" stroke="gray" stroke-width="1.5"/>' },
      { key: '', label: 'All', count: counts.total || 0 },
    ];
    tabs.innerHTML = filters.map(f =>
      h`<span onclick="setIssueFilter('${f.key}')" style="cursor:pointer;padding:4px 10px;border-radius:6px;${currentIssueFilter===f.key?'background:var(--selected-bg);font-weight:600':'color:var(--text-secondary)'}">
        ${f.icon ? html(`<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px">${f.icon}</svg>`) : ''}
        ${f.count} ${f.label}
      </span>`
    ).join('');
  }

  // Fetch filtered + sorted + paginated
  let url = `${projectApiPath('/issues')}?sort=${sort}&page=${currentIssuePage}&per_page=30`;
  if (currentIssueFilter) url += `&status=${currentIssueFilter}`;
  if (q) url += `&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: apiHeaders() });
  const data = await res.json();
  const issues = data.issues || [];

  const container = document.getElementById('issue-list');
  if (!issues.length) { container.innerHTML = h`<div class="card"><div class="empty-state">No issues.</div></div>`; renderPagination(0, 0); return; }

  container.innerHTML = h`<div class="card" style="padding:0">${html(issues.map(i => {
    const labels = i.labels ? i.labels.split(',').filter(l=>l.trim()).map(l => issueLabelHtml(l)).join(' ') : '';
    const icon = i.status === 'pending'
      ? '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#d29922" stroke-width="2" stroke-dasharray="4 2"/><circle cx="8" cy="8" r="2" fill="#d29922"/></svg>'
      : (i.status === 'open' || i.status === 'in_progress')
        ? `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="${i.status==='in_progress'?'#d29922':'#3fb950'}" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="${i.status==='in_progress'?'#d29922':'#3fb950'}"/></svg>`
        : '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#8b6fcf" stroke-width="2"/><path d="M5.5 8l2 2 3.5-3.5" fill="none" stroke="#8b6fcf" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const commentCount = i.comment_count
      ? h`<div style="flex-shrink:0;display:flex;align-items:center;gap:4px;color:var(--text-secondary);font-size:12px" title="${i.comment_count} comments"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.749.749 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>${i.comment_count}</div>`
      : '';
    const assigneeAvatar = i.assigned_to
      ? h`<div style="flex-shrink:0">${html((() => { const _ag = agentsData.find(_a => _a.id === i.assigned_to); return _ag ? roleAvatarHtml(_ag.name, 22, projectData?.color) : avatarSvg(nameOf(i.assigned_to), 22); })())}</div>`
      : '';
    return h`<a href="${issuePageHref(i)}" class="issue-list-item" style="text-decoration:none;color:inherit">
      <div style="flex-shrink:0;margin-top:2px">${html(icon)}</div>
      <div class="issue-main">
        <div class="issue-title-row"><span class="issue-title">${i.title}</span> ${html(labels)}</div>
        <div class="issue-meta">#${i.number} by ${nameOf(i.created_by)} · ${i.assigned_to ? nameOf(i.assigned_to) : 'unassigned'} · ${timeAgo(i.created_at)}</div>
      </div>
      ${html(commentCount)}
      ${html(assigneeAvatar)}
    </a>`;
  }).join(''))}</div>`;

  renderPagination(data.total_pages || 1, data.page || 1);
  renderActiveFilters();
  updateIssueUrlParams();
}

function renderPagination(totalPages, currentPage) {
  const el = document.getElementById('issue-pagination');
  if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }
  const btnStyle = 'padding:4px 8px;min-width:28px;';
  const activeStyle = 'background:var(--accent);color:#fff;';
  const disabledStyle = 'opacity:0.4;pointer-events:none;';
  const pageBtn = (p, label) => h`<button onclick="goToIssuePage(${p})" class="btn btn-sm" style="${btnStyle}${p===currentPage?activeStyle:''}">${label||p}</button>`;
  let markup = '';
  // First + Prev
  markup += h`<button onclick="goToIssuePage(1)" class="btn btn-sm" style="${btnStyle}${currentPage===1?disabledStyle:''}" title="First page">«</button>`;
  markup += h`<button onclick="goToIssuePage(${currentPage-1})" class="btn btn-sm" style="${btnStyle}${currentPage===1?disabledStyle:''}" title="Previous page">‹</button>`;
  // Page numbers with ellipsis
  const pages = [];
  if (totalPages <= 9) {
    for (let p = 1; p <= totalPages; p++) pages.push(p);
  } else {
    pages.push(1);
    let start = Math.max(2, currentPage - 2);
    let end = Math.min(totalPages - 1, currentPage + 2);
    if (currentPage <= 4) end = Math.min(6, totalPages - 1);
    if (currentPage >= totalPages - 3) start = Math.max(2, totalPages - 5);
    if (start > 2) pages.push('...');
    for (let p = start; p <= end; p++) pages.push(p);
    if (end < totalPages - 1) pages.push('...');
    pages.push(totalPages);
  }
  for (const p of pages) {
    if (p === '...') { markup += h`<span style="padding:4px 2px;opacity:0.5">…</span>`; }
    else markup += pageBtn(p);
  }
  // Next + Last
  markup += h`<button onclick="goToIssuePage(${currentPage+1})" class="btn btn-sm" style="${btnStyle}${currentPage===totalPages?disabledStyle:''}" title="Next page">›</button>`;
  markup += h`<button onclick="goToIssuePage(${totalPages})" class="btn btn-sm" style="${btnStyle}${currentPage===totalPages?disabledStyle:''}" title="Last page">»</button>`;
  // Page info
  markup += h`<span style="margin-left:8px;font-size:11px;color:var(--text-secondary)">Page ${currentPage} of ${totalPages}</span>`;
  el.innerHTML = markup;
}

function goToIssuePage(p) { currentIssuePage = p; loadIssues(); }
function setIssueFilter(f) { currentIssueFilter = f; currentIssuePage = 1; loadIssues(); }
function searchIssues() {
  const q = document.getElementById('issue-search')?.value?.trim() || '';
  if (q) currentIssueFilter = '';  // Clear the status filter while searching to avoid conflicting constraints.
  currentIssuePage = 1;
  loadIssues();
}


// ─── Tabs ───


let issueCount = 0;
async function updateTabCounts() {}

(async function initIssuesPage(){
  await loadProjectShell();
  await loadIssues();
  const events = connectProjectEvents(projectId);
  events.on("issue_created", loadIssues);
  events.on("issue_updated", loadIssues);
  events.on("comment_added", loadIssues);
})();
