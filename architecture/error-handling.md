# Error Handling
<!-- depends-on: AGENTS.md, conventions.md#路由约定 -->
<!-- L1: Error Categories, HTTP Mapping, Development And Production Responses -->
<!-- L2: Current Migration Strategy, PreHandler Pattern, UI Routes, Global Error Handler -->

HAICO backend error handling follows a layered model:

- **PreHandlers** enforce access control and input validation before routes run. They throw domain errors (e.g. `AdminRoleRequiredError`, `InputValidationError`, `RemoteInstanceNotFoundError`) that flow through the same error-mapper pipeline. PreHandlers are pure Fastify adapters — no business logic, no service imports beyond `services/project-access/` for permission resolution.
- **Routes** describe the successful HTTP flow: read params/body/query, call services, and return success responses.
- **Services** contain business logic. When business rules fail, services throw specific domain errors such as `KnowledgeEntryNotFoundError` or `InvalidKnowledgeCategoryError`.
- **Services do not return transport-shaped failures** such as `{ ok: false, statusCode, error }`.
- **Services do not wrap internal tools by default**. Database, filesystem, and third-party errors should bubble up unless the service can translate them into a clearer domain error.
- **Framework middleware** catches thrown errors and turns them into HTTP responses.

## Error Categories

There are two broad categories:

1. **Expected domain errors**

   These represent known business outcomes:

   - validation failures
   - missing entities
   - conflicts
   - authorization failures

   Domain errors should be explicit classes owned by their domain module. For example, knowledge-specific errors live near knowledge services, not in the Fastify middleware layer.

2. **Unexpected internal errors**

   These represent implementation failures or infrastructure problems:

   - database errors
   - filesystem errors
   - programming bugs
   - third-party library failures

   These should bubble up to the global error handler. The real error is logged, but production responses should not expose private details.

## HTTP Mapping

Domain errors are mapped to HTTP by framework-level code:

- invalid input -> `400`
- unauthenticated -> `401`
- forbidden -> `403`
- not found -> `404`
- conflict -> `409`
- unknown internal errors -> `500`

The mapping belongs outside services. Services should not need to know HTTP status codes.

## Development And Production Responses

The global error handler should always log the real error.

For API responses:

- expected domain errors return their public message in all environments
- unexpected errors return the real message outside production
- unexpected errors return `Internal server error` in production

## Current Migration Strategy

The core framework pieces are in place: routes use Fastify preHandlers for access
control, the global Fastify error handler delegates to
`src/errors/error-mapper.ts`, and domain modules own their specific error
classes.

Continue migration gradually:

1. For one service at a time, add or refine domain-specific error classes.
2. Change services to throw domain errors instead of returning HTTP-shaped failure results.
3. Keep existing routes that already send `{ error }` responses working until they are touched for related work.
4. Add new domain errors to `src/errors/error-mapper.ts` so response shape stays `{ error: string }`.

The long-term target is that new routes call services directly and let errors bubble to middleware.

## PreHandler Pattern

PreHandlers live in `src/routes/prehandlers/` and enforce access control or input validation before route handlers run. They are attached via Fastify's `fastify.register()` scope + `addHook('preHandler', ...)` pattern, not as inline checks inside handlers.

Available prehandlers (see `src/routes/prehandlers/index.ts`):

| PreHandler | Purpose | Throws |
|---|---|---|
| `requireAdminRolePrehandler()` | Admin-only routes | `AdminRoleRequiredError` → 403 |
| `requireProjectAccessPrehandler({ param?, manage? })` | Project membership + manage check | `ProjectAccessDeniedError` → 403 |
| `requireEntityAccessPrehandler(entity, { param?, manage? })` | Entity ownership within project | `EntityNotFoundError` → 404, `ProjectAccessDeniedError` → 403 |
| `requireRemoteInstancePrehandler({ param?, requireEnabled? })` | Resolve remote instance by ID | `RemoteInstanceNotFoundError` → 404, `RemoteInstanceDisabledError` → 400 |
| `requireReactionTargetTypePrehandler({ param? })` | Validate reaction target type | `InvalidReactionTargetTypeError` → 400 |
| `validateInput({ body?, query? })` | Field-level input validation | `InputValidationError` → 400 |

PreHandlers resolve data and attach results to the request object (e.g. `request.projectPermission`, `request.resolvedEntity`, `request.resolvedRemoteInstance`). Route handlers read these via non-null assertion (`request.projectPermission!`) since the preHandler guarantees they exist by the time the handler runs.

### Scope Pattern

```typescript
// Admin-only routes
fastify.register(async (adminScope) => {
  adminScope.addHook('preHandler', requireAdminRolePrehandler());
  adminScope.get('/admin-resource', async () => { ... });
});

// Project-scoped routes
fastify.register(async (projectScope) => {
  projectScope.addHook('preHandler', requireProjectAccessPrehandler());
  projectScope.get('/projects/:id/...', async (request) => {
    const permission = request.projectPermission!;
  });
});
```

### What Belongs in PreHandlers vs Route Handlers

- **PreHandler**: role checks, project/entity permission resolution, remote instance lookup, input field validation (required/enum/json/url). No business logic — only Fastify adapter code.
- **Route handler**: business-specific validation (e.g. "cannot delete yourself", "default admin cannot be demoted"), service calls, response shaping.
- **Service**: all business rules, DB operations, domain errors.

### UI Routes (ui.ts)

Admin page routes in `ui.ts` (`/admin/users`, `/admin/global-settings`, `/admin/system`) currently use an **inline** `request.user.role !== 'admin'` check inside the handler (redirecting non-admins to `/overview`), not the preHandler + scope pattern. They serve static HTML shells via `serveHtml(file)` which are hydrated client-side; they are not SSR/HTMX partial fragment routes. There is no `isRequestAdmin` helper — any reference to it was a documentation error. When these routes are next touched, they should migrate to the standard preHandler + scope pattern (`requireAdminRolePrehandler()`).


---

## Global Error Handler

`setupErrorHandler(fastify)` (`src/middleware/error-handler.ts`) 注册全局 `setErrorHandler`，是所有未被 route scope handler 捕获的错误的最后兜底：

1. 调 `mapErrorToHttp(error)` 拿到 `{ statusCode, message, redirect?, extra? }`
2. `statusCode >= 500` → `request.log.error`；否则 `request.log.debug`
3. **浏览器重定向分支**：GET 请求且 URL 不以 `/api/` 或 `/ws` 开头且 `mapped.redirect` 存在 → `reply.redirect(redirect)`。用于认证错误将浏览器导向 `/login`、`/register`、`/overview`
4. **默认 JSON 分支**：`reply.code(statusCode).send({ error: message, ...extra })`

<!-- code-fact: redirect 规则 = GET && !startsWith('/api/') && !startsWith('/ws') && mapped.redirect 存在 -->
当前带 redirect 的错误映射（见 `src/errors/http-error-tables/auth.ts`）：

| 错误 | statusCode | redirect |
|---|---|---|
| `AuthenticationRequiredError` | 401 | `/login` |
| `NoAuthenticationConfiguredError` | 401 | `/register` |
| `AdminRoleRequiredError` | 403 | `/overview` |

**与 `/ui/` scope handler 的关系**：`/ui/` 片段 scope 注册了自己的 `setErrorHandler` 返回 HTML 错误片段（见 `htmx-ssr-fragments-impl.md` §路由文件结构），覆盖此全局 handler。全局 handler 只处理 `/api/` JSON 路径和 shell GET 路径。