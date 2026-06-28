/**
 * PiAiAdapter — Adapter for @earendil-works/pi-ai LLM API calls.
 *
 * Unlike CLI adapters (which spawn child processes), this adapter makes
 * direct HTTP API calls via the pi-ai library.  It implements the Adapter
 * interface directly (does not extend BaseCliAdapter).
 *
 * NOTE: All @earendil-works/pi-ai imports are lazy/dynamic to avoid CJS
 * compilation issues — the package is ESM-only and the project uses
 * "module": "commonjs" in tsconfig.
 */

import type { Agent, Project } from '../../../types';
import type { Adapter, AdapterStartInput, AdapterRunHandle, AdapterEventSink } from '../types';
import type { ToolReadinessSummary, ToolReadinessIssue } from '../../tool-readiness';
import type { CredentialStore, Context } from '@earendil-works/pi-ai';
import { HaicoCredentialStore } from '../../pi-ai/credential-store';
import { getDatabase } from '../../../db/database';
import { broadcastToAgent } from '../../../realtime';
import { completeTaskRun } from '../../tasks/completion';
import { getRunTracker } from '../run-tracker';
import logger from '../../../logger';

/** Lazy-loaded pi-ai module reference — loaded once via ensurePiAiLoaded() */
let piApi: {
  createModels: typeof import('@earendil-works/pi-ai').createModels;
  createProvider: typeof import('@earendil-works/pi-ai').createProvider;
  openaiProvider: () => any;
  anthropicProvider: () => any;
  googleProvider: () => any;
  deepseekProvider: () => any;
  groqProvider: () => any;
  openrouterProvider: () => any;
  xaiProvider: () => any;
  /** OpenAI completions (chat) API stream — needed for custom/compatible providers */
  completionsStream: any;
  completionsStreamSimple: any;
} | null = null;

let piApiLoadPromise: Promise<void> | null = null;

async function ensurePiAiLoaded(): Promise<void> {
  if (piApi) return;
  if (piApiLoadPromise) return piApiLoadPromise;
  piApiLoadPromise = (async () => {
    const main = await import('@earendil-works/pi-ai');
    const [openai, anthropic, google, deepseek, groq, openrouter, xai, completions] = await Promise.all([
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
      // @ts-expect-error — openai-completions for custom providers (chat, not responses API)
      import('@earendil-works/pi-ai/api/openai-completions'),
    ]);
    piApi = {
      createModels: main.createModels,
      createProvider: main.createProvider,
      openaiProvider: openai.openaiProvider,
      anthropicProvider: anthropic.anthropicProvider,
      googleProvider: google.googleProvider,
      deepseekProvider: deepseek.deepseekProvider,
      groqProvider: groq.groqProvider,
      openrouterProvider: openrouter.openrouterProvider,
      xaiProvider: xai.xaiProvider,
      completionsStream: completions.stream,
      completionsStreamSimple: completions.streamSimple,
    };
  })();
  return piApiLoadPromise;
}

/** Synchronous getter — throws if pi-ai module is not yet loaded */
function getPiApi() {
  if (!piApi) {
    // Kick off loading so it's available next time
    ensurePiAiLoaded().catch(() => {});
    throw new Error('Pi-AI module not yet loaded — retry the request');
  }
  return piApi;
}

/** Get built-in factory function by provider type */
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
 * Build a pi-ai provider object from pi_providers DB row.
 * Handles built-in types (with optional base_url override) and custom types
 * (OpenAI-compatible via createProvider).
 */
