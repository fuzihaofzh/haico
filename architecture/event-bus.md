# Domain Event Bus

HAICO 使用进程内事件总线（`src/events/`）解耦领域服务之间的副作用。当 Issue 被创建、更新，或 Task 完成时，发布者只发出一个领域事件，由注册的订阅者分别处理 WebSocket 推送、Agent 启动、Controller 触发等副作用。

## 何时使用 EventBus

**应该用 EventBus 的场景：**

- 服务函数完成一次业务操作后，需要触发一个或多个**不属于自身职责**的副作用。例如 `createIssue` 完成后需要通知前端、启动 Agent、触发 Controller——这些都不属于 "创建 Issue" 的核心职责。
- 多个服务之间有因果联动但不需要同步返回值。例如 Task 完成后触发 Controller，Controller 完成后触发 Issue Recovery。
- 需要对高频事件做 coalescing（合并），避免短时间内重复触发昂贵操作（如 Controller 编排）。

**不应该用 EventBus 的场景：**

- 调用方需要同步获取返回值。EventBus 是 fire-and-forget，没有返回值。如果你需要 `const result = doSomething()`，直接调用函数。
- 同一事务内的级联数据变更。例如 `createIssue` 事务内更新父 issue 状态——这属于同一业务操作的一部分，应在事务内直接完成，不应通过事件（事件发布在事务提交之后）。
- 纯数据查询。没有副作用就不需要事件。

## 架构

```
Publisher (services/issue/core.ts)
  → eventBus.publish('issue.created', { ... })

EventBus (events/bus.ts)
  → middleware chain: correlation → logging → persistence → dispatch

Subscribers (events/subscribers/)
  → realtime-subscriber         → broadcastToProject()
  → agent-subscriber            → autoStart / mentions / ensureAgentKnowledgeEntry
  → agent-deletion-subscriber   → cleanup issues/knowledge/sessions on agent.deleted
  → controller-subscriber       → triggerControllerAgent() (with coalescing)
  → task-subscriber             → issue recovery scan + scoped agent restart
  → task-creation-subscriber    → createAgentTaskWithId() + audit comments
  → project-deletion-subscriber → cleanup knowledge/sessions/summaries on project.deleted
```

### 依赖方向

```
src/events/          ← 核心模块，不依赖 src/services/
  bus.ts, types.ts, events.ts, middleware.ts, coalescing.ts, store.ts

src/events/subscribers/  ← 唯一同时依赖 events/ 和 services/ 的地方
  realtime-subscriber.ts
  controller-subscriber.ts
  agent-subscriber.ts
  agent-deletion-subscriber.ts
  project-deletion-subscriber.ts
  task-subscriber.ts
  task-creation-subscriber.ts

src/services/        ← 发布者，只依赖 events/bus 的 publish
```

**`src/events/` 核心文件禁止 import `src/services/`**。Subscriber 文件是依赖方向的 U 型反转点。

### 数据流

```
用户创建 Issue
  → POST /api/projects/:pid/issues
  → createIssue(db, projectId, input)           [core.ts — 纯 DB + 事务]
  → eventBus.publish('issue.created', ...)       [发布事件]

  [EventBus 同步分发]
  → correlationMiddleware                        [填充 correlationId]
  → loggingMiddleware                            [记录日志]
  → persistenceMiddleware                        [写入 domain_events 表]
  → realtime-subscriber                          [broadcastToProject]
  → agent-subscriber                             [autoStart + mentions]
  → controller-subscriber                        [coalesce 3s → triggerControllerAgent]
```

## 事件定义

所有领域事件定义在 `src/events/events.ts`。每个事件有类型化的 `type`、`projectId`、`payload` 和 `meta`。

当前已定义的事件：

| 事件 | 发布者 | Payload 关键字段 |
|------|--------|-----------------|
| `issue.created` | `issue/core.ts` | issueId, issueNumber, createdBy, assignedTo, body |
| `issue.updated` | `issue/core.ts` | issueId, issueNumber, changes, actor, parentCompletion |
| `issue.deleted` | `issue/core.ts` | issueId, issueNumber |
| `agent.created` | `agents/core.ts`, `projects/core.ts` | agentId, agentName, projectId, isController |
| `agent.deleted` | `agents/core.ts` | agentId, agentName, hadActiveTask |
| `project.deleted` | `projects/core.ts` | agentIds |
| `scheduler.tick` | `scheduler/index.ts` | tickType |
| `comment.added` | `issue/comments.ts` | issueId, issueNumber, commentId, authorId, body |
| `issue.relation_changed` | `issue/relations.ts` | sourceIssueId, targetIssueId, relationType, action |
| `task.completed` | `tasks/completion.ts` | taskId, taskType, status, issueNumbers |
| `agent.status_changed` | `agents/lifecycle.ts`, `executors/cli-executor.ts` | agentId, status, paused?, taskId?, taskRunId? |
| `agent.message_sent` | `agents/messages.ts` | message, fromAgentName, toAgentName |
| `agent.message_updated` | `tasks/completion.ts` | message, status |
| `summary.created` | `executive-summaries/core.ts` | summary |
| `summary.updated` | `executive-summaries/core.ts` | summary |
| `summary.deleted` | `executive-summaries/core.ts` | summaryId |
| `summary.block_updated` | `executive-summaries/core.ts` | summaryId, block |
| `summary.generated` | `executive-summaries/core.ts` | summary |
| `summary.finalized` | `executive-summaries/core.ts` | summary |
| `task.requested` | `agents/messages.ts`, `issue/automation.ts`, `issue/agent-autostart.ts`, `orchestrator.ts`, `langgraph-runner.ts` | taskId, agentId, source, taskType, prompt, priority, dedupeKey, auditComment? |
| `controller.trigger_requested` | `issue/automation.ts` | triggerIssueNumber?, priority, reason, actorId? |

