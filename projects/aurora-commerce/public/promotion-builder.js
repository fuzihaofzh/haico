const state = {
  seed: null,
  draft: null,
  previewTimer: null,
};

const metricDefinitions = [
  { key: 'demandIndex', label: 'Demand Index', formatter: (value) => `${value}` },
  { key: 'projectedOrders', label: 'Projected Orders', formatter: (value) => Number(value).toLocaleString() },
  { key: 'averageOrderValueLift', label: 'AOV Lift', formatter: (value) => `${value}%` },
  { key: 'marginPressure', label: 'Margin Pressure', formatter: (value) => `${value}` },
  { key: 'checkoutComplexity', label: 'Checkout Complexity', formatter: (value) => `${value}` },
  { key: 'launchReadiness', label: 'Launch Readiness', formatter: (value) => `${value}` },
];

document.addEventListener('DOMContentLoaded', () => {
  void init();
});

async function init() {
  try {
    setStatus('Loading scenario controls…');
    state.seed = await fetchJson('/api/campaigns/promotion-builder/defaults');
    state.draft = { ...state.seed.defaults };
    renderChoiceControls();
    populateFormControls();
    bindEvents();
    await refreshPreview();
  } catch (error) {
    console.error(error);
    setStatus('Failed to load promotion builder data.');
  }
}

function renderChoiceControls() {
  document.getElementById('objective-options').innerHTML = state.seed.objectives
    .map(
      (item) => `
        <button class="choice-card ${state.draft.objective === item.id ? 'active' : ''}" type="button" data-choice="objective" data-value="${item.id}">
          <strong>${item.label}</strong>
          <p>${item.detail}</p>
        </button>
      `
    )
    .join('');

  document.getElementById('channel-options').innerHTML = state.seed.channelPresets
    .map(
      (item) => `
        <button class="choice-card ${state.draft.channelPreset === item.id ? 'active' : ''}" type="button" data-choice="channelPreset" data-value="${item.id}">
          <strong>${item.label}</strong>
          <p>${item.detail}</p>
        </button>
      `
    )
    .join('');

  document.getElementById('fulfillment-options').innerHTML = state.seed.fulfillmentPresets
    .map(
      (item) => `
        <button class="choice-card ${state.draft.fulfillmentPreset === item.id ? 'active' : ''}" type="button" data-choice="fulfillmentPreset" data-value="${item.id}">
          <strong>${item.label}</strong>
          <p>${item.detail}</p>
        </button>
      `
    )
    .join('');

  document.getElementById('launch-day-options').innerHTML = state.seed.launchDays
    .map(
      (item) => `
        <button class="segment-button ${state.draft.launchDay === item ? 'active' : ''}" type="button" data-choice="launchDay" data-value="${item}">
          <strong>${item}</strong>
        </button>
      `
    )
    .join('');

  document.getElementById('mechanic').innerHTML = state.seed.mechanics
    .map((item) => `<option value="${item.id}">${item.label}</option>`)
    .join('');
}

function populateFormControls() {
  setControlValue('mechanic', state.draft.mechanic);
  setRangeValue('discountPercent', state.draft.discountPercent, (value) => `${value}%`);
  setRangeValue('thresholdAmount', state.draft.thresholdAmount, (value) => `$${value}`);
  setRangeValue('budgetK', state.draft.budgetK, (value) => `$${value}k`);
  setRangeValue('inventoryBufferPercent', state.draft.inventoryBufferPercent, (value) => `${value}%`);
  setRangeValue('vipWindowHours', state.draft.vipWindowHours, (value) => `${value}h`);
  document.getElementById('stackable').checked = state.draft.stackable;
  document.getElementById('autoApply').checked = state.draft.autoApply;
  document.getElementById('giftWithPurchase').checked = state.draft.giftWithPurchase;
}

function bindEvents() {
  document.body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-choice]');
    if (!target) {
      return;
    }

    const key = target.getAttribute('data-choice');
    state.draft[key] = target.getAttribute('data-value');
    renderChoiceControls();
    queuePreview();
  });

  ['mechanic', 'discountPercent', 'thresholdAmount', 'budgetK', 'inventoryBufferPercent', 'vipWindowHours'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (event) => {
      const nextValue = event.target.value;
      state.draft[id] = id === 'mechanic' ? nextValue : Number(nextValue);
      populateFormControls();
      queuePreview();
    });
  });

  ['stackable', 'autoApply', 'giftWithPurchase'].forEach((id) => {
    document.getElementById(id).addEventListener('change', (event) => {
      state.draft[id] = event.target.checked;
      queuePreview();
    });
  });
}

function queuePreview() {
  if (state.previewTimer) {
    window.clearTimeout(state.previewTimer);
  }
  setStatus('Syncing live preview…');
  state.previewTimer = window.setTimeout(() => {
    void refreshPreview();
  }, 120);
}

async function refreshPreview() {
  const preview = await fetchJson('/api/campaigns/promotion-builder/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.draft),
  });

  renderMetrics(preview.metrics);
  renderPanels(preview.panels);
  renderLaunchBrief(preview.launchBrief);
  renderStatusList('acceptance-list', preview.acceptanceCriteria, 'passed');
  renderStatusList('guardrail-list', preview.guardrails, 'status');
  renderRecommendations(preview.recommendations);
  setStatus(`Scenario aligned for ${preview.draft.launchDay} launch review.`);
}

function renderMetrics(metrics) {
  document.getElementById('metric-cards').innerHTML = metricDefinitions
    .map((item) => {
      const captions = {
        demandIndex: 'Cross-channel demand signal',
        projectedOrders: 'Expected weekly launch volume',
        averageOrderValueLift: 'Basket expansion from thresholds',
        marginPressure: 'Commercial pressure on gross margin',
        checkoutComplexity: 'Rule and cart testing load',
        launchReadiness: 'Readiness score for release review',
      };

      return `
        <div class="metric-card">
          <span>${item.label}</span>
          <strong>${item.formatter(metrics[item.key])}</strong>
          <p>${captions[item.key]}</p>
        </div>
      `;
    })
    .join('');
}

function renderPanels(panels) {
  document.getElementById('ops-panels').innerHTML = panels
    .map(
      (panel) => `
        <article class="panel-card">
          <span>${panel.eyebrow}</span>
          <h3>${panel.title}</h3>
          <strong>${panel.score}</strong>
          <p>${panel.detail}</p>
        </article>
      `
    )
    .join('');
}

function renderLaunchBrief(brief) {
  document.getElementById('launch-brief-title').textContent = brief.title;
  document.getElementById('launch-brief-summary').textContent = brief.summary;
  document.getElementById('launch-brief-timeline').innerHTML = brief.timeline.map((item) => `<li>${item}</li>`).join('');
}

function renderStatusList(elementId, items, stateKey) {
  document.getElementById(elementId).innerHTML = items
    .map((item) => {
      const stateValue = stateKey === 'passed' ? (item.passed ? 'pass' : 'risk') : item[stateKey];
      return `
        <li data-state="${stateValue}">
          <strong>${item.label}</strong>
          <small>${item.detail}</small>
        </li>
      `;
    })
    .join('');
}

function renderRecommendations(recommendations) {
  document.getElementById('recommendation-list').innerHTML = recommendations.map((item) => `<li>${item}</li>`).join('');
}

function setRangeValue(id, value, formatter) {
  const input = document.getElementById(id);
  input.value = value;
  document.getElementById(`${id}-value`).textContent = formatter(value);
}

function setControlValue(id, value) {
  document.getElementById(id).value = value;
}

function setStatus(message) {
  document.getElementById('preview-status').textContent = message;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}
