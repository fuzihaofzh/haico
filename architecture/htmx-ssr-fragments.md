# Htmx SSR 片段迁移指南

本文件记录 admin 三页面 (`/admin/users`、`/admin/global-settings`、`admin/system`) 从 CSR (fetch JSON + innerHTML) 迁移到 htmx (服务端渲染 HTML 片段 + 声明式 DOM swap) 的技术决策与经验。**对其他页面进行同样改造前必须先读本文件。**

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

## 3. 路由文件结构：两个 scope

参考 `src/routes/ui-admin.ts`。一个 `registerXxxUIRoutes(fastify)` 内注册两个 `fastify.register` scope：

### 3.1 Shell scope (无 prefix)

```ts
fastify.register(async (shellScope) => {
  shellScope.addHook('preHandler', requireAdminRolePrehandler());

  shellScope.get('/admin/users', async (_request, reply) => {
    const body = renderUsersPage('/admin/users');
    return reply.type('text/html').send(renderAdminShell({ title: '...', body }));
  });
});
```

- **不需要自定义 error handler**：权限错误 (`AdminRoleRequiredError` → 403) 流向全局 handler，全局 handler 对 GET 非 `/api/` 请求做 redirect (见 `src/errors/http-error-tables/auth.ts` 的 `redirect` 字段)。
- Shell 路由只做：调 view 函数拿 body → 包进 `renderAdminShell` → `reply.type('text/html')`。

### 3.2 Fragment scope (prefix `/ui`)

```ts
fastify.register(async (fragmentScope) => {
  fragmentScope.addHook('preHandler', requireAdminRolePrehandler());

  fragmentScope.setErrorHandler((error, request, reply) => {
    const mapped = mapErrorToHttp(error);
    const statusCode = mapped?.statusCode || 500;
    if (statusCode >= 500) request.log.error({ err: error }, '...');
    else request.log.debug({ err: error, statusCode }, '...');
    const message = mapped ? mapped.message
      : process.env.NODE_ENV === 'production' ? 'Internal server error'
      : getUnexpectedErrorMessage(error);
    return reply.code(statusCode).type('text/html').send(adminErrorFragment(message));
  });

  fragmentScope.get('/admin/users/list', async (request) => {
    return renderUserList(listUsers(getDatabase()), request.user!.id);
  });
  // ...更多片段端点
}, { prefix: '/ui' });
```

- **scope 级 `setErrorHandler` 覆盖全局 JSON handler**：任何抛出的领域错误在这里映射成 HTML 片段 + HTTP status。
- 复用与 shell scope 相同的 preHandler —— 权限检查不重复。
- 片段端点只做：解析 params/body → 调 service → 调 view 函数 → return string (Fastify 自动 `text/html`)。

---

## 4. Views 层规则

`src/views/` 下的函数：

- **只接收 ViewData (plain data) + 配置，返回 string**。
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

---

## 5. `h` / `html` helper 与转义陷阱 (最重要)

`src/views/html.ts` 提供两个函数：

- `h\`...\``  — tagged template，**自动转义**插值。普通数据 `${value}` 安全。
- `html(str)` — 标记字符串为已转义的安全 HTML，`h` 遇到 `HtmlFragment` 对象会原样输出。

### 5.1 致命陷阱：子片段组合时漏包 `html()`

**这是本次迁移中出现三次的 bug，是最高频错误。**

当外层 `h\`...\`` 模板里插值一个**本身是 HTML 的字符串**时，必须用 `html()` 包，否则 `h` 会把它当普通数据转义，`<span>` 变成 `&lt;span&gt;`，页面上显示原始标签文字。

**错误** (bug 现场)：
```ts
const actions = isSelf
  ? h`<span class="text-secondary">you</span>`      // 返回 string
  : html(h`<button>...</button>`);                    // 返回 HtmlFragment

return h`<tr><td>${actions}</td></tr>`;
//                              ^^^^^^^
// isSelf 分支：actions 是 plain string → h 转义 → 页面显示 "&lt;span...&gt;you&lt;/span&gt;"
// 非 self 分支：actions 是 HtmlFragment → h 原样输出 → 正确
```

