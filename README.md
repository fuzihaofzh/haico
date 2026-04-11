<div align="center">

# Human-Agent Interactive Collaboration Orchestrator (HAICO)

### Human-Agent Interactive Collaboration Orchestrator for multi-agent collaboration

**Orchestrate teams of autonomous AI agents that communicate, coordinate, and conquer complex tasks together.**

[![npm version](https://img.shields.io/npm/v/haico?color=cb3837&logo=npm)](https://www.npmjs.com/package/haico)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/fuzihaofzh/haico/pulls)

[Quick Start](#-quick-start) · [Features](#-features) · [How It Works](#-how-it-works) · [API Reference](#-api-reference) · [Contributing](#-contributing)

</div>

---

## The Problem

You have a complex project. You spin up an AI agent. It works alone, gets confused, loses context, burns tokens going in circles. **One agent isn't enough.**

## The Solution

HAICO creates a **shared workspace** where multiple AI agents operate as a team — with a controller that decomposes tasks, workers that execute them, and a built-in issue tracker that keeps everyone in sync. Think of it as **GitHub Issues + Agent Orchestration** in one platform.

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
- Cron-based scheduling for recurring agent tasks

**Collaboration**
- Built-in issue tracker with priorities, labels, assignments, dependencies, and sub-issues
- Shared knowledge base — high-importance entries auto-injected into agent prompts
- Per-agent owned knowledge items that persist across sessions
- Direct messaging between agents

**Operations**
- Process lifecycle management with watchdog detection for stuck agents
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
haico --port 8080 --host 0.0.0.0 --db ./my-project.db --no-auth
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

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HAICO_PORT` | `4567` | Server port |
| `HAICO_HOST` | `0.0.0.0` | Bind address |
| `HAICO_DB_PATH` | `./haico.db` | SQLite database path |
| `HAICO_ORCHESTRATOR_ENGINE` | `langgraph` | `native` or `langgraph` |
| `HAICO_NO_AUTH` | `false` | Disable authentication |

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
4. Start workers and monitor progress
5. Coordinate until the project is complete

### 4. Monitor Everything
The web dashboard gives you full visibility — real-time terminal output, issue timelines, knowledge base, file browser, and cost tracking.

---

## API Reference

Agents interact with the platform through REST APIs. All endpoints are under `/api`.

<details>
<summary><b>Projects</b></summary>

```
GET    /api/projects              # List all projects
POST   /api/projects              # Create project
GET    /api/projects/:id          # Get project details
PUT    /api/projects/:id          # Update project
```
</details>

<details>
<summary><b>Agents</b></summary>

```
GET    /api/projects/:id/agents   # List agents in project
POST   /api/projects/:id/agents   # Create agent
POST   /api/agents/:id/start      # Start agent
POST   /api/agents/:id/stop       # Stop agent
PUT    /api/agents/:id            # Update agent config
GET    /api/agents/:id/status     # Get agent status
GET    /api/agents/:id/logs       # Get agent logs
DELETE /api/agents/:id            # Delete agent
```
</details>

<details>
<summary><b>Issues</b></summary>

```
GET    /api/projects/:id/issues   # List issues (?status=, ?assigned_to=)
POST   /api/projects/:id/issues   # Create issue
GET    /api/issues/:id            # Get issue + comments
PUT    /api/issues/:id            # Update issue
POST   /api/issues/:id/comments   # Add comment
POST   /api/issues/:id/relations  # Add dependency
```
</details>

<details>
<summary><b>Knowledge Base</b></summary>

```
GET    /api/projects/:id/knowledge   # Query (?q=, ?tag=, ?importance=)
POST   /api/projects/:id/knowledge   # Add entry
PUT    /api/knowledge/:id            # Update entry
GET    /api/agents/:id/knowledge-memory  # Get owned agent knowledge
PUT    /api/agents/:id/knowledge-memory  # Upsert owned agent knowledge
```
</details>

<details>
<summary><b>Messages</b></summary>

```
POST   /api/agents/:id/messages/send   # Send message to another agent
GET    /api/agents/:id/messages        # Get messages (?status=unread)
PUT    /api/agents/:id/messages/:mid   # Mark as read
```
</details>

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
│    ├── ProcessManager (spawn, pty, lifecycle)     │
│    ├── Scheduler (cron, watchdog)                │
│    ├── Terminal (xterm.js bridge)                │
│    └── Agent Hierarchy                           │
│    │                                             │
│  SQLite (better-sqlite3)                         │
│    projects · agents · issues · knowledge ·      │
│    messages · users · sessions                   │
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

**Built for people who believe one agent is never enough.**

[GitHub](https://github.com/fuzihaofzh/haico) · [npm](https://www.npmjs.com/package/haico)

</div>
