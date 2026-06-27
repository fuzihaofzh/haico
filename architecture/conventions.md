<!-- depends-on: AGENTS.md, error-handling.md#PreHandler Pattern, error-handling.md#Global Error Handler -->
# Conventions

跨子系统的通用约定。路由、API、WebSocket、Service、DB 五个维度的约束规则。

---

## 路由约定

### L1: 路由结构约束

- **文件组织**: `src/routes/api/` 每模块一文件或 `remote/` 子目录按路径前缀拆分, 导出 `registerXxxRoutes(fastify)` 注册函数
- **路由分文件**: 认证路由在 `auth.ts`, UI 路由在 `ui.ts`, WebSocket 路由在 `ws.ts`, admin SSR+htmx 路由在 `ui-admin.ts` (两个 scope: `/admin/*` shell + `/ui/admin/*` fragment)
- **路由只管传输**: 解析 params/body/query → 调 service → 设置成功响应。不写业务逻辑
- **业务失败抛领域错误**: route 中不要写业务型 `reply.code(4xx).send({ error })`; 由 service 抛 `<Entity><Reason>Error`
- **PreHandler 只管权限/校验**: Fastify scope 级 hook 执行角色检查、权限解析、输入校验; 纯适配层, 验证逻辑留在 `services/project-access/` 等处

### L1: 权限模型

- prehandler 解析权限后将结果挂到 `request.projectPermission`、`request.resolvedEntity` 等
- service 函数接收 `ProjectPermission` (非完整 `ProjectRequestContext`)
- 后端只认真实 user session; admin 全权限, owner/member/editor 通过 project_id 回溯到项目级

### L2: 远程实例 ID 装饰

`remote-{entity}:{instanceId}:{remoteId}` 格式。代理请求需剥除前缀再转发。

---

## API 约定

### L1: API 规范

- **前缀**: `/api/`
- **错误格式**: `{ error: string }`（由 `src/errors/error-mapper.ts` 统一映射, 详见 `error-handling.md` §HTTP映射）
- **分页**: `limit` + `offset` query 参数
- **UI 片段前缀**: `/ui/` 返回 HTML 片段 (htmx swap), 错误返回 HTML 错误片段 + 4xx/5xx (非 JSON); 复用 preHandler + scope 级 `setErrorHandler` 覆盖全局 JSON handler; `/api/` 与 `/ui/` 调同一 service 函数, 仅响应序列化不同

---

## WebSocket 约定

### L1: 广播规范

- **广播函数**: `broadcastToProject(projectId, { type, projectId, data })`
- **type 命名**: `snake_case`（与 JS/TS camelCase 习惯不同, 历史原因保持）
- **消息结构**: 必须包含 `projectId` 字段

---

## Service 约定

### L1: Service 层约束

- **Service 只管业务**: 业务规则、DB、文件系统、进程生命周期下沉到 service
- **副作用走事件**: WebSocket 广播、Agent 启动、Controller 触发等副作用通过 `eventBus.publish()` 发布领域事件, 由 `src/events/subscribers/` 中的订阅者处理（详见 `event-bus.md`）
- **Service 禁止 Fastify 依赖**: service 不 import Fastify 类型; 如需日志, 传入最小 logger interface
- **Service 不返回传输形态**: 不返回 `{ ok, statusCode, error }` 等传输结构; 业务失败抛领域错误

---

## DB 约定

### L1: 数据库规范

- **引擎**: better-sqlite3 同步 API
- **批量 IN 子句**: 使用 `buildSqlPlaceholders(values)` 构建占位符, 不手拼
- **cost 查询**: 仅取每 `run_id` 最后一条（累积值）
- **外键**: 已启用, WAL 模式

### L2: 迁移策略

- **无版本号**: `PRAGMA table_info` 检测缺失列 → `ALTER TABLE ADD COLUMN`
- **CHECK 约束变更**: 需重建表 (RENAME → CREATE → INSERT → DROP)
- **启动时**: 自动将 stuck running agents 重置为 idle, 勿手动干预

---

## 认证约定

### L1: 认证不变量

- **`request.user` 始终被设置**: 全局 `onRequest` hook (`src/middleware/auth.ts` 的 `setupAuth`) 在每个请求开始时将 `request.user` 设为 `User | null`。所有 route handler 可安全读取此字段
- **认证失败抛领域错误**: 未认证的非公开路由抛 `AuthenticationRequiredError` (→401); 系统无用户时抛 `NoAuthenticationConfiguredError` (→401)。这些错误经全局 error handler 映射（详见 `error-handling.md` §Global Error Handler）
- **Token 来源优先级**: Cookie → Bearer header → query param `token`。三者按序尝试，首个命中即用

### L2: 公开路由旁路

<!-- code-fact: public routes 见 isPublicAuthRoute() in src/middleware/auth.ts -->
以下路径跳过认证检查（OPTIONS 请求也跳过）：

- `/login`, `/auto-login`, `/register`
- `/api/auth/**`
- `/favicon.ico`
- `/public/**`, `/css/**`, `/js/**`, `/vendor/**`

### L2: 请求上下文 helper

`src/middleware/request-context.ts` 的 `getProjectRequestContext(request)` 是薄封装，从 `request.user` 构造 `ProjectRequestContext`。preHandler 解析权限时使用此 helper 获取基础上下文。
