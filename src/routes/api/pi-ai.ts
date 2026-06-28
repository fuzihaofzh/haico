/**
 * Pi-AI API routes — provider listing, model catalog, credential management.
 *
 * NOTE: All @earendil-works/pi-ai imports are lazy/dynamic to avoid CJS
 * compilation issues — the package is ESM-only and the project uses
 * "module": "commonjs" in tsconfig.
 */

import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { v4 as uuidv4 } from 'uuid';
import { ensurePiExecutorProfile, removePiExecutorProfile } from '../../services/executors/profiles';
import type { PiProvider, PiModel } from '../../types';

// ── Lazy pi-ai module loader ──

let piApi: {
  createModels: typeof import('@earendil-works/pi-ai').createModels;
  openaiProvider: () => any;
  anthropicProvider: () => any;
  googleProvider: () => any;
  deepseekProvider: () => any;
  groqProvider: () => any;
  openrouterProvider: () => any;
  xaiProvider: () => any;
} | null = null;

let piApiLoadPromise: Promise<void> | null = null;

async function ensurePiApiLoaded(): Promise<void> {
  if (piApi) return;
  if (piApiLoadPromise) return piApiLoadPromise;
  piApiLoadPromise = (async () => {
    const main = await import('@earendil-works/pi-ai');
    const [openai, anthropic, google, deepseek, groq, openrouter, xai] = await Promise.all([
      // @ts-expect-error — pi-ai uses subpath exports; tsc can't resolve with classic moduleResolution
      import('@earendil-works/pi-ai/providers/openai'),
      // @ts-expect-error
      import('@earendil-works/pi-ai/providers/anthropic'),
      // @ts-expect-error
      import('@earendil-works/pi-ai/providers/google'),
      // @ts-expect-error
      import('@earendil-works/pi-ai/providers/deepseek'),
      // @ts-expect-error
      import('@earendil-works/pi-ai/providers/groq'),
      // @ts-expect-error
      import('@earendil-works/pi-ai/providers/openrouter'),
      // @ts-expect-error
      import('@earendil-works/pi-ai/providers/xai'),
    ]);
    piApi = {
      createModels: main.createModels,
      openaiProvider: openai.openaiProvider,
      anthropicProvider: anthropic.anthropicProvider,
      googleProvider: google.googleProvider,
      deepseekProvider: deepseek.deepseekProvider,
      groqProvider: groq.groqProvider,
      openrouterProvider: openrouter.openrouterProvider,
      xaiProvider: xai.xaiProvider,
    };
  })();
  return piApiLoadPromise;
}

function getPiApi() {
  if (!piApi) {
    ensurePiApiLoaded().catch(() => {});
    throw new Error('Pi-AI module not yet loaded — retry the request');
  }
  return piApi;
}

/** Wait for pi-ai module to be loaded (async, for route handlers) */
async function waitForPiApi(): Promise<void> {
  if (piApi) return;
  await ensurePiApiLoaded();
}

/** Built-in provider type → factory function lookup */
function getFactoryFn(providerType: string): (() => any) | undefined {
  const factories: Record<string, () => any> = {
    openai: getPiApi().openaiProvider,
    anthropic: getPiApi().anthropicProvider,
    google: getPiApi().googleProvider,
    deepseek: getPiApi().deepseekProvider,
    groq: getPiApi().groqProvider,
    openrouter: getPiApi().openrouterProvider,
    xai: getPiApi().xaiProvider,
  };
  return factories[providerType];
}

/**
 * Build a pi-ai provider object from DB row, applying custom base_url if set.
 * Only works for built-in provider types. Custom providers are queried via
 * direct API calls in the model listing handler.
 * NOTE: requires pi-ai module to be loaded (call waitForPiApi() first for built-ins).
 */