**正确**：
```ts
const actions = isSelf
  ? html(h`<span class="text-secondary">you</span>`)  // 包一层 html()
  : html(h`<button>...</button>`);
```

### 5.2 组合站点清单

任何 `${someRenderFunction()}` 或 `${someHtmlString}` 出现在 `h\`...\`` 里，都要检查那个值是否已经是 `HtmlFragment`：

| 场景 | 正确写法 |
|---|---|
| 调子 view 函数 | `${html(renderAdminNav(path))}` |
| 条件返回 HTML 字符串 | 两分支都用 `html(...)` 包，或在外层组合站点包 |
| 数组 join 后的 HTML | `${html(items.map(renderRow).join(''))}` |
| 已经是 `h\`...\`` 产生的 string | 必须 `html(...)` 再包一层 |

**自检规则**：只要 `h\`...\`` 里出现 `${`，且插值内容是 HTML 片段而非纯文本数据，就要 `html()`。

### 5.3 为什么不直接让 `h` 返回 HtmlFragment

`h` 返回 `string` 是刻意的 —— 与客户端 `public/js/shared/common.js` 的 `h` 行为一致，便于前后端两套实现保持同步。`html()` 是显式的"我确认这是安全 HTML"opt-in，避免误把用户输入当 HTML。

---

## 6. Shell SSR 模式

`renderAdminShell({ title, body })` (`src/views/shell.ts`) 产出完整 HTML 文档：

- 保留 sidebar/header 骨架 (客户端 `dashboard-sidebar.js` hydrate)。
- 加载 htmx (`<script defer src="/public/vendor/htmx.min.js">`)。
- 加载片段事件监听 (`<script type="module" src="/public/js/shared/admin-htmx.js">`)。
- body 通过 `${html(body)}` 注入 `<main>` —— 注意这里 body 是 string，必须 `html()` 包。

页面 view 函数 (如 `renderUsersPage`) 返回 `<main>` 内部内容，不含 shell。Shell route 组合：

```ts
const body = renderUsersPage('/admin/users');
reply.type('text/html').send(renderAdminShell({ title: 'Admin - Users - HAICO', body }));
```

---

## 7. 片段端点模式 (带真实示例)

### 7.1 列表 swap

列表容器在 shell 里是空壳，`hx-trigger="load"` 触发首次加载：

```html
<!-- shell (renderUsersPage) -->
<div id="users-list" hx-get="/ui/admin/users/list" hx-trigger="load" hx-swap="innerHTML">
</div>
```

```ts
// 片段端点
fragmentScope.get('/admin/users/list', async (request) => {
  return renderUserList(listUsers(getDatabase()), request.user!.id);
});
```

CRUD 操作后返回**新的完整列表**，swap 回同一容器：
```ts
fragmentScope.delete('/admin/users/:id', async (request) => {
  deleteUser(getDatabase(), (request.params as { id: string }).id);
  return renderUserList(listUsers(getDatabase()), request.user!.id);
});
```

### 7.2 Modal 对话框 (`<dialog>` + htmx)

挂载点在 shell 里：`<div id="modal-mount"></div>`。

打开 modal = htmx 把 `<dialog open>` 片段塞进 mount：
```html
<button hx-get="/ui/admin/users/add" hx-target="#modal-mount" hx-swap="innerHTML">Add User</button>
```
```ts
fragmentScope.get('/admin/users/add', async () => renderAddUserDialog());
// renderAddUserDialog 返回 <dialog open class="admin-modal">...</dialog>
```

表单提交后：
- **成功**：返回新列表 swap 到 `#users-list`，同时 `HX-Trigger` 头触发 toast，modal 内容被列表覆盖 (或返回空 + `HX-Retarget` 关闭)。
- **校验失败**：`HX-Retarget` 指向 `#modal-mount`，返回带错误提示的新 dialog。

```ts
fragmentScope.post('/admin/users/add', async (request, reply) => {
  const result = registerUser(db, { ... });
  if (result === 'duplicate') {
    reply.header('HX-Retarget', '#modal-mount');
    return renderAddUserDialog();  // 重新渲染带错误的 dialog
  }
  reply.header('HX-Trigger', JSON.stringify({ showToast: 'User added' }));
  return renderUserList(listUsers(db), request.user!.id);
});
```

