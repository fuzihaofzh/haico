# Service 子目录规范

当单个 service 文件变大，或一个业务能力需要多个协作模块时，可以拆成 `src/services/<domain>/` 子目录。子目录表示一个业务能力包，不是通用工具集合。

## 必备文件

- `index.ts`: public facade，只 re-export 对外能力；routes 和其他模块优先从这里 import。
- `types.ts`: service 层共享输入/输出类型；不要放 Fastify request/reply 类型。
- `errors.ts`: 领域错误类型；每个错误类直接继承 `Error`，只表达业务语义和 message，不携带 HTTP `statusCode`。

## 常用文件

- `policy.ts`: 业务规则常量，如大小限制、状态枚举、MIME map、阈值等。
- `<capability>.ts`: 按业务能力拆分实现，例如 `core.ts`、`files.ts`、`runs.ts`。

## 约束

- Route 只处理传输层：解析 HTTP 输入、鉴权、调用 service、设置成功状态码和 headers。
- Service 承载业务逻辑：DB 查询、文件系统、进程生命周期、序列化和领域事件发布；实时 fanout 由 `src/realtime/` 负责。
- Service 不依赖 Fastify；需要日志时传入最小 logger interface。
- 业务失败由 service 抛领域错误，HTTP status code 统一在 `src/errors/error-mapper.ts` 映射。
- `index.ts` 不写业务逻辑，避免重新变成大文件。
- 不保留 legacy facade 文件；重构时直接更新调用方 import 到新的 package 入口。
