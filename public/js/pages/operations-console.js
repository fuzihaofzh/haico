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
    const match = window.location.pathname.match(/\/projects\/([^/]+)\//);
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

    document.getElementById('ops-summary-grid').innerHTML = items.map((item) => `
      <div class="summary-card">
        <div class="metric-label">${item.label}</div>
        <div class="summary-value">${item.value}</div>
        <div class="summary-footnote">${item.footnote}</div>
      </div>
    `).join('');
  }

  function renderLaneList() {
    const list = document.getElementById('lane-list');
    const filtered = OPS_STATE.lanes.filter((lane) => {
      const risk = computeRisk(lane);
      if (OPS_STATE.filter === 'critical') return risk.level === 'critical';
      if (OPS_STATE.filter === 'watch') return risk.level === 'watch' || risk.level === 'high';
      return true;
    });

    list.innerHTML = filtered.map((lane) => {
      const risk = computeRisk(lane);
      const customerLive = lane.customerUpdates.some((entry) => entry.status === 'live');
      return `
        <article class="lane-card ${lane.id === OPS_STATE.selectedLaneId ? 'active' : ''}" data-lane-id="${lane.id}">
          <div class="lane-topline">
            <span class="lane-id">${lane.id}</span>
            <span class="risk-pill ${riskToneClass(risk.level)}">${riskLabel(risk.level)} risk</span>
          </div>
          <div class="lane-route">${lane.route}</div>
          <div class="lane-subcopy">${lane.planner} · ${lane.dispatcher} · ${lane.mode}</div>
          <div class="lane-score-row">
            <div class="score-bubble ${riskToneClass(risk.level)}">${risk.score}</div>
            <div class="lane-metrics">
              <div class="metric-card">
                <div class="metric-label">Weather</div>
                <div class="metric-value">${lane.weather.severity}</div>
              </div>
              <div class="metric-card">
                <div class="metric-label">ETA drift</div>
                <div class="metric-value">+${lane.eta.baseDelayMinutes}m</div>
              </div>
              <div class="metric-card">
                <div class="metric-label">Customer</div>
                <div class="metric-value">${customerLive ? 'Live' : 'Internal'}</div>
              </div>
            </div>
          </div>
          <div class="lane-meta">
            <span class="lane-footnote">${lane.weather.system}</span>
            <span class="severity-pill ${riskToneClass(risk.level)}">${risk.rerouteReady ? 'Reroute ready' : 'Hold primary'}</span>
          </div>
        </article>
      `;
    }).join('');

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

    detail.innerHTML = `
      <div class="detail-header">
        <div>
          <div class="panel-eyebrow">Selected lane</div>
          <h3 class="detail-title">${lane.route}</h3>
          <div class="detail-subcopy">${lane.id} · ${lane.planner} planning · ${lane.dispatcher} dispatch · customer ${lane.customer}</div>
        </div>
        <div class="score-bubble ${riskToneClass(risk.level)}">${risk.score}</div>
      </div>

      <div class="detail-grid">
        <div class="detail-card">
          <div class="detail-subheading">Committed ETA</div>
          <strong>${String(lane.eta.committedHour).padStart(2, '0')}:${String(lane.eta.committedMinute).padStart(2, '0')}</strong>
          <div class="detail-note">Carrier commitment before risk adjustments</div>
        </div>
        <div class="detail-card">
          <div class="detail-subheading">Predicted ETA</div>
          <strong>${risk.predictedArrival.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</strong>
          <div class="detail-note">Live prediction after synced ETA notes</div>
        </div>
        <div class="detail-card">
          <div class="detail-subheading">Alternate capacity</div>
          <strong>${lane.ops.altCapacityPct}%</strong>
          <div class="detail-note">${lane.fallbackLane}</div>
        </div>
        <div class="detail-card">
          <div class="detail-subheading">Operational pressure</div>
          <strong>${lane.ops.hubLoadPct}% hub load</strong>
          <div class="detail-note">${lane.ops.dwellMinutes} min dwell · ${lane.ops.driverHoursPct}% driver hours used</div>
        </div>
      </div>

      <div class="breakdown-list">
        ${risk.breakdown.map((entry) => `
          <div class="breakdown-item">
            <div class="detail-meta">
              <strong style="font-size:15px">${entry.label}</strong>
              <span class="panel-meta">${entry.value} pts</span>
            </div>
            <div class="breakdown-caption">${entry.caption}</div>
            <div class="breakdown-bar">
              <div class="breakdown-fill ${entry.key}" style="width:${clamp(entry.value, 8, 100)}%"></div>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="recommendation-list">
        <div class="recommendation-item">
          <div class="detail-subheading">Reroute recommendation</div>
          <strong style="font-size:16px">${risk.recommendation}</strong>
          <div class="detail-note">The score combines weather pressure, ETA drift, dispatch friction, and recovery credit so route planners can explain every threshold crossing.</div>
        </div>
      </div>

      <button type="button" class="reroute-button" id="reroute-button" ${risk.rerouteReady ? '' : 'disabled'}>${risk.rerouteReady ? 'Stage reroute plan' : 'Recovery buffers healthy'}</button>

      <div class="composer-card">
        <div class="sync-strip">
          <span class="sync-pill live">Dispatch timeline</span>
          <span class="sync-pill live">Route planning desk</span>
          <span class="sync-pill ${lane.carrierNote.customerVisible ? 'live' : 'watch'}">${lane.carrierNote.customerVisible ? 'Customer feed live' : 'Customer feed internal'}</span>
        </div>
        <div class="detail-subheading">Latest carrier ETA note</div>
        <p class="detail-subcopy" style="margin:8px 0 14px">${lane.carrierNote.text}</p>
        <div class="detail-note">From ${lane.carrierNote.author} · ${formatRelativeTime(lane.carrierNote.createdAt)} · currently +${lane.carrierNote.delayMinutes}m</div>

        <div class="note-form-grid" style="margin-top:14px">
          <div class="note-input-group">
            <label class="detail-subheading" for="eta-note-input">Add carrier ETA note</label>
            <textarea id="eta-note-input" class="note-input" placeholder="Example: Carrier reports bridge icing east of Toledo and expects another 25 minute slip."></textarea>
          </div>
          <div class="note-input-group" style="flex:0 0 140px">
            <label class="detail-subheading" for="eta-delay-input">Delay minutes</label>
            <input id="eta-delay-input" class="delay-input" type="number" min="-30" max="240" step="5" value="${lane.eta.baseDelayMinutes}">
          </div>
          <div class="note-form-actions">
            <label class="customer-toggle">
              <input id="customer-visible-toggle" type="checkbox" ${lane.carrierNote.customerVisible ? 'checked' : ''}>
              <span>Publish to customer feed</span>
            </label>
            <button type="button" class="sync-button" id="sync-note-button">Sync ETA note</button>
          </div>
        </div>

        <div class="note-history-list">
          <div class="note-history-item">
            <div class="detail-subheading">Sync behavior</div>
            <div class="detail-note">Each note updates dispatch timing, risk scoring, and customer visibility from the same action. No duplicate handoffs between teams.</div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('sync-note-button').addEventListener('click', syncSelectedLaneNote);
    document.getElementById('reroute-button').addEventListener('click', stageReroute);
  }

  function renderTimeline() {
    const lane = getSelectedLane();
    const container = document.getElementById('dispatch-timeline');
    const status = document.getElementById('dispatch-sync-status');
    if (!lane) {
      container.innerHTML = '<div class="empty-copy">Select a lane to inspect dispatch activity.</div>';
      status.textContent = 'Awaiting selection';
      return;
    }
    status.textContent = `Last sync ${formatRelativeTime(lane.timeline[0]?.createdAt || Date.now())}`;
    container.innerHTML = lane.timeline
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((entry) => `
        <article class="timeline-item ${entry.flash ? 'flash' : ''}">
          <div class="timeline-stamp">${formatShortTime(entry.createdAt)}<br>${formatRelativeTime(entry.createdAt)}</div>
          <div class="timeline-body">
            <div class="timeline-title">${entry.title}</div>
            <div class="timeline-copy">${entry.body}</div>
            <div class="alert-pill ${riskToneClass(entry.tone)}">${entry.actor}</div>
          </div>
        </article>
      `).join('');
  }

  function renderCustomerFeed() {
    const lane = getSelectedLane();
    const container = document.getElementById('customer-feed');
    const status = document.getElementById('customer-sync-status');
    if (!lane) {
      container.innerHTML = '<div class="empty-copy">No customer update context yet.</div>';
      status.textContent = 'No lane selected';
      return;
    }
    status.textContent = lane.carrierNote.customerVisible ? 'Customer sync is live' : 'Internal-only until published';
    container.innerHTML = lane.customerUpdates
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((entry) => `
        <article class="customer-item ${entry.flash ? 'flash' : ''}">
          <div class="customer-stamp">${formatShortTime(entry.createdAt)}<br>${formatRelativeTime(entry.createdAt)}</div>
          <div class="customer-body">
            <div class="customer-title">${entry.title}</div>
            <div class="customer-copy">${entry.body}</div>
            <div class="alert-pill ${entry.status === 'live' ? 'stable' : 'watch'}">${entry.status}</div>
          </div>
        </article>
      `).join('');
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
      breadcrumbLink.href = `/projects/${encodeURIComponent(OPS_STATE.projectId)}`;
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
