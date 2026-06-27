# Orchestration
<!-- depends-on: AGENTS.md, adapters.md#Key Interfaces, event-bus.md#事件定义 -->
<!-- L1: Agent Hierarchy, Issue Automation -->
<!-- L2: Implementation Boundaries -->

HAICO is issue-driven: controller agents decompose work into issues, worker
agents execute assigned issues, and project state is coordinated through the
database plus project WebSocket events.

## Agent Hierarchy

- Project creation automatically provisions one Controller and one Assistant.
- Worker agents must attach to a Controller through `parent_agent_id`.
- Controller completion should trigger a follow-up check for additional
  dispatchable issues.
- Agent lifecycle transitions should preserve project membership and hierarchy
  invariants; do not manually reset stuck running agents because startup
  recovery handles that.

## Issue Automation

- `@mention` comments can auto-start the mentioned agent.
- When all child issues are complete, the parent issue's Controller should be
  triggered to summarize or advance the parent.
- When an agent marks work as done, the issue is assigned back to the user for
  review.
- Issue dispatch logic should keep WebSocket events in `snake_case` and include
  `projectId` in project broadcasts.

## Implementation Boundaries

- Controller and orchestration entry points live in `src/services/controller.ts`,
  `src/services/orchestrator.ts`, and `src/services/langgraph-runner.ts`.
- Issue dispatch and automation live under `src/services/issue/`.
- Task scheduling/runtime behavior lives under `src/services/tasks/` and
  `src/scheduler/`.
- Agent type dispatch and CLI execution live in `src/services/adapters/`
  (see `architecture/adapters.md`). Each tool type is an adapter;
  the registry resolves type strings to adapter instances.
- Process policy, watchdog CPU checks, and exit classification live under
  `src/services/process-manager/`.