关闭 modal：Cancel 按钮用 `onclick="document.getElementById('modal-mount').innerHTML=''"`，或返回一个 `<script>` 片段执行关闭 + toast (见 `renderResetPasswordSuccess`)。

### 7.3 Toggle 反向状态 (服务端无状态)

开关按钮 POST **当前状态的反值**，端点返回反映新状态的全新按钮。客户端完全不持有 on/off 状态：

```ts
// View: 按钮携带 nextState (当前取反)
function renderEventLogToggleButton(enabled: boolean): string {
  const nextState = !enabled;
  return h`<button ... hx-post="/ui/admin/settings/event-log"
    hx-vals='{"event_log_enabled": ${nextState}}'
    hx-target="this" hx-swap="outerHTML">...</button>`;
}

// Endpoint: 应用后返回新按钮
fragmentScope.post('/admin/settings/event-log', async (request) => {
  const enabled = applyEventLogEnabled((request.body as any)?.event_log_enabled);
  return renderEventLogToggleButton(enabled);
});
```

`hx-swap="outerHTML"` + `hx-target="this"` = 用新按钮替换旧按钮自身。

### 7.4 整面板 swap + 服务端状态 (remote instances)

复杂面板 (列表 + 编辑表单 + 状态消息) 把所有状态留在服务端，每次 CRUD 返回**整个面板内部 HTML**，`innerHTML` swap：

```html
<!-- shell 里的稳定外壳 -->
<div id="remote-instances-settings"
     hx-get="/ui/admin/remote-instances" hx-trigger="load" hx-swap="innerHTML">
</div>
```

```ts
// 所有 remote 端点都返回 renderRemotePanel(...)
fragmentScope.post('/admin/remote-instances', async (request) => {
  try {
    await createRemoteInstance(getDatabase(), { ... }, logger);
    return renderRemotePanel(remoteViews(), { notice: 'Remote instance added' });
  } catch (err) {
    return renderRemotePanel(remoteViews(), {
      error: err instanceof Error ? err.message : 'Failed',
    });
  }
});
```

- **`editingId` → URL query param** (`?editing=id`)：编辑哪行由 query 决定，不存客户端。
- **`statusMessage` → 服务端在面板内渲染**：`{ notice }` / `{ error }` 选项，view 函数渲染成面板内的提示条。
- **错误重新渲染整个面板** (错误内联在面板里)，不返回裸错误片段。

### 7.5 跨单元格的 form-button 关联

按钮和表单分属不同 `<td>` 时，用 HTML `form="<id>"` 属性关联，而非把表单裹住整行：

```ts
const formId = `remote-form-${editing.id}`;
return h`
  <tr>
    <td><form id="${formId}" hx-put="..." hx-target="#remote-instances-settings" hx-swap="innerHTML">
      <input name="base_url" ...>
    </form></td>
    <td>...</td>
    <td>
      <button type="submit" form="${formId}" class="btn btn-sm btn-primary">Save</button>
    </td>
  </tr>`;
```

唯一 form id：`remote-form-new` / `remote-form-${id}`。

### 7.6 静默成功 (`hx-swap="none"` + `HX-Trigger`)

不需要更新 DOM 的操作 (如保存配置)，返回空 body + toast 头：

```ts
fragmentScope.put('/admin/settings/log-retention', async (request, reply) => {
  const value = applyLogRetention((request.body as any)?.log_retention_days);
  reply.header('HX-Trigger', JSON.stringify({ showToast: `Log retention set to ${value} days` }));
  return '';
});
```
View 侧：`hx-put="..." hx-trigger="change" hx-swap="none"`。

---

## 8. Toast 与 Confirm

- **Toast**：响应头 `HX-Trigger: {"showToast":"消息"}`。客户端 `public/js/shared/admin-htmx.js` 监听 `htmx:afterRequest` 事件读取该头并触发 toast。
- **确认对话框**：`hx-confirm='删除用户 "alice"？此操作不可撤销。'`，浏览器原生 confirm。
- **关闭 modal + toast 同时**：返回 `<script>` 片段执行 `document.getElementById('modal-mount').innerHTML=''` + `document.body.dispatchEvent(new CustomEvent('showToast', {...}))`。

