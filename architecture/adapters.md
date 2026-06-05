# Agent Adapter Architecture

## 1. Overview

Each AI tool type (claude CLI, codex CLI, gemini CLI, raw shell) is encapsulated
in an **adapter** — a sealed object that knows how to build commands, parse
output, detect readiness, and build type-specific prompt sections.  Consumers
interact only with the `Adapter` interface; they never write `if (type ===
'codex')`.  Adding a new tool type = registering a new adapter, zero
diffusion.

## 2. Core Concepts

### 2.1 Adapter

An adapter encapsulates everything about one underlying AI tool:

| Concern | Method |
|---|---|
| Build the CLI command for a task run | `buildProcessCommand()` |
| Build the controller command (project creation) | `buildControllerCommand()` |
| Parse stdout lines into structured events | `parseOutputLine()` (protected) |
| Detect binary + auth readiness | `inspectReadiness()` |
| Build system prompt section | `buildSystemPromptSection()` |
| Build PTY interactive-terminal args | `buildPtyArgs()` |
| Build one-shot CLI command (metadata/chat) | `buildMetadataCommand()` / `buildChatCommand()` |
| Start / stop a run | `start()` / `stop()` |
| Watchdog queries | `isRunning()` / `getIdleMs()` |

**Adapter is sealed**: spawn, parse, completion detection — all happen inside.
External code only sees structured events via `AdapterEventSink`.

### 2.2 Adapter Registry

The registry maps type identifiers to adapter instances:

```
'claude'  → ClaudeCliAdapter
'codex'   → CodexCliAdapter
'gemini'  → GeminiCliAdapter
'shell'   → ShellAdapter       (fallback: raw command, no structured output)
```

Resolution: `getAdapterRegistry().resolveFromCommand(template, explicitType)`.
Explicit type takes precedence; otherwise `detectCommandTypeFromCommand()`
infers from the binary name in the template; final fallback is the shell
adapter.

### 2.3 BaseCliAdapter

All CLI-based adapters extend `BaseCliAdapter`, which provides shared
infrastructure:

- spawn + stdio management
- prompt file write/cleanup
- env construction (`buildChildEnv`)
- session query/update (`executor_sessions`)
- exit classification (`classifyAgentExitStatus`)
- watchdog state (`lastActivityTime`, `runningProcesses`, `cpuSnapshots`)
- shutdown coordination (`isAdapterShuttingDown`)
- run tracking (`AdapterRunTracker`)

Subclasses override only:

- `buildCommand(input)` → `{ command, useStreamJson }`
- `parseOutputLine(line, state)` → `AdapterRuntimeEvent[]`
- `readonly requiresCompletionSignal`

### 2.4 Event Flow

```
Adapter internal:
  spawn → raw output → parseOutputLine()
                        ↓
                  bridge.onEvent(AdapterRuntimeEvent)

TaskRunEventBridge:
  output/tool_use/tool_result → DB conversation_logs + WS broadcast
  cost                         → DB conversation_logs (cost record)
  completed                    → mark completion signal, update session
  session_updated              → DB executor_sessions
  error (fatal)                → mark failed

Exit classification (inside adapter, not bridge):
  child.on('close') → adapter decides: exit code + internal state
                     → bridge.onEvent(completed) or bridge.onEvent(error)
```

The bridge contains **no type-specific logic** — only generic
event → storage/push mapping.

## 3. Directory Structure

```
src/services/adapters/
├── index.ts                # exports getAdapterRegistry() + public types
├── types.ts                # AdapterRuntimeEvent, Adapter, AdapterStartInput, etc.
├── registry.ts             # AdapterRegistryImpl + global singleton
├── bridge.ts               # TaskRunEventBridge — events → DB/WS/EventBus
├── run-tracker.ts          # AdapterRunTracker — unified query across adapters
├── base-cli-adapter.ts     # shared CLI base (spawn, process mgmt, watchdog)
│
├── claude/
│   └── index.ts            # ClaudeCliAdapter
├── codex/
│   └── index.ts            # CodexCliAdapter
├── gemini/
│   └── index.ts            # GeminiCliAdapter
└── shell/
    └── index.ts            # ShellAdapter (fallback)

src/services/process-manager/
├── shared-state.ts         # agentFinalResultTime Map (shared with watchdog)
├── watchdog.ts             # CPU activity check, final-result age
├── exit-status.ts          # classifyAgentExitStatus (used by base-cli-adapter)
├── policy.ts               # timeouts, cooldown constants
├── controls.ts             # isAgentInCooldown
├── types.ts                # AgentExitStatus type
└── index.ts                # re-exports for consumers
```

## 4. Key Interfaces

See `src/services/adapters/types.ts` for the authoritative definitions.
Summary:

- **`Adapter`** — start/stop/isRunning/getIdleMs/inspectReadiness/
  buildSystemPromptSection/buildPtyArgs/buildMetadataCommand/
  buildChatCommand/buildControllerCommand/buildProcessCommand/stopAll
- **`AdapterRegistry`** — register/get/listTypes/resolveFromCommand
- **`AdapterRuntimeEvent`** — output | tool_use | tool_result | cost |
  completed | error | session_updated
- **`AdapterEventSink`** — `onEvent(event)`
- **`AdapterStartInput`** — agent, taskId, taskRunId, runId, prompt,
  systemPrompt, executor, executorProfileId
- **`AdapterRunHandle`** — runId, pid?, sessionId, command?

## 5. Adding a New Agent Type

### CLI-based

1. Create `src/services/adapters/xxx/index.ts` implementing `Adapter`
2. Extend `BaseCliAdapter`, override `buildCommand()` + `parseOutputLine()`
3. Register in `registry.ts`: `registerBuiltinAdapters()` → `new XxxCliAdapter()`
4. Update DB CHECK constraint on `agents.command_type` and
   `command_profiles.type` if needed

### API-based (future)

1. Create `src/services/adapters/xxx-api/index.ts` implementing `Adapter`
2. **Do not** extend `BaseCliAdapter` (no child process)
3. `start()` uses HTTP client, streaming response → `parseResponse()` → events
4. `pid` is `undefined` (no process)
5. Scheduler needs no changes — it only calls `adapter.start()`

## 6. Known Remaining Work

- **`appendXxxConfigArgs` still in `command-profiles/core.ts`**: These
  functions are only used by their respective adapters. They should be
  moved into the adapter files and deleted from `command-profiles`.
  After that, `command-profiles/core.ts` only retains CRUD functions,
  `detectCommandTypeFromCommand`, and config normalization helpers.
- **DB CHECK constraint**: `agents.command_type` is currently
  `CHECK(command_type IN ('claude','codex','gemini'))`. Adding a new
  type requires a migration. Consider relaxing to application-level
  validation (or auto-generating from `registry.listTypes()`).
- **`process-manager/` cleanup**: `exit-status.ts`, `controls.ts`,
  `types.ts` are thin wrappers consumed only by `base-cli-adapter.ts`
  and `watchdog.ts`. They could be folded into `adapters/` but the
  value is marginal; keeping the current split avoids churn.
