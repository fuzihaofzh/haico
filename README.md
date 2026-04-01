# Agentopia

[![npm](https://img.shields.io/npm/v/agentopia)](https://www.npmjs.com/package/agentopia)
[![GitHub](https://img.shields.io/github/license/fuzihaofzh/agentopia)](https://github.com/fuzihaofzh/agentopia)

A multi-agent collaboration platform that orchestrates autonomous AI agents to work together on complex tasks through a shared issue tracker, knowledge base, and real-time web dashboard.

**GitHub**: https://github.com/fuzihaofzh/agentopia

## Features

- **Multi-Agent Orchestration** — Manage hierarchical teams of AI agents with controller/worker roles and parent-child relationships
- **Issue Tracker** — GitHub-style issue management with priorities, labels, assignments, dependencies, and sub-issues
- **Two Orchestration Engines** — Native (direct controller execution) and LangGraph (agentic reasoning with tool use)
- **Session Management** — Persistent agent sessions with token budgets, auto-resumption, and cooldown to prevent waste
- **Knowledge Base** — Shared knowledge store with importance levels; high-importance entries are auto-injected into agent prompts
- **Agent Memories** — Per-agent and project-scoped persistent memories that survive across sessions
- **Direct Messaging** — Agents can send messages to each other for coordination
- **Process Management** — Spawning, monitoring, and lifecycle management with watchdog detection for stuck agents
- **Interactive Terminal** — Real-time terminal access to agent processes via xterm.js and WebSocket
- **Web Dashboard** — Full UI for managing projects, agents, issues, files, and monitoring execution
- **File Management** — Upload, download, and preview files (including PDF and HTML) within projects
- **Multi-User Auth** — User registration, login, role-based access control (admin/member), and project-level permissions
- **Cost Tracking** — Token usage tracking with tail-request avoidance to prevent unnecessary API spend
- **Scheduling** — Cron-based scheduling for recurring agent tasks

## Architecture

```
┌─────────────────────────────────────────────┐
│                Web Dashboard                │
│  (Projects, Agents, Issues, Terminal, Files) │
└──────────────────┬──────────────────────────┘
                   │ HTTP / WebSocket
┌──────────────────▼──────────────────────────┐
│              Fastify Server                  │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
│  │  Routes  │ │   Auth   │ │  WebSocket   │  │
│  └────┬────┘ └──────────┘ └──────────────┘  │
│       │                                      │
│  ┌────▼────────────────────────────────────┐ │
│  │            Services                      │ │
│  │  Orchestrator · Controller · Scheduler   │ │
│  │  ProcessManager · Terminal · Hierarchy   │ │
│  └────┬────────────────────────────────────┘ │
│       │                                      │
│  ┌────▼────┐                                 │
│  │ SQLite  │                                 │
│  └─────────┘                                 │
└──────────────────────────────────────────────┘
         │
         ▼  spawns & manages
   ┌───────────┐ ┌───────────┐ ┌───────────┐
   │  Agent 1  │ │  Agent 2  │ │  Agent N  │
   │ (Claude)  │ │ (Codex)   │ │  (...)    │
   └───────────┘ └───────────┘ └───────────┘
```

**Tech Stack**: Node.js, TypeScript, Fastify, SQLite (better-sqlite3), LangChain/LangGraph, xterm.js, WebSocket

## Quick Start

### Prerequisites

- Node.js >= 18
- npm

### Install & Run

```bash
# Install dependencies
npm install

# Development mode (auto-reload)
npm run dev

# Production
npm run build
npm start
```

The server starts on `http://localhost:4567` by default. On first visit, you'll be prompted to create an admin account.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTOPIA_PORT` | `4567` | Server port |
| `AGENTOPIA_HOST` | `0.0.0.0` | Bind address |
| `AGENTOPIA_DB_PATH` | `data/agentopia.db` | SQLite database path |
| `AGENTOPIA_ORCHESTRATOR_ENGINE` | `langgraph` | Orchestration engine (`native` or `langgraph`) |
| `AGENTOPIA_NO_AUTH` | `false` | Set to `true` to disable authentication |

## Usage

### 1. Create a Project

From the dashboard, create a new project with a name and task description. The task description tells agents what they're working on.

### 2. Add Agents

Add agents to the project:
- **Controller** — Orchestrates work, creates issues, assigns tasks to workers, monitors progress
- **Workers** — Execute tasks assigned via issues, report progress through comments

Each agent can have:
- A custom role description
- A working directory
- Custom instructions
- A parent agent (for hierarchical teams)
- Session limits (max runs, max tokens)

### 3. Start the Controller

Start the controller agent. It will:
1. Read the project task
2. Decompose it into issues
3. Create and assign issues to workers
4. Start worker agents
5. Monitor progress and coordinate

### 4. Monitor

Use the web dashboard to:
- View real-time agent terminal output
- Track issue status and comments
- Browse the knowledge base
- Manage files
- View cost/token usage

## API

All endpoints are under `/api`. Agents interact with the platform through REST APIs (primarily via `curl` in their terminal sessions).

### Projects
- `GET /api/projects` — List projects
- `POST /api/projects` — Create project
- `GET /api/projects/:id` — Get project details
- `PUT /api/projects/:id` — Update project

### Agents
- `GET /api/projects/:id/agents` — List agents
- `POST /api/projects/:id/agents` — Create agent
- `POST /api/agents/:id/start` — Start agent
- `POST /api/agents/:id/stop` — Stop agent
- `GET /api/agents/:id/status` — Agent status
- `GET /api/agents/:id/logs` — Agent logs

### Issues
- `GET /api/projects/:id/issues` — List issues (supports `?status=`, `?assigned_to=`)
- `POST /api/projects/:id/issues` — Create issue
- `GET /api/issues/:id` — Get issue with comments
- `PUT /api/issues/:id` — Update issue

### Knowledge
- `GET /api/projects/:id/knowledge` — Query knowledge base
- `POST /api/projects/:id/knowledge` — Add knowledge entry

### Messages
- `POST /api/agents/:id/messages/send` — Send message
- `GET /api/agents/:id/messages` — Get messages

## Development

```bash
# Run in dev mode with auto-reload
npm run dev

# Build TypeScript
npm run build

# Run tests
npm test
```

## License

MIT
