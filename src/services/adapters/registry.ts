/**
 * AdapterRegistry — maps type identifiers to adapter implementations.
 *
 * The registry is a catalog of pre-built adapters.  Users pick an adapter
 * type + parameters when configuring an agent; the registry resolves the
 * type string to the concrete Adapter instance.
 */

import type { Adapter, AdapterRegistry } from './types';
import { detectCommandTypeFromCommand } from '../command-profiles';

class AdapterRegistryImpl implements AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.type)) {
      throw new Error(`Adapter type "${adapter.type}" is already registered`);
    }
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): Adapter | undefined {
    return this.adapters.get(type);
  }

  listTypes(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Resolve an adapter from the command template and optional explicit type.
   * Falls back to shell adapter if no type matches.
   * For 'pi-ai' type, awaits the lazy-loaded PiAiAdapter if needed.
   */
  resolveFromCommand(commandTemplate: string, explicitType?: string | null): Adapter {
    // 1. Explicit type takes precedence
    if (explicitType) {
      const adapter = this.adapters.get(explicitType);
      if (adapter) return adapter;
      // If pi-ai type is requested but not loaded yet, throw to signal async load
      if (explicitType === 'pi-ai') {
        throw new Error('Pi-AI adapter not yet loaded — retry the request');
      }
    }

    // 2. Detect from command template
    const detected = detectCommandTypeFromCommand(commandTemplate);
    if (detected) {
      const adapter = this.adapters.get(detected);
      if (adapter) return adapter;
    }

    // 3. Fallback to shell adapter
    const shell = this.adapters.get('shell');
    if (shell) return shell;

    throw new Error('No shell adapter registered — registry not initialized');
  }
}

// ── Global singleton ──

let globalRegistry: AdapterRegistryImpl | null = null;

function ensureRegistry(): AdapterRegistryImpl {
  if (!globalRegistry) {
    globalRegistry = new AdapterRegistryImpl();
    registerBuiltinAdapters(globalRegistry);
    // PiAiAdapter is loaded asynchronously to avoid ESM/CJS interop issues
    ensurePiAiAdapter(globalRegistry).catch(() => {
      // Non-fatal: pi-ai adapter simply won't be available
    });
  }
  return globalRegistry;
}

export function getAdapterRegistry(): AdapterRegistry {
  return ensureRegistry();
}

/** Reset the registry (for tests only) */
export function resetAdapterRegistry(): void {
  globalRegistry = null;
  piAiAdapterPromise = null;
}

/** Register all built-in adapters */
function registerBuiltinAdapters(registry: AdapterRegistryImpl): void {
  const { ClaudeCliAdapter } = require('./claude') as typeof import('./claude');
  const { CodexCliAdapter } = require('./codex') as typeof import('./codex');
  const { GeminiCliAdapter } = require('./gemini') as typeof import('./gemini');
  const { ShellAdapter } = require('./shell') as typeof import('./shell');
  const { OmpCliAdapter } = require('./omp') as typeof import('./omp');

  registry.register(new ClaudeCliAdapter());
  registry.register(new CodexCliAdapter());
  registry.register(new GeminiCliAdapter());
  registry.register(new ShellAdapter());
  registry.register(new OmpCliAdapter());
}

/** Lazy-load PiAiAdapter to avoid ESM/CJS interop issues with @earendil-works/pi-ai */
let piAiAdapterPromise: Promise<void> | null = null;
async function ensurePiAiAdapter(registry: AdapterRegistryImpl): Promise<void> {
  if (piAiAdapterPromise) return piAiAdapterPromise;
  piAiAdapterPromise = (async () => {
    // CJS module loaded via ESM dynamic import wraps exports in .default
    const mod = await import('./pi-ai') as any;
    const PiAiAdapter = mod.default?.PiAiAdapter ?? mod.PiAiAdapter;
    registry.register(new PiAiAdapter());
  })();
  return piAiAdapterPromise;
}