function buildProviderFromDb(row: PiProvider & { credential_json?: string | null }): any {
  if (row.provider_type === 'custom') return null; // handled separately

  const factory = getFactoryFn(row.provider_type);
  if (!factory) return null;
  const provider = factory();
  if (row.base_url) {
    provider.baseUrl = row.base_url;
  }
  return provider;
}

export function registerPiAiRoutes(fastify: FastifyInstance): void {
  // Kick off pi-ai module loading (async, non-blocking)
  ensurePiApiLoaded().catch(() => {});
  // ── Provider CRUD ──

  /** GET /pi-ai/providers — list all providers */
  fastify.get('/pi-ai/providers', async () => {
    const db = getDatabase();
    const rows = db.prepare(
      "SELECT id, name, provider_type, base_url, extra_headers_json, is_builtin, created_at, updated_at FROM pi_providers ORDER BY is_builtin DESC, name ASC"
    ).all() as PiProvider[];

    // Also load credential status for each
    const credRows = db.prepare(
      'SELECT provider_id, credential_json FROM pi_credentials'
    ).all() as { provider_id: string; credential_json: string }[];
    const credMap = new Map(credRows.map(r => [r.provider_id, true]));

    return {
      providers: rows.map(r => ({
        id: r.id,
        name: r.name,
        provider_type: r.provider_type,
        base_url: r.base_url,
        is_builtin: !!r.is_builtin,
        has_credential: credMap.has(r.id),
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  });

  /** POST /pi-ai/providers — create a new provider */
  fastify.post<{ Body: { name: string; provider_type: string; base_url?: string; extra_headers?: Record<string, string> } }>(
    '/pi-ai/providers',
    async (request, reply) => {
      const { name, provider_type, base_url, extra_headers } = request.body;
      if (!name || !provider_type) {
        return reply.status(400).send({ error: 'name and provider_type are required' });
      }

      const id = `${provider_type}-${uuidv4().slice(0, 8)}`;
      // Known built-in types — no need to load pi-ai module for this check
      const knownBuiltins = ['openai', 'anthropic', 'google', 'deepseek', 'groq', 'openrouter', 'xai'];
      const isBuiltin = knownBuiltins.includes(provider_type) ? 1 : 0;

      const db = getDatabase();
      db.prepare(`
        INSERT INTO pi_providers (id, name, provider_type, base_url, extra_headers_json, is_builtin)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, name, provider_type, base_url || null, JSON.stringify(extra_headers || {}), isBuiltin);

      return { ok: true, id };
    },
  );

  /** PUT /pi-ai/providers/:pid — update a provider */
  fastify.put<{ Params: { pid: string }; Body: { name?: string; base_url?: string | null; extra_headers?: Record<string, string> } }>(
    '/pi-ai/providers/:pid',
    async (request, reply) => {
      const { pid } = request.params;
      const { name, base_url, extra_headers } = request.body;
      const db = getDatabase();

      const existing = db.prepare('SELECT id, is_builtin FROM pi_providers WHERE id = ?').get(pid) as { id: string; is_builtin: number } | undefined;
      if (!existing) {
        return reply.status(404).send({ error: 'Provider not found' });
      }

      const updates: string[] = [];
      const params: any[] = [];
      if (name !== undefined) { updates.push('name = ?'); params.push(name); }
      if (base_url !== undefined) { updates.push('base_url = ?'); params.push(base_url); }
      if (extra_headers !== undefined) { updates.push('extra_headers_json = ?'); params.push(JSON.stringify(extra_headers)); }
      if (updates.length === 0) return { ok: true };

      updates.push("updated_at = datetime('now')");
      params.push(pid);
      db.prepare(`UPDATE pi_providers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return { ok: true };
    },
  );

  /** DELETE /pi-ai/providers/:pid — delete a custom provider */
  fastify.delete<{ Params: { pid: string } }>(
    '/pi-ai/providers/:pid',
    async (request, reply) => {
      const { pid } = request.params;
      const db = getDatabase();

      const existing = db.prepare('SELECT id, is_builtin FROM pi_providers WHERE id = ?').get(pid) as { id: string; is_builtin: number } | undefined;
      if (!existing) {
        return reply.status(404).send({ error: 'Provider not found' });
      }
      if (existing.is_builtin) {
        return reply.status(400).send({ error: 'Cannot delete built-in provider' });
      }

      db.prepare('DELETE FROM pi_providers WHERE id = ?').run(pid);
      return { ok: true };
    },
  );

  // ── Model listing (from live API) ──

  /** GET /pi-ai/providers/:pid/models — query available models from live API */
  fastify.get<{ Params: { pid: string } }>(
    '/pi-ai/providers/:pid/models',
    async (request, reply) => {
      const { pid } = request.params;
      const db = getDatabase();

      const provider = db.prepare(
        'SELECT id, name, provider_type, base_url, extra_headers_json FROM pi_providers WHERE id = ?'
      ).get(pid) as PiProvider | undefined;
      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }

      // Load credential
      const cred = db.prepare(
        'SELECT credential_json FROM pi_credentials WHERE provider_id = ?'
      ).get(pid) as { credential_json: string } | undefined;

      try {
        // Custom provider — query OpenAI-compatible /v1/models endpoint directly
        if (provider.provider_type === 'custom') {
          const baseUrl = provider.base_url || '';
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (cred?.credential_json) {
            const parsed = JSON.parse(cred.credential_json);
            if (parsed.key) headers['Authorization'] = `Bearer ${parsed.key}`;
          }
          const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers });
          if (!resp.ok) throw new Error(`API returned ${resp.status}`);
          const data = await resp.json() as any;
          const modelList = (data.data || data.models || []).map((m: any) => ({
            id: m.id,
            name: m.id,
            contextWindow: null,
            maxTokens: null,
            reasoning: false,
            vision: false,
            cost: null,
          }));
          return { models: modelList };
        }

        // Built-in provider — need pi-ai module
        await waitForPiApi();
        const piProviderObj = buildProviderFromDb({ ...provider, credential_json: cred?.credential_json || null });
        if (!piProviderObj) {
          return reply.status(400).send({ error: `Unsupported provider type: ${provider.provider_type}` });
        }

        const api = getPiApi();
        const models = api.createModels();
        models.setProvider(piProviderObj);

        const providerModels = models.getModels(pid) || [];
        return {
          models: providerModels.map((m: any) => ({
            id: m.id,
            name: m.name,
            api: m.api,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: !!m.reasoning,
            vision: (m.input || []).includes('image'),
            cost: m.cost || null,
          })),
        };
      } catch (err: any) {
        return reply.status(502).send({ error: `Failed to query models: ${err.message}` });
      }
    },
  );

  // ── Model management (pi_models table — user-selected models) ──

  /** GET /pi-ai/providers/:pid/selected-models — list user-selected models for a provider */
  fastify.get<{ Params: { pid: string } }>(
    '/pi-ai/providers/:pid/selected-models',
    async (request, reply) => {
      const { pid } = request.params;
      const db = getDatabase();

      const rows = db.prepare(
        'SELECT id, provider_id, model_id, display_name, context_window, max_tokens, supports_reasoning, supports_vision, created_at FROM pi_models WHERE provider_id = ? ORDER BY model_id ASC'
      ).all(pid) as PiModel[];

      return { models: rows };
    },
  );

  /** POST /pi-ai/providers/:pid/selected-models — add a model to pi_models */
  fastify.post<{ Params: { pid: string }; Body: { model_id: string; display_name?: string; context_window?: number; max_tokens?: number; supports_reasoning?: boolean; supports_vision?: boolean } }>(
    '/pi-ai/providers/:pid/selected-models',
    async (request, reply) => {
      const { pid } = request.params;
      const { model_id, display_name, context_window, max_tokens, supports_reasoning, supports_vision } = request.body;
      if (!model_id) {
        return reply.status(400).send({ error: 'model_id is required' });
      }

      const db = getDatabase();
      const existing = db.prepare('SELECT id FROM pi_models WHERE provider_id = ? AND model_id = ?').get(pid, model_id);
      if (existing) {
        return reply.status(409).send({ error: 'Model already added' });
      }

      const id = uuidv4();
      db.prepare(`
        INSERT INTO pi_models (id, provider_id, model_id, display_name, context_window, max_tokens, supports_reasoning, supports_vision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, pid, model_id, display_name || null, context_window || null, max_tokens || null, supports_reasoning ? 1 : 0, supports_vision ? 1 : 0);

      // Auto-create executor profile + pi_executor_configs for this provider|model combo
      try {
        ensurePiExecutorProfile(db, pid, model_id, display_name, context_window, max_tokens);
      } catch { /* non-fatal: handled via virtual profiles in listing */ }

      return { ok: true, id };
    },
  );

  /** DELETE /pi-ai/providers/:pid/selected-models/:mid — remove a selected model */
  fastify.delete<{ Params: { pid: string; mid: string } }>(
    '/pi-ai/providers/:pid/selected-models/:mid',
    async (request, reply) => {
      const { pid, mid } = request.params;
      const db = getDatabase();

      // Get model_id before deleting (needed for removePiExecutorProfile)
      const model = db.prepare('SELECT model_id FROM pi_models WHERE id = ? AND provider_id = ?').get(mid, pid) as { model_id: string } | undefined;

      const result = db.prepare('DELETE FROM pi_models WHERE id = ? AND provider_id = ?').run(mid, pid);
      if (result.changes === 0) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      // Auto-remove executor profile for this provider|model combo
      if (model) {
        try {
          removePiExecutorProfile(db, pid, model.model_id);
        } catch { /* ignore cleanup errors */ }
      }

      return { ok: true };
    },
  );

  // ── Credential management ──

  /** GET /pi-ai/credentials — list credential status per provider */
  fastify.get('/pi-ai/credentials', async () => {
    const db = getDatabase();
    const rows = db.prepare(
      'SELECT provider_id, credential_json FROM pi_credentials',
    ).all() as { provider_id: string; credential_json: string }[];

    return {
      credentials: rows.map((r) => ({
        provider_id: r.provider_id,
        hint: r.credential_json ? 'stored' : null,
      })),
    };
  });

  /** PUT /pi-ai/credentials/:pid — set/update credential */
  fastify.put<{ Params: { pid: string } }>(
    '/pi-ai/credentials/:pid',
    async (request, reply) => {
      const { pid } = request.params;
      const body = request.body as { apiKey?: string; credential?: any; baseUrl?: string } | null;
      if (!body?.apiKey && !body?.credential) {
        return reply.status(400).send({ error: 'apiKey or credential required' });
      }

      const credential = body.credential || { type: 'api_key', key: body.apiKey };
      const db = getDatabase();

      // If baseUrl provided, update the provider record too
      if (body.baseUrl) {
        db.prepare("UPDATE pi_providers SET base_url = ?, updated_at = datetime('now') WHERE id = ?")
          .run(body.baseUrl, pid);
      }

      db.prepare(`
        INSERT INTO pi_credentials (provider_id, credential_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(provider_id) DO UPDATE SET
          credential_json = excluded.credential_json,
          updated_at = datetime('now')
      `).run(pid, JSON.stringify(credential));

      return { ok: true, provider_id: pid };
    },
  );

  /** DELETE /pi-ai/credentials/:pid — delete credential */
  fastify.delete<{ Params: { pid: string } }>(
    '/pi-ai/credentials/:pid',
    async (request) => {
      const { pid } = request.params;
      const db = getDatabase();
      db.prepare('DELETE FROM pi_credentials WHERE provider_id = ?').run(pid);
      return { ok: true, provider_id: pid };
    },
  );
}