---

## 9. CSS 规则

- **复用现有 class 词汇**，不发明新命名。
- 片段需要的样式抽到 `public/css/layers/blocks/admin.css` (admin 专用 block)，归入对应 `@layer block`。
- **禁止新增独立 CSS 文件**，**禁止 inline `<style>`**。
- 已有 class：`.admin-card-body`、`.admin-error-toast`、`.admin-toast`、`.admin-modal`、`.admin-modal-card`、`.admin-modal-title`、`.admin-modal-form`、`.admin-modal-input`、`.admin-modal-actions`、`.admin-number-input`、`.data-table-select`、`.data-table-actions`。

---

## 10. 测试模式

单元测试 (`test/unit/*-views.test.ts`) 用 `node:test` + `node:assert/strict`，直接调 view 函数：

```ts
it('shows "you" instead of action buttons for self', () => {
  const html = renderUserRow(sampleUser, { currentUserId: 'u-1' });
  // 必须断言真实 HTML 标签，不能只断言文字内容 —— 否则转义 bug 会漏过
  assert.match(html, /<span class="text-secondary">you<\/span>/);
  assert.doesNotMatch(html, /&lt;span/);
});
```

**关键教训**：`/you/` 这样的弱断言无法捕获转义 bug —— 转义后文字 `you` 仍在。必须断言**真实标签结构** + 反向断言**转义形式不存在** (`&lt;span`)。

测试覆盖点：
- nav active 状态
- XSS 转义 (用户输入含 `<script>`)
- htmx 属性 (`hx-get`/`hx-post`/`hx-target`/`hx-swap`/`hx-trigger`/`hx-confirm`/`hx-vals`)
- modal 渲染 (`<dialog open>`)
- 自身行权限 (无 delete 按钮、role select disabled)
- 空状态、编辑态、错误态

---

## 11. 迁移检查清单

对新页面做 CSR → htmx 迁移时按此走：

1. **抽取 service**：把 inline 在 route 里的业务逻辑下沉到 `src/services/<area>/<feature>.ts`，`/api/` 和 `/ui/` 共用。
2. **建 view 文件**：`src/views/<area>/<feature>.ts`，函数接收 ViewData 返回 string，禁止 import Fastify/DB。
3. **建 shell route** (如有新 shell)：`/admin/*` scope，调 view → `renderAdminShell` → `text/html`。复用现有 shell 则跳过。
4. **建片段端点**：`/ui/admin/*` scope (带 `setErrorHandler` → HTML 错误片段)。
5. **写 view 函数**：每个交互 (list/modal/toggle/panel) 一个 render 函数。**所有子片段组合站点检查 `html()` 包裹**。
6. **CSS**：新样式归入 `public/css/layers/blocks/admin.css`，复用现有 class。
7. **删旧 CSR**：删除 `public/<page>.html` + `public/js/pages/<page>.js`。
8. **单元测试**：view 函数全覆盖，断言真实标签结构 + 反向断言转义。
9. **冒烟测试**：SSR shell 200、片段端点 200、权限失败返回 HTML 错误片段、`/api/` JSON 不受影响、非 admin redirect。
10. **`tsc --noEmit`** clean。

---

## 12. 常见错误速查

| 症状 | 原因 | 修复 |
|---|---|---|
| 页面显示 `&lt;span...&gt;` 原文 | 子片段 string 未包 `html()` | 组合站点 `${html(fragment)}` |
| htmx 把 JSON 错误塞进 DOM | `/ui/` scope 没设 `setErrorHandler` | 加 scope 级 handler 返回 HTML 片段 |
| 片段返回了完整 HTML 文档 | 片段端点误调 `renderAdminShell` | 片段只返回 `<main>` 内部内容 |
| 非管理员看到 JSON 401 | shell scope 用了片段 handler | shell scope 不设 handler，走全局 redirect |
| Modal 提交后列表没刷新 | target 指错 | 表单 `hx-target="#users-list"` 而非 `#modal-mount` |
| Toggle 点一次就坏 | POST 了当前值而非反值 | `hx-vals` 携带 `nextState = !current` |
| `: any` lint 报错 | body 解析用了 any | 用具体类型或无标注 `as { field?: string }` |
