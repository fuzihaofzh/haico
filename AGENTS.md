# AGENTS.md — HAICO

**HAICO** (Human-Agent Interactive Collaboration Orchestrator) — 多 AI Agent 协作编排平台，Issue 驱动。

- 版本 1.5.3 · 仓库 https://github.com/fuzihaofzh/haico · MIT
- **工具规则**: `todowrite` 必须写全名，禁止缩写；复杂任务（≥3 步）必须先用 `todowrite` 跟踪

## Agent Operating Principles

- Don't assume. Don't hide confusion. Surface tradeoffs.
- Minimum code that solves the problem. Nothing speculative.
- Touch only what you must. Clean up only your own mess.
- Define success criteria. Loop until verified.

## Commands

```bash
npm run dev          # 开发 (nodemon + tsx, 监听 src/ public/)
npm run build        # tsc → dist/
npm run start        # 生产 (node dist/index.js)
npm test             # 构建 + API 测试 (Fastify inject, 无真实网络)
npx playwright test  # E2E (Chromium, 自动启动 webServer, 独立 test-e2e.db)
bash test/smoke-test.sh    # curl 驱动工作流验证
bash test/run-e2e.sh       # 真实 Agent 编排端到端
```

## Tech Stack

Node.js (ES2022, CommonJS) · Fastify 5 · SQLite (better-sqlite3, WAL, 外键启用) · TypeScript strict · 原生 HTML/CSS/JS (SSR + REST + WebSocket, 无构建工具) · Agent CLI: `cld` / Gemini CLI / Codex CLI · 编排: native / langgraph · AI: @langchain/core, @langchain/langgraph · 终端: node-pty (optional)

## Architecture

```
src/
├── app.ts              # Fastify 入口
├── config.ts           # 环境变量: HAICO_PORT, HOST, DB_PATH, ORCHESTRATOR_ENGINE
├── types.ts            # 核心类型定义
├── middleware/auth.ts   # users + sessions 认证
├── db/
│   ├── database.ts     # SQLite 连接
│   └── schema.ts       # Schema + 迁移
├── routes/             # 每模块一文件, 导出 registerXxxRoutes(fastify)
│   ├── ui.ts · projects.ts · agents.ts · issues.ts · knowledge.ts
│   ├── messages.ts · command-profiles.ts · templates.ts · approvals.ts
│   ├── executive-summaries.ts · remote-instances.ts · dashboard-chat.ts
│   └── payment-approvals.ts
└── services/           # 纯逻辑, 无 Fastify 依赖
    ├── controller.ts        # 编排引擎
    ├── orchestrator.ts      # Native 编排
    ├── langgraph-runner.ts  # LangGraph 编排
    ├── pre-controller.ts    # 规则引擎拦截
    ├── process-manager.ts   # Agent 子进程管理
    └── ...                  # 其他服务见 src/services/
```

## Conventions

- **路由**: `src/routes/` 每模块一文件, `registerXxxRoutes(fastify)` | **服务**: `src/services/` 纯逻辑无 Fastify 依赖
- **权限**: `ensureXxxAccess(db, request, reply, id, requireManage?)` 统一模式
- **API**: 前缀 `/api/` | 错误 `{ error: string }` | 分页 `limit` + `offset`
- **WebSocket**: `broadcastToProject(projectId, { type, projectId, data })`, type 用 `snake_case` (与 JS/TS camelCase 习惯不同)
- **DB**: better-sqlite3 同步 API | 批量 IN 子句: `buildSqlPlaceholders(values)` | cost 查询仅取每 run_id 最后一条（累积值）

## Frontend

- **基础形态**: `public/*.html` + `public/css/` + `public/js/`，无前端构建工具；页面资源通过 `/public/...` 本地路径引用。
- **JS 模块化**: 新增或重写前端脚本时优先使用 ES Module（`<script type="module">` + `import/export`），便于按页面、共享工具、组件拆分与复用；仅在兼容既有非模块脚本时保留普通 script。
- **第三方库**: 浏览器端依赖 vendored 到 `public/vendor/`，禁止直接引用外部 CDN；新增/升级库时记录版本并确保静态文件可离线加载。
- **缓存失效**: 自研静态资源 URL 禁止使用 `?v=` / `?ver=` 等手动版本号做 cache-bust；缓存失效由服务端 ETag 协商机制自动处理。
- **htmx**: 本地文件 `public/vendor/htmx.min.js`；适合轻量表单/局部交互。htmx 表单默认 `application/x-www-form-urlencoded`，服务端需保持对应 parser；复杂业务逻辑仍放在 `public/js/pages/` 或 service/API 层。

## Route / Service / Error Boundary

- **路由只管传输**: 解析 params/body/query、执行 `ensureXxxAccess`、调用 service、设置成功状态码/headers/content-type，并处理 multipart/stream/binary 响应。
- **Service 只管业务**: 业务规则、DB 查询、文件系统、进程生命周期、数据序列化、领域事件/WebSocket 广播都下沉到 service。
- **业务失败抛领域错误**: route 中不要写业务型 `reply.code(4xx).send({ error })`；由 service 抛 `<Entity><Reason>Error`。
- **领域错误不带 HTTP 语义**: 领域错误类是普通 `Error` 扩展，只表达业务语义和 message，不挂 `statusCode`，不依赖 Fastify。
- **HTTP 映射集中处理**: `src/errors/error-mapper.ts` 按具体领域错误类映射 status code，最终响应格式保持 `{ error: string }`。
- **Service 禁止 Fastify 依赖**: service 不 import Fastify 类型；如需日志，传入最小 logger interface。

## Pitfalls

- **DB 迁移无版本号**: `PRAGMA table_info` 检测缺失列 → `ALTER TABLE ADD COLUMN`; CHECK 约束变更需重建表 (RENAME → CREATE → INSERT → DROP)
- **启动时**自动将 stuck running agents 重置为 idle，勿手动干预
- **Agent 编排硬约束**: Project 创建自动生成 1 Controller + 1 Assistant; Worker 必须挂 Controller (parent_agent_id); Controller 完成后自动检查更多可分派 Issue
- **Issue 自动化**: @mention 自动启动 Agent; 子 Issue 全完成 → 触发父 Issue Controller 汇总; Agent 标记 done → 自动指派回 user
- **权限**: 后端只认真实 user session；admin 全权限，owner/member/editor 通过 project_id 回溯到项目级
- **远程实例 ID 装饰**: `remote-{entity}:{instanceId}:{remoteId}`，代理请求需剥除前缀再转发

## References

- 产品需求: `prd/` (00-overview.md ~ 15-data-model.md)
- Playwright 配置: `playwright.config.ts` | 测试: `test/e2e/*.spec.ts`
