<p align="center">
  <img src="https://haico.dev/images/haico-og-preview-1200.png" alt="HAICO overview showing desktop and mobile views" width="100%" />
</p>

<div align="center">

# Human-Agent Interactive Collaboration Orchestrator (HAICO)

### A shared workspace for humans and AI agents

**Run multi-agent projects with built-in issues, knowledge, and live dashboards, while keeping humans in the loop.**

[![npm version](https://img.shields.io/npm/v/haico?color=cb3837&logo=npm)](https://www.npmjs.com/package/haico)
[![Website](https://img.shields.io/badge/Website-haico.dev-245a93?logo=googlechrome&logoColor=white)](https://haico.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/fuzihaofzh/haico/pulls)

[Website](https://haico.dev) · [Quick Start](#quick-start) · [Product Tour](#product-tour) · [Key Features](#key-features) · [How It Works](#how-it-works) · [Contributing](#contributing)

</div>

---

<p align="center">
  <em>One control plane for humans and autonomous agents: triage issues, monitor spend, and keep every project in sync.</em>
</p>

<p align="center">
  <strong>Official website:</strong> <a href="https://haico.dev">haico.dev</a>
</p>

---

## The Problem

You have several complex projects. You spin up multiple AI agents. They move fast, but without shared context and oversight, they drift, duplicate work, and burn tokens. **Agents alone are not enough for complex workflows. Humans need to stay in the loop.**

## The Solution

HAICO creates a **shared workspace** where humans and AI agents collaborate as a team. A controller decomposes work, workers execute it, and the dashboard keeps humans in the loop with issues, knowledge, terminals, files, and usage in one place. Think of it as **GitHub Issues + agent orchestration with human oversight** in one platform.

```
                    ┌──────────────┐
                    │  Controller  │  Decomposes tasks, assigns work
                    │    Agent     │  monitors progress
                    └──────┬───────┘
                           │ creates & assigns issues
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Worker 1 │ │ Worker 2 │ │ Worker N │
        │ (Claude) │ │ (Codex)  │ │  (Any)   │
        └──────────┘ └──────────┘ └──────────┘
              │            │            │
              └────────────┴────────────┘
                    Shared Issue Tracker
                    Knowledge Base & Agent Knowledge
                    Real-time Web Dashboard
```

---

## Product Tour

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="https://haico.dev/images/haico-beacon-clinical-operations-overview-nord-light.png" alt="HAICO project overview dashboard" />
      <br />
      <strong>Project Overview</strong>
      <br />
      Agent health, issue progress, and spend in one view.
    </td>
    <td width="50%" valign="top">
      <img src="https://haico.dev/images/haico-beacon-clinical-operations-agents-nord-light.png" alt="HAICO agent collaboration tree" />
      <br />
      <strong>Agent Collaboration Tree</strong>
      <br />
      Trace controller-worker relationships and live execution.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="https://haico.dev/images/haico-beacon-clinical-operations-issues-nord-light.png" alt="HAICO built-in issue tracker" />
      <br />
      <strong>Built-In Issue Tracker</strong>
      <br />
      Track work status without leaving the workspace.
    </td>
    <td width="50%" valign="top">
      <img src="https://haico.dev/images/haico-beacon-adverse-event-handoff-issue-detail-nord-light.png" alt="HAICO issue detail workflow view" />
      <br />
      <strong>Issue Detail Workflow</strong>
      <br />
      Review assignees, comments, status, and agent output.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="https://haico.dev/images/haico-usage-dashboard-nord-light.png" alt="HAICO usage and cost dashboard" />
      <br />
      <strong>Usage Visibility</strong>
      <br />
      Monitor spend before autonomous runs drift out of bounds.
    </td>
    <td width="50%" valign="top">
      <img src="https://haico.dev/images/haico-approval-queue-nord-light.png" alt="HAICO workflow visualization" />
      <br />
      <strong>Workflow Visualization</strong>
      <br />
      Real-time agent hierarchy and orchestration status.
    </td>
  </tr>
</table>

---

## Why HAICO?

| | Single Agent | HAICO |
|---|---|---|
| **Task Complexity** | Gets lost on multi-step projects | Controller decomposes, workers execute in parallel |
| **Context Window** | One agent carries everything | Each agent focuses on its assigned scope |
| **Cost Control** | Burns tokens on tangents | Token budgets, tail-request detection, auto-cooldown |
| **Coordination** | N/A | Issue tracker, knowledge base, direct messaging |
| **Visibility** | Black box | Real-time terminal, issue timeline, cost dashboard |
| **Persistence** | Session dies, context lost | Agent-owned knowledge survives across sessions |

---

## Key Features

**Orchestration**
- Hierarchical agent teams with controller/worker roles and parent-child relationships
- Two orchestration engines: **Native** (direct) and **LangGraph** (agentic reasoning with tool use)
- Task-based execution: manual starts, issue assignments, messages, and controller runs are queued as durable tasks

**Collaboration**
- Built-in issue tracker with priorities, labels, assignments, dependencies, and sub-issues
- Shared knowledge base — high-importance entries auto-injected into agent prompts
- Per-agent owned knowledge items that persist across sessions
- Direct messaging between agents

**Operations**
- Task runtime with scheduler, executor profiles, retryable TaskRuns, and watchdog detection for stuck runs
- Token budgets with tail-request avoidance to prevent runaway costs
- Session persistence with auto-resumption and cooldown

**Dashboard**
- Real-time terminal via xterm.js + WebSocket
- Issue management with full comment timelines
- File upload, download, and preview (PDF, HTML)
- Multi-user auth with role-based access control

---

## Quick Start

### Prerequisites

- Node.js >= 18

### Option 1: Global Install (recommended)

```bash
npm install -g haico
haico
```

That's it. Open `http://localhost:4567`.

```bash
# CLI options
haico --port 8080 --host 0.0.0.0 --db ./my-project.db

# Development convenience: create/reset a real admin user at startup
haico --default-admin
```

Maintenance commands:

```bash
# Create a member user and enter the password interactively
haico create-user alice

# Create an admin user in a specific database
haico create-user alice --role admin --db ./my-project.db

# Reset a user's password interactively
haico reset-password alice

# Generate and print a random password once
haico reset-password alice --random
```

### Option 2: Clone & Run

```bash
git clone https://github.com/fuzihaofzh/haico.git
cd haico
npm install

# Development (auto-reload)
npm run dev

# Production
npm run build && npm start
```

On first visit, you'll be prompted to create an admin account.

For local development or test environments, you can ask HAICO to bootstrap a
real admin user on startup:

```bash
HAICO_DEFAULT_ADMIN=true haico
```

The username is always `haico_default_admin`. If no password is configured,
HAICO generates a new random password on each startup, resets that user's
password, clears its old sessions, and prints the generated password once. To
use a fixed development password, set `HAICO_DEFAULT_ADMIN_PASSWORD`; HAICO will
not print the fixed password and will log a warning because this is not
recommended for production.

### Option 3: Build the macOS Desktop App

```bash
git clone https://github.com/fuzihaofzh/haico.git
cd haico
npm install
npm run build:electron
open dist/electron/HAICO-darwin-*/HAICO.app
```

The Electron app bundles the HAICO server, frontend assets, production dependencies, and a Node.js runtime into a standalone `.app`. When launched from the packaged app, the default SQLite database is stored in `~/Library/Application Support/HAICO/haico.db`.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HAICO_PORT` | `4567` | Server port |
| `HAICO_HOST` | `0.0.0.0` | Bind address |
| `HAICO_DB_PATH` | `./haico.db` | SQLite database path |
| `HAICO_ORCHESTRATOR_ENGINE` | `langgraph` | `native` or `langgraph` |
| `HAICO_DEFAULT_ADMIN` | `false` | When `true`, ensure `haico_default_admin` exists as an admin user |
| `HAICO_DEFAULT_ADMIN_PASSWORD` | unset | Optional fixed password for the default admin; intended for development/test only |

---

## How It Works

### 1. Create a Project
Define a project with a task description — this is the mission your agent team will tackle.

### 2. Set Up Your Team
- Add a **Controller** agent — it reads the task, creates issues, and assigns work
- Add **Worker** agents — each with a role, working directory, and optional custom instructions
- Agents can be organized hierarchically (parent-child relationships)

### 3. Launch
Start the controller. It will:
1. Analyze the project task
2. Decompose it into issues on the built-in tracker
3. Assign issues to worker agents
4. Queue Tasks for workers and let the scheduler execute TaskRuns
5. Coordinate until the project is complete

### 4. Monitor Everything
The web dashboard gives you full visibility — real-time terminal output, issue timelines, knowledge base, file browser, and cost tracking.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Web Dashboard (HTML/JS)             │
│   Projects · Agents · Issues · Terminal · Files  │
└────────────────────┬────────────────────────────┘
                     │ HTTP + WebSocket
┌────────────────────▼────────────────────────────┐
│                Fastify Server                    │
│                                                  │
│  Routes ─── Auth ─── WebSocket                   │
│    │                                             │
│  Services                                        │
│    ├── Orchestrator (Native / LangGraph)         │
│    ├── Controller & Pre-Controller               │
│    ├── Task Runtime (Task / TaskRun lifecycle)   │
│    ├── Scheduler + Watchdog                      │
│    ├── Executors (CLI spawn + session resume)    │
│    ├── Terminal (xterm.js bridge)                │
│    └── Agent Hierarchy                           │
│    │                                             │
│  SQLite (better-sqlite3)                         │
│    projects · agents · issues · knowledge ·      │
│    tasks · task_runs · messages · users          │
└──────────────────────────────────────────────────┘
```

**Tech Stack**: TypeScript · Fastify · SQLite · LangChain/LangGraph · xterm.js · WebSocket

---

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

```bash
# Dev mode with auto-reload
npm run dev

# Build
npm run build

# Run tests
npm test
```

---

## License

[MIT](LICENSE)

---

<div align="center">

**Built for teams where humans and agents work side by side.**

[GitHub](https://github.com/fuzihaofzh/haico) · [npm](https://www.npmjs.com/package/haico)

</div>
