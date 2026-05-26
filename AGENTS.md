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

Node.js (ES2022, CommonJS) · Fastify 5 · SQLite (better-sqlite3, WAL, 外键启用) · TypeScript strict · 原生 HTML/CSS/JS (SSR + REST + WebSocket, 无构建工具) · native/langgraph 编排 · Agent CLI executor · node-pty optional

## Code Map

```
src/
├── app.ts              # Fastify 入口
├── config.ts           # 环境变量: HAICO_PORT, HAICO_HOST, HAICO_DB_PATH, HAICO_ORCHESTRATOR_ENGINE
├── types.ts            # 核心类型定义
├── middleware/auth.ts   # users + sessions 认证
├── db/
│   ├── database.ts     # SQLite 连接
│   └── schema.ts       # Schema + 迁移
├── routes/
│   ├── route.ts         # 顶层注册: auth → protected API → UI → WebSocket
│   ├── api/             # 受保护业务 API, 每模块一文件
│   ├── auth.ts          # 登录/注册等公开认证路由
│   ├── ui.ts            # SSR/静态页面入口
│   └── ws.ts            # WebSocket 路由
└── services/            # 纯逻辑, 无 Fastify 依赖
    ├── controller.ts        # 编排引擎
    ├── orchestrator.ts      # Native 编排
    ├── langgraph-runner.ts  # LangGraph 编排
    ├── pre-controller.ts    # 规则引擎拦截
    ├── process-manager/     # Agent 子进程管理
    └── ...                  # 其他服务见 src/services/
```

## Conventions

- **路由**: `src/routes/api/` 每模块一文件, `registerXxxRoutes(fastify)`；认证、UI、WebSocket 路由分别在 `auth.ts`、`ui.ts`、`ws.ts`
- **权限**: `requireXxxAccess(db, getProjectRequestContext(request), id, requireManage?)` 统一模式
- **API**: 前缀 `/api/` | 错误 `{ error: string }` | 分页 `limit` + `offset`
- **WebSocket**: `broadcastToProject(projectId, { type, projectId, data })`, type 用 `snake_case` (与 JS/TS camelCase 习惯不同)
- **DB**: better-sqlite3 同步 API | 批量 IN 子句: `buildSqlPlaceholders(values)` | cost 查询仅取每 run_id 最后一条（累积值）

## Frontend

- **基础形态**: `public/*.html` + `public/css/` + `public/js/`，无前端构建工具；页面资源通过 `/public/...` 本地路径引用。
- **JS 模块化**: 新增或重写前端脚本时优先使用 ES Module（`<script type="module">` + `import/export`），便于按页面、共享工具、组件拆分与复用；仅在兼容既有非模块脚本时保留普通 script。
- **第三方库**: 浏览器端依赖 vendored 到 `public/vendor/`，禁止直接引用外部 CDN；新增/升级库时记录版本并确保静态文件可离线加载。
- **缓存失效**: 自研静态资源 URL 禁止使用 `?v=` / `?ver=` 等手动版本号做 cache-bust；缓存失效由服务端 ETag 协商机制自动处理。
- **htmx**: 本地文件 `public/vendor/htmx.min.js`；适合轻量表单/局部交互。htmx 表单默认 `application/x-www-form-urlencoded`，服务端需保持对应 parser；复杂业务逻辑仍放在 `public/js/pages/` 或 service/API 层。
- **HTML 字符串 helper**: `public/js/shared/common.js` 暴露全局 `h` tagged template 与 `html(value)` 片段标记。新增/迁移前端 HTML 字符串时优先用 `h\`...\``；普通数据直接 `${value}` 自动转义；仅对已由 `h` 生成、静态 SVG/icon、或明确可信的内部 HTML 片段使用 `${html(fragment)}`，不要对用户输入使用 `html(...)`。

## Route / Service / Error Boundary

- **路由只管传输**: 解析 params/body/query、执行 `requireXxxAccess`、调用 service、设置成功响应。
- **Service 只管业务**: 业务规则、DB、文件系统、进程生命周期、领域事件/WebSocket 广播都下沉到 service。
- **业务失败抛领域错误**: route 中不要写业务型 `reply.code(4xx).send({ error })`；由 service 抛 `<Entity><Reason>Error`。
- **HTTP 映射集中处理**: `src/errors/error-mapper.ts` 按具体领域错误类映射 status code；详见 `architecture/error-handling.md`。
- **Service 禁止 Fastify 依赖**: service 不 import Fastify 类型；如需日志，传入最小 logger interface。

## Pitfalls

- **DB 迁移无版本号**: `PRAGMA table_info` 检测缺失列 → `ALTER TABLE ADD COLUMN`; CHECK 约束变更需重建表 (RENAME → CREATE → INSERT → DROP)
- **启动时**自动将 stuck running agents 重置为 idle，勿手动干预
- **权限**: 后端只认真实 user session；admin 全权限，owner/member/editor 通过 project_id 回溯到项目级
- **远程实例 ID 装饰**: `remote-{entity}:{instanceId}:{remoteId}`，代理请求需剥除前缀再转发
- **编排/Issue 自动化**: 改 controller、agent lifecycle、issue dispatch 前先读 `architecture/orchestration.md`

## References

- 产品需求: `prd/` (00-overview.md ~ 15-data-model.md)
- 架构文档: `architecture/error-handling.md`, `architecture/orchestration.md`
- Playwright 配置: `playwright.config.ts` | 测试: `test/e2e/*.spec.ts`