function buildProviderFromDb(providerId: string): any {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT id, name, provider_type, base_url, extra_headers_json FROM pi_providers WHERE id = ?'
  ).get(providerId) as { id: string; name: string; provider_type: string; base_url: string | null; extra_headers_json: string } | undefined;

  if (!row) throw new Error(`Pi-AI provider "${providerId}" not found in pi_providers table`);

  if (row.provider_type === 'custom') {
    if (!row.base_url) throw new Error(`Custom provider "${providerId}" has no base_url configured`);
    const api = getPiApi();
    const openai = getFactoryFn('openai')!(); // get stream functions for auth only

    // Load selected models from pi_models table so the adapter can find them
    const db = getDatabase();
    const modelRows = db.prepare(
      'SELECT model_id, display_name, context_window, max_tokens, supports_reasoning, supports_vision FROM pi_models WHERE provider_id = ?'
    ).all(providerId) as { model_id: string; display_name: string | null; context_window: number | null; max_tokens: number | null; supports_reasoning: number; supports_vision: number }[];

    const models = modelRows.map(r => ({
      id: r.model_id,
      name: r.display_name || r.model_id,
      api: 'openai-completions' as const,
      provider: row.id,
      baseUrl: row.base_url!,
      reasoning: r.supports_reasoning === 1,
      input: r.supports_vision === 1 ? ['text', 'image'] as ('text' | 'image')[] : ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: r.context_window ?? 0,
      maxTokens: r.max_tokens ?? 0,
      // Conservative compat for custom/third-party OpenAI-compatible APIs
      compat: {
        supportsUsageInStreaming: false,
        maxTokensField: 'max_tokens' as const,
        supportsStore: false,
        supportsDeveloperRole: false,
      },
    }));

    return api.createProvider({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      headers: row.extra_headers_json ? JSON.parse(row.extra_headers_json) : undefined,
      auth: openai.auth, // reuse OpenAI auth handling (Bearer token)
      // Use openai-completions API (chat completions, NOT responses API)
      api: { stream: getPiApi().completionsStream, streamSimple: getPiApi().completionsStreamSimple },
      models,
    });
  }

  // Built-in provider type
  const factory = getFactoryFn(row.provider_type);
  if (!factory) throw new Error(`Unknown pi-ai provider type: ${row.provider_type}`);
  const provider = factory();
  if (row.base_url) {
    provider.baseUrl = row.base_url;
  }
  return provider;
}

export class PiAiAdapter implements Adapter {
  readonly type = 'pi-ai';
  readonly requiresCompletionSignal = false;
  readonly chatTimeoutMs = 120000;

  private credentialStore: CredentialStore = new HaicoCredentialStore();
  private abortControllers = new Map<string, AbortController>();
  private runningSince = new Map<string, number>();

  // ── Core Adapter methods ──

  start(input: AdapterStartInput, _sink: AdapterEventSink): AdapterRunHandle {
    const db = getDatabase();
    const { agent, taskRunId, taskId, runId, prompt, systemPrompt } = input;

    // Ensure pi-ai is loaded (will throw on first call to signal retry)
    const api = getPiApi();

    // Read pi-ai config from pi_executor_configs
    const piConfig = input.executorProfileId
      ? this.readPiConfig(input.executorProfileId)
      : null;
    if (!piConfig) {
      throw new Error('Pi-AI adapter requires a pi_executor_config entry');
    }

    // Build provider from pi_providers table (supports custom base_url, custom types)
    const provider = buildProviderFromDb(piConfig.provider_id);

    // Create Models collection with HAICO's credential store
    const models = api.createModels({ credentials: this.credentialStore });
    models.setProvider(provider);

    // Resolve model
    const model = models.getModel(piConfig.provider_id, piConfig.model_id);
    if (!model) {
      throw new Error(
        `Model "${piConfig.model_id}" not found for provider "${piConfig.provider_id}"`,
      );
    }

    // Build pi-ai Context
    const context: Context = {
      systemPrompt: piConfig.system_prompt || systemPrompt || undefined,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    };

    // AbortController
    const controller = new AbortController();
    this.abortControllers.set(taskRunId, controller);
    this.runningSince.set(taskRunId, Date.now());

    // Update task_runs
    const commandSnapshot = JSON.stringify({
      type: 'pi-ai',
      provider_id: piConfig.provider_id,
      model_id: piConfig.model_id,
      temperature: piConfig.temperature,
      max_tokens: piConfig.max_tokens,
    });
    db.prepare(`
      UPDATE task_runs
      SET status = 'running', pid = 0, command_snapshot = ?, prompt_snapshot = ?, started_at = datetime('now')
      WHERE id = ?
    `).run(commandSnapshot, prompt, taskRunId);

    db.prepare(
      'UPDATE tasks SET status = ?, started_at = COALESCE(started_at, datetime(\'now\')), updated_at = datetime(\'now\') WHERE id = ?',
    ).run('running', taskId);

    // Write stdin to conversation_logs
    const logStmt = db.prepare(
      'INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, ?)',
    );
    logStmt.run(agent.id, runId, prompt, 'stdin');

    // logAndBroadcast helper
    const logAndBroadcast = (content: string, stream: 'stdout' | 'stderr') => {
      if (!content.trim()) return;
      try {
        logStmt.run(agent.id, runId, content, stream);
      } catch { /* ignore write failures during shutdown */ }
      broadcastToAgent(agent.id, { type: 'output', stream, content, runId });
    };

    // Start the stream (non-blocking)
    const streamOptions: Record<string, unknown> = {
      signal: controller.signal,
      temperature: piConfig.temperature,
      maxTokens: piConfig.max_tokens,
    };
    if (piConfig.reasoning_effort) {
      streamOptions.reasoning = piConfig.reasoning_effort;
    }
    if (piConfig.extra_params_json) {
      try {
        Object.assign(streamOptions, JSON.parse(piConfig.extra_params_json));
      } catch { /* ignore bad extra params */ }
    }

    const piStream = models.stream(model, context, streamOptions as any);

    // Log request for debugging
    logger.info({
      provider_id: piConfig.provider_id,
      model_id: piConfig.model_id,
      systemPromptLength: (piConfig.system_prompt || systemPrompt || '').length,
      promptLength: prompt.length,
    }, 'pi-ai.start.stream');

    // Register with run tracker so watchdog knows this run is alive
    getRunTracker().register(taskRunId, this);

    // Process stream asynchronously
    this.processStream(piStream, {
      agent, taskRunId, runId, logAndBroadcast, db,
    });

    return { runId, sessionId: `${piConfig.provider_id}/${piConfig.model_id}` };
  }

