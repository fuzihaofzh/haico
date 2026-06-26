# AGENTS.md — HAICO

**HAICO** (Human-Agent Interactive Collaboration Orchestrator) — 多 AI Agent 协作编排平台，Issue 驱动。

## Agent Operating Principles

- Don't assume. Don't hide confusion. Surface tradeoffs.
- Minimum code that solves the problem. Nothing speculative.
- Touch only what you must. Clean up only your own mess.
- Define success criteria. Loop until verified.

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

## Tech Stack

Node.js (ES2022, CommonJS) · Fastify 5 · SQLite (better-sqlite3, WAL, 外键启用) · TypeScript strict · 原生 HTML/CSS/JS (SSR 两层：静态壳子 `public/*.html` + 动态片段 `src/views/` + `/ui/` 端点；REST + WebSocket，无构建工具) · htmx (服务端渲染片段) · native/langgraph 编排 · Agent adapter registry · node-pty optional

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

入口 `src/index.ts` (bootstrap) → `src/app.ts` (Fastify 装配) → 路由 `src/routes/` → 服务 `src/services/` → DB `src/db/`。CLI 子命令在 `src/cli/` (经 `bin/haico.js` 暴露)，定时任务在 `src/scheduler/`，实时层 `src/realtime/`，全局中间件 `src/middleware/`。领域事件总线 `src/events/` 解耦服务间副作用，核心模块禁止依赖 services，只有 `src/events/subscribers/` 可以同时依赖两者。Agent 类型调度与执行通过 adapter 黑盒封装，消费者只与 `Adapter` 接口交互，不写 type-specific 分支；详见 `architecture/adapters.md`。

## Conventions

- **路由**: `src/routes/api/` 每模块一文件或 `remote/` 子目录按路径前缀拆分, `registerXxxRoutes(fastify)`；认证、UI、WebSocket 路由分别在 `auth.ts`、`ui.ts`、`ws.ts`；admin 页面 SSR 壳子 + htmx 片段在 `ui-admin.ts` (两个 scope: `/admin/*` shell + `/ui/admin/*` fragment)
- **PreHandler**: `src/routes/prehandlers/` 权限/校验 Fastify preHandler 工厂，路由通过 `fastify.register` scope + `addHook('preHandler', ...)` 应用，而非内联检查
- **权限**: prehandler 解析权限后将结果挂到 `request.projectPermission`、`request.resolvedEntity` 等；service 函数接收 `ProjectPermission` (非完整 `ProjectRequestContext`)
- **API**: 前缀 `/api/` | 错误 `{ error: string }` | 分页 `limit` + `offset`
- **UI 片段**: 前缀 `/ui/` 返回 HTML 片段 (htmx swap)，错误返回 HTML 错误片段 + 4xx/5xx (非 JSON)；复用 preHandler + scope 级 `setErrorHandler` 覆盖全局 JSON handler；`/api/` 与 `/ui/` 调同一 service 函数，仅响应序列化不同
- **WebSocket**: `broadcastToProject(projectId, { type, projectId, data })`, type 用 `snake_case` (与 JS/TS camelCase 习惯不同)
- **DB**: better-sqlite3 同步 API | 批量 IN 子句: `buildSqlPlaceholders(values)` | cost 查询仅取每 run_id 最后一条（累积值）
- **EventBus**: 服务函数完成业务操作后通过 `eventBus.publish()` 发布领域事件，副作用（WS 推送、Agent 启动、Controller 触发）由 `src/events/subscribers/` 中的订阅者处理；`src/events/` 核心模块禁止 import `src/services/`；详见 `architecture/event-bus.md`

## Frontend

