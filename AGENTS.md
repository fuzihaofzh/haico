# AGENTS.md — HAICO

**HAICO** (Human-Agent Interactive Collaboration Orchestrator) — 多 AI Agent 协作编排平台，Issue 驱动。

## Design Philosophy

- **Issue 驱动**: Controller 分解工作为 Issue, Worker 执行, 通过 DB + WebSocket 协调项目状态
- **副作用分离**: 业务操作与副作用通过 EventBus 解耦; service 只管业务, 副作用由 subscriber 处理
- **Adapter 黑盒**: AI 工具类型封装为 sealed adapter, 消费者只与 `Adapter` 接口交互, 不写 type-specific 分支
- **Service 无框架依赖**: 业务层不 import Fastify; 如需日志传入最小 logger interface
- **原生前端**: 无构建工具; SSR 壳子 + htmx 片段渲染 + 客户端 JS, 资源走 `/public/`

## Documentation Model

三层文档: **L0**(本文档, 理念) → **L1**(`architecture/` 契约段, 概念与约束) → **L2**(`architecture/` 实现段, 具象实现)。需求规格在 `prd/`, 与代码生命周期解耦。

- **改代码前**: 查下方 Doc Index 表, 按 路径→文档段 精确加载必读段
- **改代码后**: 查 `architecture/documentation.md` §文档影响检查工作流, 决定更新哪些层
- **文档系统规则**: 详见 `architecture/documentation.md`（三层定义、更新红线、粒度判据、废弃判据）

## Commands

```bash
npm run dev          # 开发 (nodemon + tsx, 监听 src/ public/, 端口默认 4567)
npm run dev:admin    # 同 dev, 但首次启动自动创建 admin 账号 (HAICO_DEFAULT_ADMIN=true)
npm run build        # tsc → dist/
npm run start        # 生产 (node dist/index.js)
npm test             # 构建 + test:api + test:unit (Fastify inject, 无真实网络)
npm run test:unit    # 仅单元测试 (test/unit/*.test.ts, node --test)
npm run test:api     # API 套件 + 独立 API 测试 (test/api.test.ts + test/api/*.test.ts)
npm run test:e2e     # E2E (Chromium, 自动启动 webServer, 独立 test-e2e.db)
npm run test:e2e:ui  # E2E 带 UI 模式 (--ui / --headed / --debug 可选)
bash test/smoke-test.sh    # curl 驱动工作流验证
bash test/run-e2e.sh       # 真实 Agent 编排端到端
npm run build:electron     # 打包桌面端 (desktop/build-electron.sh)
```

## Environment

| 变量 | 默认 | 说明 |
|---|---|---|
| `HAICO_PORT` | `4567` | HTTP 端口 |
| `HAICO_HOST` | `0.0.0.0` | 监听地址 |
| `HAICO_DB_PATH` | `./haico.db` | SQLite 路径；测试用 `test-e2e.db` / `test-ack-takeover.db` |
| `HAICO_DEFAULT_ADMIN` | — | 首次启动自动创建 admin 账号 (或用 `npm run dev:admin`) |
| `HAICO_DEFAULT_ADMIN_PASSWORD` | — | 指定 admin 初始密码 |
| `HAICO_ORCHESTRATOR_ENGINE` | `langgraph` | `langgraph` \| `native` |
| `HAICO_LOG_LEVEL` | — | 日志级别 |
| `HAICO_EVENT_LOG` | `on` | 设为 `off` 关闭事件日志 |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | — | 模型 API 密钥 (按所用 adapter 配置) |

## Structure

入口 `src/index.ts` (bootstrap) → `src/app.ts` (Fastify 装配) → 路由 `src/routes/` → 服务 `src/services/` → DB `src/db/`。CLI 子命令在 `src/cli/`，定时任务在 `src/scheduler/`，实时层 `src/realtime/`，全局中间件 `src/middleware/`，SSR 片段在 `src/views/`。

## Doc Index

改代码前查此表，按路径模式匹配，精确加载命中的文档段（用 `read` 的行范围选择器）。

| 代码路径模式 | 必读文档段 | 级别 |
|---|---|---|
| `src/events/**` | `event-bus.md` §架构 §依赖方向 §中间件 §防止循环依赖 | L1 |
| `src/events/subscribers/**` | `event-bus.md` §架构 §事件定义 §新增事件 §task.requested模式 §删除事件模式 | L1 |
| `src/services/adapters/**` | `adapters.md` §Overview §Key Interfaces §Adding a New Agent Type | L1 |
| `src/services/adapters/*/index.ts` | `adapters.md` §BaseCliAdapter §Event Flow | L2 |
| `src/services/process-manager/**` | `adapters.md` §Directory Structure | L2 |
| `src/routes/api/**` | `conventions.md` §路由约定 §API 约定 | L1 |
| `src/routes/ui*.ts` | [L1] `htmx-ssr-fragments.md` §三层路径结构; [L2] `htmx-ssr-fragments-impl.md` §路由文件结构 | L1+L2 |
| `src/routes/prehandlers/**` | `error-handling.md` §PreHandler Pattern | L2 |
| `src/middleware/auth.ts` | `conventions.md` §认证约定 | L1+L2 |
| `src/middleware/error-handler.ts` | `error-handling.md` §Global Error Handler | L2 |
| `src/routes/ws.ts` | `conventions.md` §WebSocket 约定 | L1 |
| `src/views/**` | [L1] `htmx-ssr-fragments.md` §Views 层规则; [L2] `htmx-ssr-fragments-impl.md` §h/html/renderToString helper | L1+L2 |
| `src/services/git.ts` | `git.md` §Architecture | L1 |
| `src/services/agents/**` (git 编排) | `git.md` §Call Map | L2 |
| `src/services/**` (非 adapter) | `conventions.md` §Service 约定 §DB 约定 | L1 |
| `src/errors/**` | `error-handling.md` §HTTP Mapping §Error Categories | L1 |
| `src/services/controller.ts` | `orchestration.md` §Agent Hierarchy §Issue Automation | L1 |
| `src/services/orchestrator.ts` | `orchestration.md` §Implementation Boundaries | L1 |
| `src/services/issue/**` | `orchestration.md` §Issue Automation | L1 |
| `src/scheduler/**` | `orchestration.md` §Implementation Boundaries | L1 |
| `src/db/**` | `conventions.md` §DB 约定 | L1 |
| `public/css/**` | `frontend.md` §CSS 架构 | L1 |
| `public/js/**` | `frontend.md` §JS 模块化 §HTML Helper | L1 |
| `public/vendor/**` | `frontend.md` §第三方库 §Vendor 同步机制 | L2 |
| `public/*.html` | `frontend.md` §基础形态 | L1 |
| `src/realtime/**` | `conventions.md` §WebSocket 约定 | L1 |
| 文档更新动作 | `documentation.md` (全文) | L1 |

## References

- 产品需求: `prd/` (00-overview.md ~ 15-data-model.md)
- 架构文档: `architecture/` 目录下各文档（按 Doc Index 表按需加载）
- Playwright 配置: `playwright.config.ts` | 测试: `test/e2e/*.spec.ts`