  private async processStream(
    stream: AsyncIterable<unknown>,
    ctx: {
      agent: Agent;
      taskRunId: string;
      runId: string;
      logAndBroadcast: (content: string, stream: 'stdout' | 'stderr') => void;
      db: ReturnType<typeof getDatabase>;
    },
  ): Promise<void> {
    let stopReason = 'error';
    const { agent, taskRunId, runId, logAndBroadcast, db } = ctx;

    try {
      for await (const event of stream as any) {
        switch (event.type) {
          case 'text_delta':
            logAndBroadcast(event.delta, 'stdout');
            break;
          case 'thinking_delta':
            // Forward thinking content as stdout with prefix
            logAndBroadcast(event.delta, 'stdout');
            break;
          case 'toolcall_end':
            logAndBroadcast(
              `[Tool: ${event.toolCall.name}] ${JSON.stringify(event.toolCall.arguments)}\n`,
              'stdout',
            );
            break;
          case 'done':
            stopReason = event.reason;
            if (event.message?.usage) {
              const u = event.message.usage;
              const costLabel = u.cost?.total ? ` | Cost: $${u.cost.total.toFixed(4)}` : '';
              logAndBroadcast(
                `\n--- Tokens: ${u.input || 0} in, ${u.output || 0} out${costLabel} ---\n`,
                'stdout',
              );
              // Record cost in conversation_logs
              try {
                const costStmt = db.prepare(
                  'INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, ?)',
                );
                costStmt.run(agent.id, runId, JSON.stringify(u), 'cost');
              } catch { /* ignore */ }
            }
            break;
          case 'error':
            stopReason = 'error';
            logAndBroadcast(`\n[Error: ${event.error?.errorMessage || 'unknown'}]\n`, 'stderr');
            break;
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        stopReason = 'aborted';
      } else {
        stopReason = 'error';
        logAndBroadcast(`\n[Stream error: ${err?.message || String(err)}]\n`, 'stderr');
      }
    } finally {
      // Cleanup
      this.abortControllers.delete(taskRunId);
      this.runningSince.delete(taskRunId);
      getRunTracker().unregister(taskRunId);

      // Determine final status
      const isSuccess = stopReason === 'stop' || stopReason === 'toolUse' || stopReason === 'length';
      const taskRunStatus = isSuccess ? 'completed' : 'failed';

      if (taskRunStatus === 'failed') {
        logAndBroadcast(`HAICO: pi-ai stopped with reason: ${stopReason}\n`, 'stderr');
      }

      completeTaskRun({
        taskRunId,
        exitCode: isSuccess ? 0 : 1,
        status: taskRunStatus,
        failureKind: taskRunStatus === 'failed' ? 'process_error' : null,
        failureMessage:
          taskRunStatus === 'failed' ? `pi-ai stopped: ${stopReason}` : null,
      });

      broadcastToAgent(agent.id, { type: 'exit', code: isSuccess ? 0 : 1, runId });
    }
  }

  stop(taskRunId: string): boolean {
    const controller = this.abortControllers.get(taskRunId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(taskRunId: string): boolean {
    return this.abortControllers.has(taskRunId);
  }

  getIdleMs(taskRunId: string): number {
    const since = this.runningSince.get(taskRunId);
    return since !== undefined ? Date.now() - since : -1;
  }

  async stopAll(): Promise<void> {
    for (const [id, controller] of this.abortControllers) {
      controller.abort();
      this.abortControllers.delete(id);
      this.runningSince.delete(id);
    }
  }

  // ── Readiness check ──

  inspectReadiness(_commandTemplate: string): ToolReadinessSummary {
    const issues: ToolReadinessIssue[] = [];

    try {
      const api = getPiApi();
      const models = api.createModels({ credentials: this.credentialStore });

      // Check providers from DB and built-in factories
      const db = getDatabase();
      const providerRows = db.prepare(
        "SELECT id, provider_type, base_url FROM pi_providers ORDER BY is_builtin DESC"
      ).all() as { id: string; provider_type: string; base_url: string | null }[];
      const configured: string[] = [];

      for (const row of providerRows) {
        try {
          const provider = buildProviderFromDb(row.id);
          models.setProvider(provider);
          const anyModel = models.getModels(row.id)?.[0];
          if (anyModel) {
            configured.push(row.id);
          }
        } catch {
          // skip providers that can't be loaded (e.g. custom without base_url)
        }
      }

      if (configured.length === 0) {
        issues.push({
          code: 'auth_missing' as const,
          severity: 'blocking',
          title: 'No Pi-AI providers configured',
          detail: 'Add at least one API key in Settings → Pi-AI Providers, or set environment variables (OPENAI_API_KEY, etc.).',
          action_label: 'Configure',
          action_command: '/settings/pi-providers',
        });
      }

      return {
        command: 'pi-ai',
        command_type: 'pi-ai' as any,
        tool_label: 'Pi-AI',
        binary: '',
        binary_found: true,
        binary_path: null,
        ready: configured.length > 0,
        issues,
        auth: { status: configured.length > 0 ? 'configured' : 'unknown', confidence: 'heuristic', message: '', action_command: null },
      };
    } catch {
      // Module not loaded yet — report as not ready
      return {
        command: 'pi-ai',
        command_type: 'pi-ai' as any,
        tool_label: 'Pi-AI',
        binary: '',
        binary_found: true,
        binary_path: null,
        ready: false,
        issues: [{
          code: 'auth_missing',
          severity: 'blocking',
          title: 'Pi-AI module loading',
          detail: 'Pi-AI adapter module is still initializing. Retry shortly.',
          action_label: null,
          action_command: null,
        }],
        auth: { status: 'unknown', confidence: 'heuristic', message: '', action_command: null },
      };
    }
  }

  // ── Default no-op methods (pi-ai doesn't need CLI-specific operations) ──

  buildSystemPromptSection(_agent: Agent, _project: Project): string {
    return '';
  }

  buildPtyArgs(_commandTemplate: string, _sessionId?: string): { command: string; args: string[]; useShell: boolean } {
    return { command: 'pi-ai', args: [], useShell: false };
  }

  buildMetadataCommand(_commandTemplate: string): string {
    return 'pi-ai';
  }

  buildChatCommand(_commandTemplate: string): { command: string; binary: string } {
    return { command: 'pi-ai', binary: 'pi-ai' };
  }

  buildControllerCommand(_commandTemplate: string, _commandProfileConfigJson?: string | Record<string, unknown> | null): string {
    return 'pi-ai';
  }

  buildProcessCommand(_input: { commandTemplate: string; sessionId: string; existingSessionId: string | null; commandProfileConfigJson: string }): { command: string; useStreamJson: boolean } {
    return { command: 'pi-ai', useStreamJson: false };
  }

  // ── Helpers ──

  private readPiConfig(executorProfileId: string): {
    provider_id: string;
    model_id: string;
    temperature: number;
    max_tokens: number;
    system_prompt: string;
    reasoning_effort: string | null;
    extra_params_json: string;
  } | null {
    const db = getDatabase();
    try {
      const row = db.prepare(
        'SELECT provider_id, model_id, temperature, max_tokens, system_prompt, reasoning_effort, extra_params_json FROM pi_executor_configs WHERE executor_profile_id = ?',
      ).get(executorProfileId) as any;
      if (!row) return null;
      return {
        provider_id: row.provider_id,
        model_id: row.model_id,
        temperature: row.temperature ?? 0.7,
        max_tokens: row.max_tokens ?? 4096,
        system_prompt: row.system_prompt ?? '',
        reasoning_effort: row.reasoning_effort ?? null,
        extra_params_json: row.extra_params_json ?? '{}',
      };
    } catch (err) {
      logger.error({ err, executorProfileId }, 'pi-ai.read_pi_config_error');
      return null;
    }
  }
}
