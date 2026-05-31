# Realtime / WebSocket 规范

HAICO 的 WebSocket 不是裸 `ws` 随意响应模式，而是一层规定型 realtime transport。所有 WS endpoint 都必须经过 Fastify route 注册、实体权限校验、realtime adapter 和统一 WS error boundary。

## 通道职责

- `/ws/projects/:id/events`: project-level live events。用于 agent 状态、issue、comment、executive summary 等页面刷新信号。需要 project read access。
- `/ws/agents/:id/terminal`: agent run output stream。用于 stdout/stderr/exit/error 等运行输出。需要 agent read access。
- `/ws/terminal/:agentId`: interactive PTY terminal。用于 input、resize、kill 和 terminal output。需要 agent manage access。

## 分层规则

- `src/routes/ws.ts` 只负责 URL、query/params 解析和权限校验。
- `src/realtime/*` 负责 socket 生命周期、fanout、交互式 terminal adapter 和错误边界。
- Service 层可以发布 realtime event，但不能注册 WebSocket route，也不能直接决定 WS wire error 文案。
- Adapter 内部遇到协议或运行时问题应抛错误或调用 `handleWebSocketError`，由 `error-mapper.ts` 决定发送给客户端的 `{ type: 'error', code, message }`。

## 错误边界

WS 错误分两段处理：

- Upgrade 前：认证、权限、实体不存在仍走 Fastify lifecycle 和 HTTP `src/errors/error-mapper.ts`，返回 HTTP `401/403/404`。
- 连接后：普通 Fastify error handler 不再自动接管 socket message lifecycle，必须走 `src/realtime/error-boundary.ts`。

连接后的错误响应统一为：

```json
{ "type": "error", "code": "invalid_message", "message": "Malformed WebSocket JSON message" }
```

常用映射：

- `invalid_message`: malformed JSON 或 payload shape 错误，不关闭连接。
- `unknown_message_type`: 未知 message type，不关闭连接。
- `invalid_resize`: terminal resize 参数非法，不关闭连接。
- `forbidden` / `not_found`: 连接后权限或资源错误，close code `1008`。
- `terminal_unavailable` / `terminal_error`: PTY 不可用、创建失败、写入失败，close code `1011`。
- `websocket_error`: 未预期错误，close code `1011`。

`NODE_ENV=production` 默认隐藏内部错误细节；开发模式或 `HAICO_DEBUG_WS=true` 会返回更具体的 `error.message`。详细 stack 只应进入 server log。

## Adapter 写法

新的 WS adapter 应遵守：

- route 使用 `preValidation` 做实体权限，让 upgrade 前错误继续走 HTTP error mapper。
- handler 中同步绑定 `message`、`close`、`error` listener，避免 async 初始化期间丢消息。
- message handler 内不要手写错误响应文案；抛协议错误或调用 `handleWebSocketError`。
- fanout 使用 `WebSocketChannelHub`，单个 client `send` 失败只清理该 client，不影响同 channel 其他连接。
