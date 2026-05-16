import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface ApiRetrySuiteState {
  readonly projectId: string;
  readonly workerId: string;
}

export function registerApiRetrySuites(
  ctx: ApiTestContext,
  state: ApiRetrySuiteState
): void {
  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before API retry suite runs"
    );
    return state.projectId;
  }

  function getWorkerId(): string {
    assert.ok(
      state.workerId,
      "workerId should be initialized before API retry suite runs"
    );
    return state.workerId;
  }

  describe("API连接失败自动重启 (#436)", () => {
    // 等待agent进入非running/非waiting状态（最多等maxMs毫秒），返回最终状态
    async function waitForNonRunning(
      agentId: string,
      maxMs = 15000,
      alsoSkipWaiting = false
    ): Promise<string> {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        const { body: st } = await ctx.api(`/api/agents/${agentId}/status`);
        if (
          st.status !== "running" &&
          (!alsoSkipWaiting || st.status !== "waiting")
        )
          return st.status;
      }
      const { body: st } = await ctx.api(`/api/agents/${agentId}/status`);
      return st.status;
    }

    // 等待agent的in-memory进程退出（is_running变为false）
    async function waitForProcessExit(
      agentId: string,
      maxMs = 5000
    ): Promise<void> {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const { body: st } = await ctx.api(`/api/agents/${agentId}/status`);
        if (!st.is_running) return;
      }
    }

    it("API连接错误时自动重试，两次失败后进入error状态", async () => {
      // 确保agent不在运行中
      await waitForNonRunning(getWorkerId());

      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: {
          command_template: "sh -c 'echo Unable to connect to API >&2; exit 1'",
        },
      });

      try {
        const startRes = await ctx.api(`/api/agents/${getWorkerId()}/start`, {
          method: "POST",
          body: { prompt: "test api retry" },
        });
        assert.equal(
          startRes.status,
          200,
          `start应返回200，实际: ${startRes.status}`
        );

        // 等待第一次进程退出（is_running → false）
        await waitForProcessExit(getWorkerId(), 3000);

        // 若API错误被检测到，关闭处理器应进入'waiting'状态（5分钟重试等待中）
        const { body: midState } = await ctx.api(
          `/api/agents/${getWorkerId()}/status`
        );
        assert.equal(
          midState.status,
          "waiting",
          `第一次API错误后应为waiting（等待重试）。实际: ${midState.status}, pid: ${midState.pid}, is_running: ${midState.is_running}`
        );

        // 5分钟重试延迟太长，不等待完成。手动停止agent让状态恢复。
        await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
        await waitForNonRunning(getWorkerId(), 5000, true);
      } finally {
        await ctx.api(`/api/projects/${getProjectId()}`, {
          method: "PUT",
          body: { command_template: "echo" },
        });
        await waitForNonRunning(getWorkerId(), 12000, true);
      }
    });

    it("非API错误不触发自动重试，直接变为error", async () => {
      await waitForNonRunning(getWorkerId());

      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "false" },
      });

      try {
        const startRes = await ctx.api(`/api/agents/${getWorkerId()}/start`, {
          method: "POST",
          body: { prompt: "test non-api error no retry" },
        });
        assert.equal(
          startRes.status,
          200,
          `start应返回200，实际: ${startRes.status}`
        );

        // 非API错误应立即进入error（无重试延迟）
        const finalStatus = await waitForNonRunning(getWorkerId(), 5000);
        assert.equal(
          finalStatus,
          "error",
          `非API错误应直接进入error（无自动重试）。实际: ${finalStatus}`
        );
      } finally {
        await ctx.api(`/api/projects/${getProjectId()}`, {
          method: "PUT",
          body: { command_template: "echo" },
        });
        await waitForNonRunning(getWorkerId(), 5000);
      }
    });

    it("成功运行后agent变为idle状态", async () => {
      await waitForNonRunning(getWorkerId());

      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "echo" },
      });

      try {
        const startRes = await ctx.api(`/api/agents/${getWorkerId()}/start`, {
          method: "POST",
          body: { prompt: "test success" },
        });
        assert.equal(
          startRes.status,
          200,
          `start应返回200，实际: ${startRes.status}`
        );

        const finalStatus = await waitForNonRunning(getWorkerId(), 5000);
        assert.equal(
          finalStatus,
          "idle",
          `成功运行后agent应为idle。实际: ${finalStatus}`
        );
      } finally {
        await ctx.api(`/api/projects/${getProjectId()}`, {
          method: "PUT",
          body: { command_template: "echo" },
        });
        await waitForNonRunning(getWorkerId(), 5000);
      }
    });
  });
}