- **基础形态**: `public/*.html` (静态壳子) + `src/views/` (服务端 HTML 片段渲染函数) + `public/css/` + `public/js/`，无前端构建工具；页面资源通过 `/public/...` 本地路径引用。`src/views/` 函数只接收 ViewData 返回 string，禁止 import Fastify/DB。
- **CSS 架构**: CUBE CSS + `@layer`，单入口 `public/css/index.css`；layer 优先级升序 `reset → base → composition → block → utility → exception`；页面级样式放入 `public/css/layers/blocks/`，按组件命名（如 `auth.css`、`terminal.css`）；禁止新增独立 CSS 文件或 inline `<style>`，新样式按职责归入对应 layer；未分层 CSS（如 `codicon.css`）优先级高于所有 layer，禁止滥用。
- **JS 模块化**: 新增或重写前端脚本时优先使用 ES Module（`<script type="module">` + `import/export`），便于按页面、共享工具、组件拆分与复用；仅在兼容既有非模块脚本时保留普通 script。
- **第三方库**: 浏览器端依赖 vendored 到 `public/vendor/`，禁止直接引用外部 CDN；新增/升级库时记录版本并确保静态文件可离线加载。
- **Vendor 同步**: `postinstall` 自动从 `node_modules` 复制 `docx-preview` / `xlsx` / `jszip` / `@vscode/codicons` 到 `public/vendor/` 与 `public/css/codicon.*`；手动改动这些文件会在下次 `npm install` 被覆盖，需改源头包或同步逻辑。
- **缓存失效**: 自研静态资源 URL 禁止使用 `?v=` / `?ver=` 等手动版本号做 cache-bust；缓存失效由服务端 ETag 协商机制自动处理。
- **htmx**: 本地文件 `public/vendor/htmx.min.js`；适合服务端持有状态的交互场景 (admin 页面、CRUD 表单、toggle)。htmx 表单默认 `application/x-www-form-urlencoded`，服务端需保持对应 parser；分界线：状态在服务端 → htmx 片段 (`/ui/` 端点 + `src/views/`)；状态在客户端运行时 (localStorage/AudioContext/WS) → `public/js/` 客户端 JS。confirm 用 `hx-confirm`，toast 用 `HX-Trigger` 响应头。
- **HTML 字符串 helper**: 客户端 `public/js/shared/common.js` 暴露全局 `h` tagged template 与 `html(value)` 片段标记；服务端 `src/views/html.ts` 有同名 `h`/`html` 独立实现 (不跨端 import，避免 CommonJS/ESM 混用)。新增/迁移 HTML 字符串时优先用 `h\`...\``；普通数据直接 `${value}` 自动转义；仅对已由 `h` 生成、静态 SVG/icon、或明确可信的内部 HTML 片段使用 `${html(fragment)}`，不要对用户输入使用 `html(...)`。
- **Dashboard 页面结构**: 详见 `architecture/dashboard-pages.md`

## Route / Service / Error Boundary

- **路由只管传输**: 解析 params/body/query、调用 service、设置成功响应。
- **PreHandler 只管权限/校验**: Fastify scope 级 hook 执行角色检查、权限解析、输入校验等；纯适配层，不含业务逻辑，验证逻辑留在 `services/project-access/` 等处
- **Service 只管业务**: 业务规则、DB、文件系统、进程生命周期下沉到 service；副作用（WebSocket 广播、Agent 启动、Controller 触发）通过 `eventBus.publish()` 发布领域事件，由 subscribers 处理。
- **业务失败抛领域错误**: route 中不要写业务型 `reply.code(4xx).send({ error })`；由 service 抛 `<Entity><Reason>Error`。
- **HTTP 映射集中处理**: `src/errors/error-mapper.ts` 按具体领域错误类映射 status code；详见 `architecture/error-handling.md`。
- **Service 禁止 Fastify 依赖**: service 不 import Fastify 类型；如需日志，传入最小 logger interface。

## Pitfalls

- **DB 迁移无版本号**: `PRAGMA table_info` 检测缺失列 → `ALTER TABLE ADD COLUMN`; CHECK 约束变更需重建表 (RENAME → CREATE → INSERT → DROP)
- **启动时**自动将 stuck running agents 重置为 idle，勿手动干预
- **权限**: 后端只认真实 user session；admin 全权限，owner/member/editor 通过 project_id 回溯到项目级
- **远程实例 ID 装饰**: `remote-{entity}:{instanceId}:{remoteId}`，代理请求需剥除前缀再转发
- **编排/Issue 自动化**: 改 controller、agent lifecycle、issue dispatch 前先读 `architecture/orchestration.md`；改事件发布/订阅逻辑前先读 `architecture/event-bus.md`
- **Htmx SSR 片段**: 新增/迁移 `/ui/` 片段端点或 `src/views/` 渲染函数前先读 `architecture/htmx-ssr-fragments.md` (三层路径、两 scope 路由、`html()` 组合转义陷阱、迁移清单)
- **Adapter 依赖方向**: `src/services/adapters/` 只依赖底层模块（db、logger、events、process-manager/policy），不依赖 services 中的业务模块；新增 agent type 只需创建 adapter 子类 + 注册，不扩散到消费者；改命令构建/输出解析/就绪检测前先读 `architecture/adapters.md`
- **Git 通用层与编排层分离**: 新增 git 操作必须先在 `src/services/git.ts` 实现纯路径签名函数，再由业务编排层组合调用；`git.ts` 禁止导入 DB/Agent/Project 等业务模块，详见 `architecture/git.md`

## References

- 产品需求: `prd/` (00-overview.md ~ 15-data-model.md)
- 架构文档: `architecture/error-handling.md`, `architecture/orchestration.md`, `architecture/git.md`, `architecture/event-bus.md`, `architecture/adapters.md`, `architecture/dashboard-pages.md`, `architecture/htmx-ssr-fragments.md`
- Playwright 配置: `playwright.config.ts` | 测试: `test/e2e/*.spec.ts`