### 新增事件

1. 在 `src/events/events.ts` 中定义新的 `XxxEvent` 接口，继承 `DomainEvent<'xxx', PayloadType>`
2. 将其加入 `HaicoDomainEvent` 联合类型和 `HaicoEventMap` 映射
3. 在发布者代码中 `eventBus.publish('xxx', { type: 'xxx', projectId, payload, meta })`
4. 在 `src/events/subscribers/` 中创建或扩展 subscriber 来处理新事件
5. 如果是新 subscriber 文件，在 `subscribers/index.ts` 的 `registerAllSubscribers` 中注册

## 中间件

中间件在事件到达订阅者之前执行，按注册顺序组成洋葱模型。当前中间件：

| 中间件 | 作用 |
|--------|------|
| `correlationMiddleware` | 如果事件缺少 `correlationId` 则自动生成 |
| `loggingMiddleware` | 记录每个事件的 `debug` 级别日志 |
| `persistenceMiddleware` | 将事件写入 `domain_events` 表 |

### 自定义中间件

```typescript
const myMiddleware: EventMiddleware = (event, next) => {
  // 在订阅者处理之前执行
  console.log('before:', event.type);
  next();  // 继续传递给下一个中间件或订阅者
  // 在订阅者处理之后执行（如果需要后置逻辑）
};

eventBus.use(myMiddleware);
```

## Coalescing（事件合并）

某些操作（如 Controller 编排）很昂贵，不应在短时间内重复触发。`events/coalescing.ts` 提供了通用的 coalesce 包装器：

```typescript
const handler = coalesce({
  windowMs: 3000,        // 默认合并窗口
  windowFn: (mergedEvent) => determineUrgency(mergedEvent) === 'urgent' ? 3000 : 60000,  // 动态窗口
  keyFn: (e) => `controller:${e.projectId}`,  // 按 projectId 分组合并
  minIntervalMs: 300000, // 硬下限：两次实际执行间隔至少 5 分钟
  mergeFn: (existing, incoming) => incomingUrgent && !existingUrgent ? incoming : existing,   // 合并策略
}, (event) => {
  // 实际处理逻辑，在窗口结束后执行
  triggerControllerAgent(project, false, triggerIssueNumber);
});
```

### 优先级感知窗口

Controller subscriber 使用 `windowFn` 根据合并后事件的优先级动态选择窗口：
- **urgent**（用户/系统操作）：3 秒窗口
- **normal**（Agent 事件）：60 秒窗口
- 硬下限始终 5 分钟（`minIntervalMs: 300000`）

这替代了原来 `controller.ts` 中的 `CoalescedTrigger` Map 和 `enqueueControllerTrigger` 内部队列。所有 Controller 触发路径（issue 事件、task completion、`triggerControllerOnDemand`）统一经由 EventBus `controller.trigger_requested` + 单一 coalesce 实例。

## 事件日志（Event Log）

所有事件通过 `persistenceMiddleware` 写入 `domain_events` 表：

```sql
SELECT * FROM domain_events
WHERE project_id = ? AND type = 'issue.created'
ORDER BY published_at DESC LIMIT 50;
```

## task.requested 模式

`task.requested` 事件使用**预生成 UUID**模式：调用方在发布事件前生成 `taskId = uuidv4()`， subscriber 使用该 ID 创建 Task。

```
调用方（生产者）                           Subscriber（消费者）
messages.ts                              task-creation-subscriber.ts
  taskId = uuidv4()                        createAgentTaskWithId(taskId, agentId, input)
  eventBus.publish('task.requested', {
    payload: { taskId, agentId, ... }       → dedupe_key 命中时返回已有 Task
  })                                        → auditComment 存在时写入 issue_comments
```

**为什么用预生成 UUID 而不是同步返回值？**

