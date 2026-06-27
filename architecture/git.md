# Git Service
<!-- depends-on: AGENTS.md -->
<!-- L1: Architecture (含规则) -->
<!-- L2: Shared Helpers, Read Operations, Write Operations, Call Map, Implementation Boundaries -->

## Architecture

HAICO 的 Git 操作遵循两层分离原则：

- **通用层** (`src/services/git.ts`)：纯 git CLI 封装，只接受绝对路径，
  只返回 git 原生语义数据。不依赖 DB、Agent、Project 等业务概念。
- **编排层** (各业务模块)：将业务 ID 翻译为目录路径，调用通用层原语，
  组装业务定制的返回结构。

### 规则

1. **通用层禁止导入业务模块**。`git.ts` 不 import `../db/`、`../agents/`、
   `../projects/` 等。唯一的依赖是 `child_process`、`fs`、`os`、`path`。
2. **编排层通过路径调用通用层**。编排层负责 "agentId → working_directory →
   expandHomePath → getGitStatus(dir)" 的翻译链。
3. **新增 Git 功能必须从通用层开始**。任何新的 git 操作（stash、commit、
   checkout、push 等）必须先在 `git.ts` 中实现纯路径签名的函数，再由
   业务编排层组合调用。
4. **通用层返回结构使用 camelCase**。编排层负责映射为前端期望的格式
   （如 `hasUncommitted` → `has_uncommitted` 的反向映射）。

## Shared Helpers

| 函数 | 签名 | 说明 |
|------|------|------|
| `expandHomePath` | `(dir: string) => string` | `~/` 开头路径展开为绝对路径，全系统统一 |
| `isGitRepository` | `(dir: string) => boolean` | 检查 `.git` 目录存在性 |

`expandHomePath` 替代了此前分散在 `agents/git.ts`、`agents/files.ts`、
`projects/activity.ts`、`process-manager/command.ts`、`executors/cli-executor.ts`、
`terminal.ts` 中的内联 `~/` 展开逻辑。新增代码中涉及路径展开时应统一使用此函数。

## Read Operations

| 函数 | 签名 | 说明 |
|------|------|------|
| `getGitStatus` | `(dir: string) => GitStatusResult` | branch / uncommitted files / diff stat |
| `getGitLog` | `(dir: string, limit: number) => GitLogEntry[]` | 最近 N 条 commit（不含 author） |
| `getGitLogWithAuthor` | `(dir: string, limit: number) => GitLogWithAuthorEntry[]` | 最近 N 条 commit（含 author） |

## Write Operations (future)

预留区段。未来新增写操作时：

1. 在 `git.ts` 中添加纯路径签名函数（如 `gitStash(dir: string): void`）
2. 在编排层（如 `agents/lifecycle.ts`）中组合调用
3. 在此文档中更新函数列表

### 候选操作

| 函数 | 签名 | 业务场景 |
|------|------|----------|
| `gitStash` | `(dir: string) => void` | Agent 启动前保存脏工作区 |
| `gitStashPop` | `(dir: string) => void` | Agent 完成后恢复 stash |
| `gitCommit` | `(dir: string, message: string) => string` | Task 完成后自动提交 |
| `gitCheckout` | `(dir: string, branch: string) => void` | Issue 分支切换 |
| `gitCreateBranch` | `(dir: string, name: string) => void` | Issue → Branch 创建 |
| `gitPush` | `(dir: string, remote?: string) => void` | 远程同步 |
| `gitPull` | `(dir: string, remote?: string) => void` | 拉取远程更新 |

## Call Map

```
routes/api/agents.ts
  └─ agents/core.ts::getAgentGitStatus(agentId)
       ├─ db → agent.working_directory
       ├─ git.expandHomePath(dir)
       ├─ git.getGitStatus(dir)
       └─ git.getGitLog(dir, 5)

routes/api/projects.ts
  └─ projects/activity.ts::getProjectGitLog(db, projectId)
       ├─ db → agents[].working_directory → dirToAgents map
       ├─ git.expandHomePath(dir)
       ├─ git.isGitRepository(dir)
       └─ git.getGitLogWithAuthor(dir, limit)

未来编排集成（示例）:
  agents/lifecycle.ts::startAgent()
    └─ git.getGitStatus(dir)
         └─ if hasUncommitted → git.gitStash(dir)
  tasks/completion.ts::completeTask()
    └─ git.gitCommit(dir, message)
         └─ git.gitPush(dir)
```

## Implementation Boundaries

- 通用 git 操作封装：`src/services/git.ts`
- Agent git 状态编排：`src/services/agents/core.ts`（`getAgentGitStatus`）
- 项目 git log 编排：`src/services/projects/activity.ts`
- `--skip-git-repo-check` 标志：不属于 git 操作，是 Codex CLI 参数构建，
  归属于 `src/services/command-profiles/` 和 `src/services/process-manager/`
