/**
 * Pi-AI Providers settings page — provider CRUD, credential management, model selection.
 */

const PROVIDER_TYPE_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  custom: 'Custom (OpenAI-compatible)',
};

const PROVIDER_ENV_HINTS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
};

let currentProviderId = null;
let currentProviderName = '';
let editingProvider = null; // { id, name, type, baseUrl }

// ── Provider list ──

async function loadProviderList() {
  const list = document.getElementById('pi-providers-list');
  const loading = document.getElementById('pi-providers-loading');
  const error = document.getElementById('pi-providers-error');

  loading.hidden = false;
  list.innerHTML = '';
  error.hidden = true;

  try {
    const [providersRes, credsRes] = await Promise.all([
      fetch('/api/pi-ai/providers'),
      fetch('/api/pi-ai/credentials'),
    ]);

    const { providers } = await providersRes.json();
    const { credentials: storedCreds = [] } = await credsRes.json();
    const credMap = {};
    for (const c of storedCreds) {
      credMap[c.provider_id] = c;
    }

    loading.hidden = true;

    if (providers.length === 0) {
      list.innerHTML = '<div class="pi-providers-status">No providers configured. Click "+ New Provider" to add one.</div>';
      return;
    }

    for (const provider of providers) {
      const pid = provider.id;
      const typeLabel = PROVIDER_TYPE_LABELS[provider.provider_type] || provider.provider_type;
      const envHint = PROVIDER_ENV_HINTS[provider.provider_type];
      const stored = credMap[pid];
      const isBuiltin = provider.is_builtin;

      // Load selected model count for this provider
      let modelCount = 0;
      try {
        const modelRes = await fetch(`/api/pi-ai/providers/${pid}/selected-models`);
        const modelData = await modelRes.json();
        modelCount = (modelData.models || []).length;
      } catch { /* ignore */ }

      const card = document.createElement('div');
      card.className = 'pi-provider-card';

      const statusClass = stored ? 'status-configured' : 'status-unconfigured';
      const statusText = stored ? `Key stored` : `No key`;
      const baseUrlDisplay = provider.base_url || (isBuiltin ? '(default)' : '(required)');

      card.innerHTML = `
        <div class="pi-provider-info">
          <span class="pi-provider-name">${escapeHtml(provider.name)}</span>
          <span class="pi-provider-id">${escapeHtml(typeLabel)}</span>
          <span class="pi-provider-status ${statusClass}">${statusText}</span>
          <span class="pi-provider-env-hint">URL: ${escapeHtml(baseUrlDisplay)}</span>
          <span class="pi-provider-env-hint">${envHint ? 'Env: ' + envHint : ''}</span>
          <span class="pi-provider-env-hint">Models: ${modelCount} selected</span>
        </div>
        <div class="pi-provider-actions">
          <button type="button" class="btn btn-sm" data-action="key" data-pid="${pid}">
            ${stored ? 'Edit Key' : 'Set Key'}
          </button>
          <button type="button" class="btn btn-sm" data-action="edit" data-pid="${pid}" data-name="${escapeHtml(provider.name)}" data-type="${provider.provider_type}" data-url="${escapeHtml(provider.base_url || '')}">
            Edit
          </button>
          <button type="button" class="btn btn-sm" data-action="models" data-pid="${pid}" data-name="${escapeHtml(provider.name)}">
            Models
          </button>
          ${!isBuiltin ? `<button type="button" class="btn btn-sm btn-danger" data-action="delete" data-pid="${pid}" data-name="${escapeHtml(provider.name)}">Delete</button>` : ''}
        </div>
      `;

      card.querySelector('[data-action="key"]').addEventListener('click', () => openKeyDialog(pid, provider.name));
      card.querySelector('[data-action="edit"]').addEventListener('click', () => openEditDialog(pid, provider.name, provider.provider_type, provider.base_url || ''));
      card.querySelector('[data-action="models"]').addEventListener('click', () => openModelsDialog(pid, provider.name));
      const deleteBtn = card.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => deleteProvider(pid, provider.name));
      }

      list.appendChild(card);
    }
  } catch (err) {
    loading.hidden = true;
    error.hidden = false;
    error.textContent = 'Failed to load providers: ' + (err.message || 'Unknown error');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── New provider dialog ──

document.getElementById('btn-new-provider').addEventListener('click', () => {
  editingProvider = null;
  document.getElementById('dialog-title').textContent = 'New Provider';
  document.getElementById('dialog-provider-name').value = '';
  document.getElementById('dialog-provider-type').value = 'openai';
  document.getElementById('dialog-base-url').value = '';
  document.getElementById('dialog-api-key').value = '';
  document.getElementById('dialog-name-group').hidden = false;
  document.getElementById('dialog-type-group').hidden = false;
  document.getElementById('dialog-base-url-group').hidden = false;
  document.getElementById('pi-credential-dialog').showModal();
  document.getElementById('dialog-provider-name').focus();
});

// ── Edit provider dialog ──

function openEditDialog(pid, name, type, baseUrl) {
  editingProvider = { id: pid, type };
  document.getElementById('dialog-title').textContent = `Edit ${name}`;
  document.getElementById('dialog-provider-name').value = name;
  document.getElementById('dialog-provider-type').value = type;
  document.getElementById('dialog-base-url').value = baseUrl;
  document.getElementById('dialog-api-key').value = '';
  document.getElementById('dialog-name-group').hidden = false;
  document.getElementById('dialog-type-group').hidden = true; // can't change type after creation
  document.getElementById('dialog-base-url-group').hidden = false;
  document.getElementById('pi-credential-dialog').showModal();
  document.getElementById('dialog-provider-name').focus();
}

// ── Key dialog (only api key) ──

function openKeyDialog(pid, name) {
  editingProvider = { id: pid };
  currentProviderId = pid;
  currentProviderName = name;
  document.getElementById('dialog-title').textContent = `API Key for ${name}`;
  document.getElementById('dialog-provider-name').value = name;
  document.getElementById('dialog-api-key').value = '';
  document.getElementById('dialog-name-group').hidden = true;
  document.getElementById('dialog-type-group').hidden = true;
  document.getElementById('dialog-base-url-group').hidden = true;
  document.getElementById('pi-credential-dialog').showModal();
  document.getElementById('dialog-api-key').focus();
}

// ── Save provider / credential ──

async function saveProvider() {
  const name = document.getElementById('dialog-provider-name').value.trim();
  const providerType = document.getElementById('dialog-provider-type').value;
  const baseUrl = document.getElementById('dialog-base-url').value.trim();
  const apiKey = document.getElementById('dialog-api-key').value.trim();

  if (editingProvider && !editingProvider.type) {
    // Key-only mode
    if (!apiKey) { alert('Please enter an API key.'); return; }
    try {
      const res = await fetch(`/api/pi-ai/credentials/${editingProvider.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      document.getElementById('pi-credential-dialog').close();
      await loadProviderList();
    } catch (err) {
      alert('Failed to save credential: ' + (err.message || 'Unknown error'));
    }
    return;
  }

  if (!name) { alert('Please enter a provider name.'); return; }
  if (providerType === 'custom' && !baseUrl) { alert('Custom provider requires a Base URL.'); return; }

  try {
    let res;
    if (editingProvider) {
      // Update existing
      res = await fetch(`/api/pi-ai/providers/${editingProvider.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, base_url: baseUrl || null }),
      });
    } else {
      // Create new
      res = await fetch('/api/pi-ai/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, provider_type: providerType, base_url: baseUrl || undefined }),
      });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const data = await res.json();

    // If API key provided, save it too
    if (apiKey) {
      const providerId = data.id || editingProvider.id;
      await fetch(`/api/pi-ai/credentials/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      }).catch(() => {});
    }

    document.getElementById('pi-credential-dialog').close();
    await loadProviderList();
  } catch (err) {
    alert('Failed to save provider: ' + (err.message || 'Unknown error'));
  }
}

// ── Delete provider ──

async function deleteProvider(pid, name) {
  if (!confirm(`Delete provider "${name}"? This will also remove all selected models.`)) return;
  try {
    const res = await fetch(`/api/pi-ai/providers/${pid}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadProviderList();
  } catch (err) {
    alert('Failed to delete provider: ' + (err.message || 'Unknown error'));
  }
}

// ── Models dialog ──

async function openModelsDialog(pid, name) {
  currentProviderId = pid;
  currentProviderName = name;
  document.getElementById('models-dialog-title').textContent = `Models — ${name}`;
  document.getElementById('models-dialog-provider').textContent = `Provider: ${pid}`;
  document.getElementById('pi-models-available').hidden = false;
  document.getElementById('pi-models-api-list').innerHTML = '<div class="pi-providers-status">Loading from API...</div>';
  document.getElementById('pi-models-selected-list').innerHTML = '';
  document.getElementById('pi-models-error').hidden = true;
  document.getElementById('pi-models-loading').hidden = false;
  document.getElementById('pi-models-dialog').showModal();

  // Load selected models
  await loadSelectedModels(pid);

  // Load available models from API
  try {
    const res = await fetch(`/api/pi-ai/providers/${pid}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    document.getElementById('pi-models-loading').hidden = true;

    const list = document.getElementById('pi-models-api-list');
    list.innerHTML = '';
    if (!data.models || data.models.length === 0) {
      list.innerHTML = '<div class="pi-providers-status">No models returned by API. Add models manually below.</div>';
    } else {
      for (const m of data.models) {
        const label = `${m.name || m.id} ${m.contextWindow ? `(${m.contextWindow} ctx)` : ''}`;
        const div = document.createElement('div');
        div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0';
        div.innerHTML = `
          <input type="checkbox" id="api-model-${m.id}" value="${escapeHtml(m.id)}" data-ctx="${m.contextWindow || ''}" data-max="${m.maxTokens || ''}" data-reasoning="${m.reasoning || ''}" data-vision="${m.vision || ''}">
          <label for="api-model-${m.id}">${escapeHtml(label)}</label>
        `;
        list.appendChild(div);
      }
      // Add "Add Selected" button
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-sm btn-primary';
      addBtn.textContent = 'Add Selected';
      addBtn.style.cssText = 'margin-top:8px';
      addBtn.addEventListener('click', () => addSelectedModels(pid));
      list.appendChild(addBtn);
    }
  } catch (err) {
    document.getElementById('pi-models-loading').hidden = true;
    document.getElementById('pi-models-error').hidden = false;
    document.getElementById('pi-models-error').textContent = 'Failed to load models: ' + (err.message || 'Unknown error');
  }
}

async function loadSelectedModels(pid) {
  try {
    const res = await fetch(`/api/pi-ai/providers/${pid}/selected-models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = document.getElementById('pi-models-selected-list');
    list.innerHTML = '';
    const models = data.models || [];
    if (models.length === 0) {
      list.innerHTML = '<div class="pi-providers-status">No models selected yet.</div>';
    } else {
      for (const m of models) {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 0';
        div.innerHTML = `
          <span><strong>${escapeHtml(m.display_name || m.model_id)}</strong> <span class="pi-provider-id">${escapeHtml(m.model_id)}</span> ${m.context_window ? `(${m.context_window} ctx)` : ''}</span>
          <button type="button" class="btn btn-sm btn-danger" data-action="remove-model" data-mid="${m.id}">Remove</button>
        `;
        div.querySelector('[data-action="remove-model"]').addEventListener('click', () => removeSelectedModel(pid, m.id));
        list.appendChild(div);
      }
    }
  } catch { /* ignore */ }
}

async function addSelectedModels(pid) {
  const checkboxes = document.querySelectorAll('#pi-models-api-list input[type="checkbox"]:checked');
  if (checkboxes.length === 0) { alert('Select at least one model.'); return; }

  for (const cb of checkboxes) {
    const modelId = cb.value;
    const ctx = parseInt(cb.dataset.ctx) || null;
    const maxT = parseInt(cb.dataset.max) || null;
    try {
      await fetch(`/api/pi-ai/providers/${pid}/selected-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId, context_window: ctx, max_tokens: maxT }),
      });
    } catch { /* skip duplicates */ }
  }

  await loadSelectedModels(pid);
  await loadProviderList(); // refresh model count
}

async function removeSelectedModel(pid, mid) {
  try {
    await fetch(`/api/pi-ai/providers/${pid}/selected-models/${mid}`, { method: 'DELETE' });
    await loadSelectedModels(pid);
    await loadProviderList();
  } catch { /* ignore */ }
}

// ── Custom model ──

document.getElementById('btn-add-custom-model').addEventListener('click', async () => {
  const modelId = document.getElementById('dialog-custom-model-id').value.trim();
  const ctx = parseInt(document.getElementById('dialog-custom-model-ctx').value) || null;
  const maxT = parseInt(document.getElementById('dialog-custom-model-max').value) || null;
  if (!modelId) { alert('Enter a model ID.'); return; }

  try {
    await fetch(`/api/pi-ai/providers/${currentProviderId}/selected-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, context_window: ctx, max_tokens: maxT }),
    });
    document.getElementById('dialog-custom-model-id').value = '';
    document.getElementById('dialog-custom-model-ctx').value = '';
    document.getElementById('dialog-custom-model-max').value = '';
    await loadSelectedModels(currentProviderId);
    await loadProviderList();
  } catch (err) {
    alert('Failed to add model: ' + (err.message || 'Unknown error'));
  }
});

// ── Init ──

document.addEventListener('DOMContentLoaded', () => {
  loadProviderList();

  document.getElementById('dialog-save').addEventListener('click', saveProvider);
  document.getElementById('dialog-cancel').addEventListener('click', () => {
    document.getElementById('pi-credential-dialog').close();
  });
  document.getElementById('models-dialog-close').addEventListener('click', () => {
    document.getElementById('pi-models-dialog').close();
  });
});