`createAgentTask` 原本返回 `Task` 对象，但所有调用方只使用 `task.id` 做日志/溯源记录，不用于流程控制。预生成 UUID 让调用方无需等待返回值即可知道 taskId，同时保持了 EventBus 的 fire-and-forget 语义。

**dedupe_key 行为**：当 `dedupe_key` 命中已有 pending/running task 时，`createAgentTaskWithId` 返回已有 Task（其 ID 与预生成的不同）。调用方记录的 taskId 可能与实际 Task ID 不一致——这是可接受的，因为 dedupe 意味着任务已存在，溯源记录指向的 ID 只是意图记录而非精确关联。

**auditComment**：`task.requested` 的可选字段。仅 `issue/automation.ts` 的 `parseMentionsAndStartAgents` 使用，用于在 Task 创建后向 `issue_comments` 表写入事件记录。其他调用方不需要审计评论。

**保留直接调用的路径**：`createManualAgentTask`（用户手动启动 Agent）仍直接调用 `createAgentTask`，不走 EventBus。这是同步请求-响应路径，调用方需要 Task 的完整返回值。

## 删除事件模式

`agent.deleted`、`project.deleted`、`issue.deleted` 遵循统一模式：**发布者在完成自身核心删除后发布事件，subscriber 负责清理关联数据。**

```
deleteAgent()
  → 停止活跃 task（同步前置条件）
  → DB DELETE agents WHERE id = ?
  → eventBus.publish('agent.deleted', { agentId, agentName, hadActiveTask })
  → [agent-deletion-subscriber]
      → UPDATE issues SET assigned_to = NULL WHERE assigned_to = agentId
      → DELETE FROM agent_knowledge WHERE agent_id = agentId
      → DELETE FROM executor_sessions WHERE agent_id = agentId
```

关键约束：
- **前置条件在发布前完成**：停止 task、删除主记录等核心操作在事件发布前同步完成，确保即使 subscriber 失败，主实体已不存在
- **subscriber 只做清理**：subscriber 处理的是"孤儿数据"——那些引用已删除实体的关联记录
- **事件不携带完整数据**：只传 ID 和必要元信息（如 `hadActiveTask`），subscriber 自行查询需要的上下文

### 调试

- **按项目查事件流**：查询 `domain_events` 表，按 `published_at` 排序
- **按 correlationId 追踪因果链**：搜索 `correlation_id` 找到从同一个用户操作触发的所有事件
- **causationId**：标记事件之间的因果关系（A 事件导致了 B 事件）
- **source**：标记事件的发布来源（如 `issue/core`、`tasks/completion`）

### 日志清理

使用 `purgeOldEvents(maxAgeDays)` 清理过期事件记录。可以在 scheduler 中定期调用：

```typescript
import { purgeOldEvents } from '../../events/store';
purgeOldEvents(30);  // 删除 30 天前的事件
```

## 防止循环依赖

### 规则 1：核心模块不依赖 services

`events/bus.ts`、`events/types.ts`、`events/events.ts`、`events/middleware.ts`、`events/coalescing.ts` → 禁止 import `src/services/` 中的任何模块。

`events/store.ts` 可以依赖 `src/db/database.ts`。

### 规则 2：Subscriber 是唯一的 U 型反转点

Subscriber 文件同时 import `events/` 和 `services/`，是唯一允许打破依赖方向的层。

### 规则 3：不要让事件触发回自身

```
❌ issue.updated → agent-subscriber → updateIssue() → issue.updated → 无限循环
✅ issue.updated → agent-subscriber → createAgentTask() → task.completed → controller-subscriber
```

在 subscriber 中检查 `actor` 字段防止自我触发：

```typescript
// 防止 agent 操作触发的更新再次启动该 agent
if (event.payload.actor === event.payload.assignedTo) return;
```

### 规则 4：Subscriber 之间不应有执行顺序依赖

所有 subscriber 在同一轮 event loop 中同步执行。如果需要延迟执行，使用 coalescing。

## 测试

### 测试事件发布

```typescript
import { eventBus } from '../../events';

// 监听事件
const received: DomainEvent[] = [];
const unsub = eventBus.subscribe('issue.created', (e) => received.push(e));

createIssue(db, projectId, input);

assert(received.length === 1);
assert(received[0].payload.issueNumber === 1);

unsub();  // 清理
```

### 测试 subscriber 逻辑

Subscriber 是普通函数，可以直接调用测试，不需要通过 EventBus：

```typescript
// 直接测试 handler 函数
const handler = (event) => { /* ... */ };
handler(mockEvent);
```

### Mock EventBus

```typescript
// 替换全局 eventBus 为 mock
import { eventBus } from '../../events';
const originalPublish = eventBus.publish.bind(eventBus);
eventBus.publish = (type, event) => { /* no-op */ };

// ... 运行测试 ...

eventBus.publish = originalPublish;
```
