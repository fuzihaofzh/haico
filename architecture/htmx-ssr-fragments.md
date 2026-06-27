# Htmx SSR 片段迁移指南
<!-- depends-on: AGENTS.md, frontend.md#HTML Helper, conventions.md#API约定 -->
<!-- L1: 何时用这个模式, 三层路径结构, Views层规则 -->
<!-- L2: 见 htmx-ssr-fragments-impl.md -->

本文件承载 admin 三页面 (`/admin/users`、`/admin/global-settings`、`admin/system`) htmx 迁移的 L1 契约：何时用此模式、三层路径结构、Views 层规则。L2 实现段（路由文件结构、helper 细节、片段端点模式、Shell SSR、Toast/Confirm、CSS、测试、迁移清单、错误速查）见 `htmx-ssr-fragments-impl.md`。

参考实现：`src/routes/ui-admin.ts`、`src/views/shell.ts`、`src/views/html.ts`、`src/views/admin/*`。

---

## 1. 何时用这个模式

**状态在服务端** → htmx 片段 (`/ui/` 端点 + `src/views/`)。
**状态在客户端运行时** (localStorage / AudioContext / WebSocket 流 / 实时编辑器) → 保留 `public/js/` 客户端 JS。

htmx 适合：CRUD 表单、列表/表格、toggle 开关、modal 对话框、服务端校验反馈。不适合：高频实时推送 (用 WS)、纯客户端 UI 状态 (主题切换、折叠面板)。

---

## 2. 三层路径结构

同一业务操作有三个入口，**共享同一 service 函数**，仅响应序列化不同：

| 路径前缀 | 返回内容 | 用途 |
|---|---|---|
| `/admin/*` | 完整 HTML 文档 (shell) | 首屏 SSR，浏览器直接访问 |
| `/ui/admin/*` | HTML 片段 (无 shell) | htmx swap，交互后局部更新 |
| `/api/admin/*` | JSON | 程序化客户端 (脚本、外部集成) |

**铁律**：`/ui/` 的错误必须返回 HTML 错误片段 + 4xx/5xx，**不能**返回 `{ error }` JSON —— htmx 拿到 JSON 会把原文塞进 DOM。

---

## 4. Views 层规则

`src/views/` 下的函数：

- **只接收 ViewData (plain data) + 配置，返回 `HtmlFragment`** (`h\`...\`` 的返回类型)。Route 边界用 `renderToString()` 转 string。
- **禁止 import Fastify / DB / service**。View 是纯函数，可独立单测。
- 需要 DB 数据时，由 route handler 调 service 拿到数据，再传给 view。
- 需要当前用户 ID 等请求上下文时，由 handler 从 `request.user` 取出后作为参数传入 (如 `renderUserList(users, currentUserId)`)。

目录结构：
```
src/views/
  html.ts          # 服务端 h/html helper (独立实现，不 import 客户端)
  shell.ts         # renderAdminShell({title, body})
  admin/
    nav.ts         # renderAdminNav(path), renderAdminPageHeader()
    system.ts      # 每页一个文件：renderXxxPage + 子片段函数
    settings.ts
    users.ts
    remote.ts
```
