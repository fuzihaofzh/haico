# AGENTS.md — HAICO

**HAICO** (Human-Agent Interactive Collaboration Orchestrator) — 多 AI Agent 协作编排平台，Issue 驱动。

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

Node.js (ES2022, CommonJS) · Fastify 5 · SQLite (better-sqlite3, WAL, 外键启用) · TypeScript strict · 原生 HTML/CSS/JS (SSR + REST + WebSocket, 无构建工具) · native/langgraph 编排 · Agent adapter registry · node-pty optional

## Structure

入口 `src/app.ts` → 路由 `src/routes/` → 服务 `src/services/` → DB `src/db/`。领域事件总线 `src/events/` 解耦服务间副作用，核心模块禁止依赖 services，只有 `src/events/subscribers/` 可以同时依赖两者。Agent 类型调度与执行通过 adapter 黑盒封装，消费者只与 `Adapter` 接口交互，不写 type-specific 分支；详见 `architecture/adapters.md`。

## Conventions

- **路由**: `src/routes/api/` 每模块一文件或 `remote/` 子目录按路径前缀拆分, `registerXxxRoutes(fastify)`；认证、UI、WebSocket 路由分别在 `auth.ts`、`ui.ts`、`ws.ts`
- **PreHandler**: `src/routes/prehandlers/` 权限/校验 Fastify preHandler 工厂，路由通过 `fastify.register` scope + `addHook('preHandler', ...)` 应用，而非内联检查
- **权限**: prehandler 解析权限后将结果挂到 `request.projectPermission`、`request.resolvedEntity` 等；service 函数接收 `ProjectPermission` (非完整 `ProjectRequestContext`)
- **API**: 前缀 `/api/` | 错误 `{ error: string }` | 分页 `limit` + `offset`
- **WebSocket**: `broadcastToProject(projectId, { type, projectId, data })`, type 用 `snake_case` (与 JS/TS camelCase 习惯不同)
- **DB**: better-sqlite3 同步 API | 批量 IN 子句: `buildSqlPlaceholders(values)` | cost 查询仅取每 run_id 最后一条（累积值）
- **EventBus**: 服务函数完成业务操作后通过 `eventBus.publish()` 发布领域事件，副作用（WS 推送、Agent 启动、Controller 触发）由 `src/events/subscribers/` 中的订阅者处理；`src/events/` 核心模块禁止 import `src/services/`；详见 `architecture/event-bus.md`

## Frontend

- **基础形态**: `public/*.html` + `public/css/` + `public/js/`，无前端构建工具；页面资源通过 `/public/...` 本地路径引用。
- **CSS 架构**: CUBE CSS + `@layer`，单入口 `public/css/index.css`；layer 优先级升序 `reset → base → composition → block → utility → exception`；页面级样式放入 `public/css/layers/blocks/`，按组件命名（如 `auth.css`、`terminal.css`）；禁止新增独立 CSS 文件或 inline `<style>`，新样式按职责归入对应 layer；未分层 CSS（如 `codicon.css`）优先级高于所有 layer，禁止滥用。
- **JS 模块化**: 新增或重写前端脚本时优先使用 ES Module（`<script type="module">` + `import/export`），便于按页面、共享工具、组件拆分与复用；仅在兼容既有非模块脚本时保留普通 script。
- **第三方库**: 浏览器端依赖 vendored 到 `public/vendor/`，禁止直接引用外部 CDN；新增/升级库时记录版本并确保静态文件可离线加载。
- **缓存失效**: 自研静态资源 URL 禁止使用 `?v=` / `?ver=` 等手动版本号做 cache-bust；缓存失效由服务端 ETag 协商机制自动处理。
- **htmx**: 本地文件 `public/vendor/htmx.min.js`；适合轻量表单/局部交互。htmx 表单默认 `application/x-www-form-urlencoded`，服务端需保持对应 parser；复杂业务逻辑仍放在 `public/js/pages/` 或 service/API 层。
- **HTML 字符串 helper**: `public/js/shared/common.js` 暴露全局 `h` tagged template 与 `html(value)` 片段标记。新增/迁移前端 HTML 字符串时优先用 `h\`...\``；普通数据直接 `${value}` 自动转义；仅对已由 `h` 生成、静态 SVG/icon、或明确可信的内部 HTML 片段使用 `${html(fragment)}`，不要对用户输入使用 `html(...)`。
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
- **Adapter 依赖方向**: `src/services/adapters/` 只依赖底层模块（db、logger、events、process-manager/policy），不依赖 services 中的业务模块；新增 agent type 只需创建 adapter 子类 + 注册，不扩散到消费者；改命令构建/输出解析/就绪检测前先读 `architecture/adapters.md`
- **Git 通用层与编排层分离**: 新增 git 操作必须先在 `src/services/git.ts` 实现纯路径签名函数，再由业务编排层组合调用；`git.ts` 禁止导入 DB/Agent/Project 等业务模块，详见 `architecture/git.md`

## References

- 产品需求: `prd/` (00-overview.md ~ 15-data-model.md)
- 架构文档: `architecture/error-handling.md`, `architecture/orchestration.md`, `architecture/git.md`, `architecture/event-bus.md`, `architecture/adapters.md`, `architecture/dashboard-pages.md`
- Playwright 配置: `playwright.config.ts` | 测试: `test/e2e/*.spec.ts`
