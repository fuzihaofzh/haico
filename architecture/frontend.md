<!-- depends-on: AGENTS.md, htmx-ssr-fragments-impl.md#h/html/renderToString helper -->
# Frontend

前端架构约定。HAICO 前端无构建工具, SSR 壳子 + htmx 片段 + 客户端 JS。

---

## 基础形态

### L1: 前端结构

- **静态壳子**: `public/*.html` + `src/views/` (服务端 HTML 片段渲染函数) + `public/css/` + `public/js/`
- **无前端构建工具**: 页面资源通过 `/public/...` 本地路径引用
- **`src/views/` 约束**: 函数只接收 ViewData 返回 string/HtmlFragment, 禁止 import Fastify/DB
- **htmx 分界线**: 状态在服务端 → htmx 片段 (`/ui/` 端点 + `src/views/`); 状态在客户端运行时 (localStorage/AudioContext/WS) → `public/js/` 客户端 JS

---

## CSS 架构

### L1: CSS 层级体系

- **方法论**: CUBE CSS + `@layer`
- **单入口**: `public/css/index.css`
- **layer 优先级** (升序): `reset → base → composition → block → utility → exception`
- **页面级样式**: 放入 `public/css/layers/blocks/`, 按组件命名（如 `auth.css`、`terminal.css`）
- **禁止**: 新增独立 CSS 文件或 inline `<style>`; 新样式按职责归入对应 layer
- **未分层 CSS** (如 `codicon.css`): 优先级高于所有 layer, 禁止滥用

---

## JS 模块化

### L1: JS 模块规范

- 新增或重写前端脚本时优先使用 ES Module（`<script type="module">` + `import/export`）
- 仅在兼容既有非模块脚本时保留普通 script

---

## 第三方库

### L1: Vendor 政策

- 浏览器端依赖 vendored 到 `public/vendor/`, 禁止直接引用外部 CDN
- 新增/升级库时记录版本并确保静态文件可离线加载

### L2: Vendor 同步机制

- `postinstall` 自动从 `node_modules` 复制 `docx-preview` / `xlsx` / `jszip` / `@vscode/codicons` 到 `public/vendor/` 与 `public/css/codicon.*`
- 手动改动这些文件会在下次 `npm install` 被覆盖, 需改源头包或同步逻辑

---

## 缓存失效

### L1: 缓存策略

- 自研静态资源 URL 禁止使用 `?v=` / `?ver=` 等手动版本号做 cache-bust
- 缓存失效由服务端 ETag 协商机制自动处理

---

## HTML Helper

### L2: 服务端 `h` / `html` / `renderToString`

`src/views/html.ts` 提供:

- `h\`...\`` — tagged template, **自动转义**插值, 返回 `HtmlFragment` (不是 string)
- `html(str)` — 标记字符串为已转义的安全 HTML, 返回 `HtmlFragment`
- `renderToString(fragment)` — 在 route 边界把 `HtmlFragment` 转成 `string`

`h` 返回 `HtmlFragment` 后, 子 view 直接 `${child()}` 插值无需 `html()` 包裹; 数组直接 `${items.map(fn)}` 无需 `.join('')`。
`html()` 仅用于原始 HTML 字符串 (非 `h` 产出的, 如第三方库返回的 HTML、硬编码 SVG)。

详见 `htmx-ssr-fragments-impl.md` §h/html/renderToString helper。

### L2: 客户端 `h` / `html`

`public/js/shared/common.js` 暴露全局 `h` tagged template 与 `html(value)` 片段标记。
客户端 `h` 返回 `string` (浏览器 `innerHTML` 需要)。两套实现独立 (CommonJS ↔ ESM), 不跨端 import。
新增/迁移客户端 HTML 字符串时优先用 `h\`...\``; 普通数据直接 `${value}` 自动转义;
仅对已由 `h` 生成、静态 SVG/icon、或明确可信的内部 HTML 片段使用 `${html(fragment)}`, 不要对用户输入使用 `html(...)`。
