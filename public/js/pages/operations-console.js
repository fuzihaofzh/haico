(function () {
  const OPS_STATE = {
    projectId: getProjectIdFromPath(),
    projectName: 'Atlas Freight Command',
    selectedLaneId: 'LN-CHI-204',
    filter: 'all',
    syncCount: 0,
    lanes: [
      {
        id: 'LN-CHI-204',
        route: 'Dallas, TX -> Chicago, IL',
        planner: 'Rae Sutton',
        dispatcher: 'Marco Diaz',
        customer: 'NorthPeak Retail',
        mode: 'Reefer',
        equipment: '4x 53FT',
        fallbackLane: 'I-44 / STL bypass',
        weather: { severity: 86, system: 'Lake-effect snow', windMph: 38, visibilityMiles: 1.2 },
        eta: { committedHour: 18, committedMinute: 40, baseDelayMinutes: 82, confidence: 0.71 },
        ops: { dwellMinutes: 48, driverHoursPct: 92, bufferHours: 1.4, altCapacityPct: 78, hubLoadPct: 88 },
        carrierNote: {
          text: 'Carrier advised chain controls west of Gary and a likely 75-90 minute slide at handoff.',
          delayMinutes: 82,
          customerVisible: true,
          author: 'BlueLine Freight',
          createdAt: minutesAgo(18),
        },
        timeline: [
          createEvent('planner', 'Weather band escalated', 'NOAA mesh upgraded snow intensity over Gary handoff.', minutesAgo(42), 'high'),
          createEvent('dispatch', 'Carrier ETA note synced', 'BlueLine Freight added a +82 minute delay and dispatch acknowledged the new handoff risk.', minutesAgo(18), 'critical'),
          createEvent('customer', 'Customer notice published', 'NorthPeak Retail received a proactive notice with revised dock ETA and cold-chain reassurance.', minutesAgo(16), 'watch'),
        ],
        customerUpdates: [
          createCustomerUpdate('Delay notice live', 'Dock ETA moved to 20:02 CT with reefer integrity still green.', minutesAgo(16), 'live'),
        ],
      },
      {
        id: 'LN-ATL-118',
        route: 'Atlanta, GA -> Newark, NJ',
        planner: 'Mina Park',
        dispatcher: 'Liam Cross',
        customer: 'Eastline Home',
        mode: 'Dry van',
        equipment: '6x 53FT',
        fallbackLane: 'I-81 / Harrisburg merge',
        weather: { severity: 62, system: 'Thunderstorm line', windMph: 22, visibilityMiles: 3.4 },
        eta: { committedHour: 9, committedMinute: 15, baseDelayMinutes: 34, confidence: 0.83 },
        ops: { dwellMinutes: 26, driverHoursPct: 76, bufferHours: 2.8, altCapacityPct: 66, hubLoadPct: 73 },
        carrierNote: {
          text: 'Carrier reports rolling stop-and-go near Richmond with a soft +35 minute drift.',
          delayMinutes: 34,
          customerVisible: false,
          author: 'Harborline Logistics',
          createdAt: minutesAgo(11),
        },
        timeline: [
          createEvent('planner', 'Risk watch opened', 'Storm cell is clipping the Richmond corridor and watch-level reroute readiness is active.', minutesAgo(39), 'watch'),
          createEvent('dispatch', 'Carrier ETA note synced', 'Dispatch timeline updated with Harborline delay note and dock alert remained internal.', minutesAgo(11), 'watch'),
        ],
        customerUpdates: [
          createCustomerUpdate('No outbound notice', 'Delay remains inside customer tolerance and feed stays internal-only.', minutesAgo(11), 'watch'),
        ],
      },
      {
        id: 'LN-DEN-305',
        route: 'Salt Lake City, UT -> Denver, CO',
        planner: 'Ari Monroe',
        dispatcher: 'Tess Flores',
        customer: 'Summit Medical',
        mode: 'Temp control',
        equipment: '2x 53FT',
        fallbackLane: 'US-40 weather bypass',
        weather: { severity: 44, system: 'Crosswind advisory', windMph: 17, visibilityMiles: 6.8 },
        eta: { committedHour: 13, committedMinute: 30, baseDelayMinutes: 18, confidence: 0.9 },
        ops: { dwellMinutes: 18, driverHoursPct: 58, bufferHours: 4.1, altCapacityPct: 84, hubLoadPct: 49 },
        carrierNote: {
          text: 'Carrier is holding current ETA with a small +18 minute mountain pass buffer.',
          delayMinutes: 18,
          customerVisible: true,
          author: 'PeakWest Carriers',
          createdAt: minutesAgo(27),
        },
        timeline: [
          createEvent('planner', 'Lane stabilized', 'Wind advisory eased across the pass and dispatch kept primary route active.', minutesAgo(27), 'stable'),
        ],
        customerUpdates: [
          createCustomerUpdate('On-track update', 'Summit Medical remains within delivery commitment with no cold-chain variance.', minutesAgo(26), 'live'),
        ],
      },
      {
        id: 'LN-SEA-512',
        route: 'Seattle, WA -> Boise, ID',
        planner: 'Noah Kim',
        dispatcher: 'Elena Ruiz',
        customer: 'Cascade Devices',
        mode: 'Expedite',
        equipment: '3x team driver',
        fallbackLane: 'US-95 east shift',
        weather: { severity: 78, system: 'Mountain ice and fog', windMph: 29, visibilityMiles: 1.8 },
        eta: { committedHour: 7, committedMinute: 5, baseDelayMinutes: 58, confidence: 0.76 },
        ops: { dwellMinutes: 39, driverHoursPct: 88, bufferHours: 1.9, altCapacityPct: 58, hubLoadPct: 81 },
        carrierNote: {
          text: 'Driver team reported black ice west of Snoqualmie with a likely +60 minute rollover into Boise.',
          delayMinutes: 58,
          customerVisible: true,
          author: 'ArrowNorth Express',
          createdAt: minutesAgo(9),
        },
        timeline: [
          createEvent('planner', 'Reroute staged', 'US-95 east shift is staged if visibility drops another 0.5 miles.', minutesAgo(24), 'high'),
          createEvent('dispatch', 'Carrier ETA note synced', 'ArrowNorth note moved into dispatch and customer channels with expedite escalation.', minutesAgo(9), 'high'),
        ],
        customerUpdates: [
          createCustomerUpdate('Customer notice live', 'Cascade Devices received a same-hour ETA revision and expedite reassurance.', minutesAgo(8), 'live'),
        ],
      },
    ],
  };

  function getProjectIdFromPath() {
    const match = window.location.pathname.match(/\/project\/([^/]+)\//);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function minutesAgo(minutes) {
    return Date.now() - minutes * 60 * 1000;
  }

  function createEvent(actor, title, body, createdAt, tone) {
    return {
      id: `${actor}-${Math.random().toString(36).slice(2, 9)}`,
      actor,
      title,
      body,
      createdAt,
      tone: tone || 'watch',
      flash: false,
    };
  }

  function createCustomerUpdate(title, body, createdAt, status) {
    return {
      id: `cust-${Math.random().toString(36).slice(2, 9)}`,
      title,
      body,
      createdAt,
      status: status || 'live',
      flash: false,
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function computeRisk(lane) {
    const weatherPenalty = lane.weather.severity * 0.46 + lane.weather.windMph * 0.4 + Math.max(0, 5 - lane.weather.visibilityMiles) * 7;
    const etaPenalty = lane.eta.baseDelayMinutes * 0.34 + (100 - lane.eta.confidence * 100) * 0.22;
    const opsPenalty = lane.ops.dwellMinutes * 0.22 + lane.ops.driverHoursPct * 0.16 + lane.ops.hubLoadPct * 0.12;
    const recoveryCredit = lane.ops.bufferHours * 8 + lane.ops.altCapacityPct * 0.09;
    const score = clamp(Math.round(14 + weatherPenalty + etaPenalty + opsPenalty - recoveryCredit), 8, 99);
    const level = score >= 78 ? 'critical' : score >= 63 ? 'high' : score >= 45 ? 'watch' : 'stable';
    const rerouteReady = score >= 63 || lane.weather.severity >= 74;
    const predicted = new Date();
    predicted.setHours(lane.eta.committedHour, lane.eta.committedMinute, 0, 0);
    predicted.setMinutes(predicted.getMinutes() + lane.eta.baseDelayMinutes);
    return {
      score,
      level,
      rerouteReady,
      predictedArrival: predicted,
      breakdown: [
        {
          key: 'weather',
          label: 'Weather pressure',
          value: Math.round(weatherPenalty),
          caption: `${lane.weather.system} · ${lane.weather.windMph} mph gusts · ${lane.weather.visibilityMiles.toFixed(1)} mi visibility`,
        },
        {
          key: 'eta',
          label: 'ETA drift',
          value: Math.round(etaPenalty),
          caption: `${lane.eta.baseDelayMinutes} min carrier delay · ${(lane.eta.confidence * 100).toFixed(0)}% confidence`,
        },
        {
          key: 'ops',
          label: 'Dispatch friction',
          value: Math.round(opsPenalty),
          caption: `${lane.ops.dwellMinutes} min dwell · ${lane.ops.driverHoursPct}% hours used · ${lane.ops.hubLoadPct}% hub load`,
        },
        {
          key: 'recovery',
          label: 'Recovery credit',
          value: Math.round(recoveryCredit),
          caption: `${lane.ops.bufferHours.toFixed(1)}h buffer · ${lane.ops.altCapacityPct}% alternate capacity`,
        },
      ],
      recommendation: rerouteReady
        ? `Shift to ${lane.fallbackLane} if the next weather pulse adds 10+ score or ETA slip crosses 70 minutes.`
        : `Hold primary route and keep dispatch on watch. Alternate capacity remains available if the weather mesh worsens.`,
    };
  }

  function getSelectedLane() {
    return OPS_STATE.lanes.find((lane) => lane.id === OPS_STATE.selectedLaneId) || OPS_STATE.lanes[0] || null;
  }

  function cloneTemplateRoot(id) {
    const template = document.getElementById(id);
    return template.content.firstElementChild.cloneNode(true);
  }

  function cloneTemplateFragment(id) {
    return document.getElementById(id).content.cloneNode(true);
  }

  function slot(root, name) {
    return root.querySelector(`[data-slot="${name}"]`);
  }

  function setText(root, name, value) {
    const node = slot(root, name);
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function riskToneClass(level) {
    return level === 'critical' ? 'critical' : level === 'high' ? 'high' : level === 'watch' ? 'watch' : 'stable';
  }

  function riskLabel(level) {
    return level === 'critical' ? 'Critical' : level === 'high' ? 'High' : level === 'watch' ? 'Watch' : 'Stable';
  }

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function formatRelativeTime(timestamp) {
    const diffMin = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const hours = Math.round(diffMin / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function renderSummary() {
    const metrics = OPS_STATE.lanes.map((lane) => ({ lane, risk: computeRisk(lane) }));
    const criticalCount = metrics.filter(({ risk }) => risk.level === 'critical').length;
    const rerouteReady = metrics.filter(({ risk }) => risk.rerouteReady).length;
    const avgDelay = Math.round(metrics.reduce((sum, entry) => sum + entry.lane.eta.baseDelayMinutes, 0) / metrics.length);
    const customerLive = OPS_STATE.lanes.reduce((sum, lane) => sum + lane.customerUpdates.filter((entry) => entry.status === 'live').length, 0);

    const items = [
      { label: 'Lanes at critical risk', value: criticalCount, footnote: `${rerouteReady} ready for reroute staging` },
      { label: 'Average ETA drift', value: `${avgDelay}m`, footnote: `${OPS_STATE.syncCount} carrier syncs published this session` },
      { label: 'Customer updates live', value: customerLive, footnote: 'Dispatch and customer feeds share the same update source' },
      { label: 'Live weather mesh', value: `${Math.round(metrics.reduce((sum, entry) => sum + entry.lane.weather.severity, 0) / metrics.length)} / 100`, footnote: 'Automatic weather pulses refresh every 9 seconds' },
    ];

    document.getElementById('ops-summary-grid').replaceChildren(...items.map((item) => {
      const card = cloneTemplateRoot('tmpl-ops-summary-card');
      setText(card, 'label', item.label);
      setText(card, 'value', item.value);
      setText(card, 'footnote', item.footnote);
      return card;
    }));
  }

  function renderLaneList() {
    const list = document.getElementById('lane-list');
    const filtered = OPS_STATE.lanes.filter((lane) => {
      const risk = computeRisk(lane);
      if (OPS_STATE.filter === 'critical') return risk.level === 'critical';
      if (OPS_STATE.filter === 'watch') return risk.level === 'watch' || risk.level === 'high';
      return true;
    });

    list.replaceChildren(...filtered.map((lane) => {
      const risk = computeRisk(lane);
      const customerLive = lane.customerUpdates.some((entry) => entry.status === 'live');
      const card = cloneTemplateRoot('tmpl-ops-lane-card');
      card.dataset.laneId = lane.id;
      card.classList.toggle('active', lane.id === OPS_STATE.selectedLaneId);
      setText(card, 'id', lane.id);
      setText(card, 'risk-label', `${riskLabel(risk.level)} risk`);
      slot(card, 'risk-label').className = `risk-pill ${riskToneClass(risk.level)}`;
      setText(card, 'route', lane.route);
      setText(card, 'subcopy', `${lane.planner} · ${lane.dispatcher} · ${lane.mode}`);
      setText(card, 'score', risk.score);
      slot(card, 'score').className = `score-bubble ${riskToneClass(risk.level)}`;
      setText(card, 'weather', lane.weather.severity);
      setText(card, 'eta-drift', `+${lane.eta.baseDelayMinutes}m`);
      setText(card, 'customer-state', customerLive ? 'Live' : 'Internal');
      setText(card, 'weather-system', lane.weather.system);
      setText(card, 'reroute-state', risk.rerouteReady ? 'Reroute ready' : 'Hold primary');
      slot(card, 'reroute-state').className = `severity-pill ${riskToneClass(risk.level)}`;
      return card;
    }));

    Array.from(list.querySelectorAll('.lane-card')).forEach((card) => {
      card.addEventListener('click', () => {
        OPS_STATE.selectedLaneId = card.dataset.laneId;
        renderAll();
      });
    });
  }

  function renderDetail() {
    const lane = getSelectedLane();
    const empty = document.getElementById('detail-empty');
    const detail = document.getElementById('lane-detail');
    if (!lane) {
      empty.style.display = 'grid';
      detail.style.display = 'none';
      return;
    }

    const risk = computeRisk(lane);
    empty.style.display = 'none';
    detail.style.display = 'block';

    const fragment = cloneTemplateFragment('tmpl-ops-detail');
    setText(fragment, 'route', lane.route);
    setText(fragment, 'subcopy', `${lane.id} · ${lane.planner} planning · ${lane.dispatcher} dispatch · customer ${lane.customer}`);
    setText(fragment, 'score', risk.score);
    slot(fragment, 'score').className = `score-bubble ${riskToneClass(risk.level)}`;
    setText(fragment, 'committed-eta', `${String(lane.eta.committedHour).padStart(2, '0')}:${String(lane.eta.committedMinute).padStart(2, '0')}`);
    setText(fragment, 'predicted-eta', risk.predictedArrival.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    setText(fragment, 'alternate-capacity', `${lane.ops.altCapacityPct}%`);
    setText(fragment, 'fallback-lane', lane.fallbackLane);
    setText(fragment, 'operational-pressure', `${lane.ops.hubLoadPct}% hub load`);
    setText(fragment, 'operational-note', `${lane.ops.dwellMinutes} min dwell · ${lane.ops.driverHoursPct}% driver hours used`);
    slot(fragment, 'breakdown-list').replaceChildren(...risk.breakdown.map(renderBreakdownItem));
    setText(fragment, 'recommendation', risk.recommendation);

    const rerouteButton = slot(fragment, 'reroute-button');
    rerouteButton.disabled = !risk.rerouteReady;
    rerouteButton.textContent = risk.rerouteReady ? 'Stage reroute plan' : 'Recovery buffers healthy';

    const customerFeedPill = slot(fragment, 'customer-feed-pill');
    customerFeedPill.className = `sync-pill ${lane.carrierNote.customerVisible ? 'live' : 'watch'}`;
    customerFeedPill.textContent = lane.carrierNote.customerVisible ? 'Customer feed live' : 'Customer feed internal';
    setText(fragment, 'carrier-note', lane.carrierNote.text);
    setText(fragment, 'carrier-meta', `From ${lane.carrierNote.author} · ${formatRelativeTime(lane.carrierNote.createdAt)} · currently +${lane.carrierNote.delayMinutes}m`);

    fragment.getElementById('eta-delay-input').value = lane.eta.baseDelayMinutes;
    fragment.getElementById('customer-visible-toggle').checked = lane.carrierNote.customerVisible;
    detail.replaceChildren(fragment);

    document.getElementById('sync-note-button').addEventListener('click', syncSelectedLaneNote);
    document.getElementById('reroute-button').addEventListener('click', stageReroute);
  }

  function renderBreakdownItem(entry) {
    const item = cloneTemplateRoot('tmpl-ops-breakdown-item');
    setText(item, 'label', entry.label);
    setText(item, 'value', `${entry.value} pts`);
    setText(item, 'caption', entry.caption);
    const fill = slot(item, 'fill');
    fill.className = `breakdown-fill ${entry.key}`;
    fill.style.width = `${clamp(entry.value, 8, 100)}%`;
    return item;
  }

  function renderTimeline() {
    const lane = getSelectedLane();
    const container = document.getElementById('dispatch-timeline');
    const status = document.getElementById('dispatch-sync-status');
    if (!lane) {
      container.innerHTML = h`<div class="empty-copy">Select a lane to inspect dispatch activity.</div>`;
      status.textContent = 'Awaiting selection';
      return;
    }
    status.textContent = `Last sync ${formatRelativeTime(lane.timeline[0]?.createdAt || Date.now())}`;
    container.replaceChildren(...lane.timeline
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(renderTimelineItem));
  }

  function renderTimelineItem(entry) {
    const item = cloneTemplateRoot('tmpl-ops-timeline-item');
    item.classList.toggle('flash', entry.flash);
    setText(item, 'short-time', formatShortTime(entry.createdAt));
    setText(item, 'relative-time', formatRelativeTime(entry.createdAt));
    setText(item, 'title', entry.title);
    setText(item, 'body', entry.body);
    setText(item, 'actor', entry.actor);
    slot(item, 'actor').className = `alert-pill ${riskToneClass(entry.tone)}`;
    return item;
  }

  function renderCustomerFeed() {
    const lane = getSelectedLane();
    const container = document.getElementById('customer-feed');
    const status = document.getElementById('customer-sync-status');
    if (!lane) {
      container.innerHTML = h`<div class="empty-copy">No customer update context yet.</div>`;
      status.textContent = 'No lane selected';
      return;
    }
    status.textContent = lane.carrierNote.customerVisible ? 'Customer sync is live' : 'Internal-only until published';
    container.replaceChildren(...lane.customerUpdates
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(renderCustomerItem));
  }

  function renderCustomerItem(entry) {
    const item = cloneTemplateRoot('tmpl-ops-customer-item');
    item.classList.toggle('flash', entry.flash);
    setText(item, 'short-time', formatShortTime(entry.createdAt));
    setText(item, 'relative-time', formatRelativeTime(entry.createdAt));
    setText(item, 'title', entry.title);
    setText(item, 'body', entry.body);
    setText(item, 'status', entry.status);
    slot(item, 'status').className = `alert-pill ${entry.status === 'live' ? 'stable' : 'watch'}`;
    return item;
  }

  function syncSelectedLaneNote() {
    const lane = getSelectedLane();
    if (!lane) return;

    const noteEl = document.getElementById('eta-note-input');
    const delayEl = document.getElementById('eta-delay-input');
    const customerToggle = document.getElementById('customer-visible-toggle');
    const note = String(noteEl?.value || '').trim();
    const delay = clamp(Number(delayEl?.value || lane.eta.baseDelayMinutes), -30, 240);
    if (!note) return;

    lane.eta.baseDelayMinutes = delay;
    lane.carrierNote = {
      text: note,
      delayMinutes: delay,
      customerVisible: !!customerToggle?.checked,
      author: 'Live carrier sync',
      createdAt: Date.now(),
    };

    lane.timeline.unshift(
      createEvent(
        'dispatch',
        'Carrier ETA note synced',
        `${note} Dispatch ETA is now carrying a ${delay >= 0 ? '+' : ''}${delay} minute adjustment.`,
        Date.now(),
        delay >= 70 ? 'critical' : delay >= 40 ? 'high' : 'watch'
      )
    );
    lane.timeline[0].flash = true;

    if (lane.carrierNote.customerVisible) {
      lane.customerUpdates.unshift(
        createCustomerUpdate(
          'Customer ETA refreshed',
          `${lane.customer} now sees a ${delay >= 0 ? '+' : ''}${delay} minute revision tied directly to the carrier note.`,
          Date.now(),
          'live'
        )
      );
      lane.customerUpdates[0].flash = true;
    } else {
      lane.customerUpdates.unshift(
        createCustomerUpdate(
          'Dispatch-only hold',
          'The carrier note is synced internally and customer messaging remains on hold for dispatcher review.',
          Date.now(),
          'watch'
        )
      );
      lane.customerUpdates[0].flash = true;
    }

    OPS_STATE.syncCount += 1;
    noteEl.value = '';
    renderAll();
    clearFlashStates(lane);
  }

  function stageReroute() {
    const lane = getSelectedLane();
    if (!lane) return;
    lane.ops.bufferHours = clamp(lane.ops.bufferHours + 0.9, 0.4, 6);
    lane.weather.severity = clamp(lane.weather.severity - 8, 10, 98);
    lane.timeline.unshift(
      createEvent(
        'planner',
        'Reroute plan staged',
        `${lane.fallbackLane} is now staged with dispatch buffer increased to ${lane.ops.bufferHours.toFixed(1)} hours.`,
        Date.now(),
        'watch'
      )
    );
    lane.timeline[0].flash = true;
    lane.customerUpdates.unshift(
      createCustomerUpdate(
        'Recovery plan prepared',
        `${lane.customer} can receive a reroute-backed recovery update immediately if the next weather pulse worsens.`,
        Date.now(),
        'watch'
      )
    );
    lane.customerUpdates[0].flash = true;
    renderAll();
    clearFlashStates(lane);
  }

  function clearFlashStates(lane) {
    window.setTimeout(() => {
      lane.timeline.forEach((entry) => { entry.flash = false; });
      lane.customerUpdates.forEach((entry) => { entry.flash = false; });
      renderTimeline();
      renderCustomerFeed();
    }, 1300);
  }

  function simulatePulse() {
    const lane = OPS_STATE.lanes[Math.floor(Math.random() * OPS_STATE.lanes.length)];
    if (!lane) return;

    const previousRisk = computeRisk(lane);
    const delta = Math.round((Math.random() * 10) - 4);
    const etaDelta = Math.round((Math.random() * 16) - 6);

    lane.weather.severity = clamp(lane.weather.severity + delta, 18, 96);
    lane.eta.baseDelayMinutes = clamp(lane.eta.baseDelayMinutes + etaDelta, 0, 180);
    lane.ops.hubLoadPct = clamp(lane.ops.hubLoadPct + Math.round((Math.random() * 8) - 3), 36, 98);

    const nextRisk = computeRisk(lane);
    if (nextRisk.level !== previousRisk.level || Math.abs(nextRisk.score - previousRisk.score) >= 6) {
      lane.timeline.unshift(
        createEvent(
          'planner',
          'Live weather pulse updated score',
          `${lane.weather.system} changed lane risk from ${previousRisk.score} to ${nextRisk.score}. Dispatch is ${nextRisk.rerouteReady ? 'ready to reroute' : 'holding primary route'}.`,
          Date.now(),
          nextRisk.level
        )
      );
      lane.timeline[0].flash = lane.id === OPS_STATE.selectedLaneId;
    }

    renderSummary();
    renderLaneList();
    if (lane.id === OPS_STATE.selectedLaneId) {
      renderDetail();
      renderTimeline();
      renderCustomerFeed();
      clearFlashStates(lane);
    }
  }

  function applyProjectIdentity() {
    const title = document.getElementById('ops-project-title');
    const breadcrumbLink = document.getElementById('ops-project-link');
    if (breadcrumbLink) {
      breadcrumbLink.href = `/project/${encodeURIComponent(OPS_STATE.projectId)}`;
      breadcrumbLink.textContent = OPS_STATE.projectName;
    }
    if (title) title.textContent = `${OPS_STATE.projectName} Operations Console`;
  }

  function updateClock() {
    document.getElementById('ops-clock').textContent = `${new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })} UTC`;
  }

  function bindFilters() {
    Array.from(document.querySelectorAll('.lane-filter')).forEach((button) => {
      button.addEventListener('click', () => {
        OPS_STATE.filter = button.dataset.filter || 'all';
        Array.from(document.querySelectorAll('.lane-filter')).forEach((node) => {
          node.classList.toggle('active', node === button);
        });
        renderLaneList();
      });
    });
  }

  function renderAll() {
    renderSummary();
    renderLaneList();
    renderDetail();
    renderTimeline();
    renderCustomerFeed();
  }

  applyProjectIdentity();
  if (OPS_STATE.projectId) {
    fetch(`/api/projects/${encodeURIComponent(OPS_STATE.projectId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((project) => {
        if (!project?.name) return;
        OPS_STATE.projectName = project.name;
        applyProjectIdentity();
      })
      .catch(() => {});
  }
  bindFilters();
  renderAll();
  updateClock();
  window.setInterval(updateClock, 1000);
  window.setInterval(simulatePulse, 9000);
})();
