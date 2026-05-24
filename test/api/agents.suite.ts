import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface AgentSuiteState {
  readonly projectId: string;
  workerId: string;
}

export function registerAgentSuites(
  ctx: ApiTestContext,
  state: AgentSuiteState
): void {
  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before agent suite runs"
    );
    return state.projectId;
  }

  function getWorkerId(): string {
    assert.ok(
      state.workerId,
      "workerId should be initialized before this test runs"
    );
    return state.workerId;
  }

  function setWorkerId(value: string): void {
    state.workerId = value;
  }

  describe("Agents", () => {
    it("POST creates worker agent", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/agents`,
        {
          method: "POST",
          body: { name: "worker-1", role: "Test worker" },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.name, "worker-1");
      assert.equal(body.status, "idle");
      assert.equal(body.is_controller, 0);
      setWorkerId(body.id);
    });

    it("POST create requires name", async () => {
      const { status } = await ctx.api(
        `/api/projects/${getProjectId()}/agents`,
        {
          method: "POST",
          body: { role: "no name" },
        }
      );
      assert.equal(status, 400);
    });

    it("GET /api/agents/:id returns agent", async () => {
      const { status, body } = await ctx.api(`/api/agents/${getWorkerId()}`);
      assert.equal(status, 200);
      assert.equal(body.name, "worker-1");
    });

    it("GET /api/projects/:pid/agents returns lightweight agent rows", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/agents`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      const worker = body.find((agent: any) => agent.id === getWorkerId());
      assert.ok(worker, "worker should appear in project agent list");
      assert.ok(
        !("last_prompt" in worker),
        "list row should not include last_prompt"
      );
      assert.ok(
        !("session_id" in worker),
        "list row should not include session_id"
      );
      assert.ok(
        "has_last_prompt" in worker,
        "list row should include has_last_prompt flag"
      );
      assert.ok(worker.runtime_state, "list row should include runtime_state");
      assert.equal(worker.runtime_state.status, "idle");
    });

    it("PUT updates agent", async () => {
      const { status, body } = await ctx.api(`/api/agents/${getWorkerId()}`, {
        method: "PUT",
        body: { role: "Updated role" },
      });
      assert.equal(status, 200);
      assert.equal(body.role, "Updated role");
    });

    it("POST start requires an explicit prompt during task-runtime cutover", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/start`,
        {
          method: "POST",
          body: {},
        }
      );
      assert.equal(status, 400);
      assert.match(body.error, /prompt/i);
    });

    it("POST start launches process", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/start`,
        {
          method: "POST",
          body: { prompt: "Hello test!" },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.task_id);
      assert.ok(body.task_run_id);
      assert.ok(body.run_id);
      assert.ok(body.pid);
    });

    it("agent finishes and becomes idle", async () => {
      await new Promise((r) => setTimeout(r, 2000));
      const { body } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      assert.equal(body.status, "idle");
    });

    it("logs are captured", async () => {
      const { body } = await ctx.api(`/api/agents/${getWorkerId()}/logs`);
      assert.ok(Array.isArray(body));
      assert.ok(body.length > 0, "Should have at least one log entry");
    });

    it("logs support since_id cursor in ascending order", async () => {
      const { body: before } = await ctx.api(
        `/api/agents/${getWorkerId()}/logs?limit=1`
      );
      const sinceId = before.length ? before[0].id : 0;
      const { getDatabase } = await import("../../src/db/database");
      const db = getDatabase();
      const insertLog = db.prepare(
        "INSERT INTO conversation_logs (agent_id, run_id, content, stream, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      insertLog.run(
        getWorkerId(),
        "since-cursor-run",
        "cursor-log-1",
        "stdout",
        "2026-04-08 13:00:00"
      );
      insertLog.run(
        getWorkerId(),
        "since-cursor-run",
        "cursor-log-2",
        "stdout",
        "2026-04-08 13:00:01"
      );

      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/logs?since_id=${sinceId}&limit=10`
      );
      assert.equal(status, 200);
      const cursorLogs = body.filter(
        (entry: any) => entry.run_id === "since-cursor-run"
      );
      assert.equal(cursorLogs.length, 2);
      assert.deepEqual(
        cursorLogs.map((entry: any) => entry.content),
        ["cursor-log-1", "cursor-log-2"]
      );
    });

    it("start + stop works", async () => {
      // Pause project to prevent controller triggers during test
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { status: "paused", command_template: "tail -f /dev/null #" },
      });

      const { status: startStatus } = await ctx.api(
        `/api/agents/${getWorkerId()}/start`,
        {
          method: "POST",
          body: { prompt: "long" },
        }
      );
      assert.equal(startStatus, 200);
      await new Promise((r) => setTimeout(r, 500));

      const { status: stopStatus } = await ctx.api(
        `/api/agents/${getWorkerId()}/stop`,
        { method: "POST" }
      );
      assert.equal(stopStatus, 200);
      await new Promise((r) => setTimeout(r, 2000));

      const { body: st } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      assert.notEqual(st.status, "running");

      // Restore
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { status: "active", command_template: "echo" },
      });
    });

    it("error status on failed command", async () => {
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "false" },
      });
      await ctx.api(`/api/agents/${getWorkerId()}/start`, {
        method: "POST",
        body: { prompt: "fail" },
      });
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { body: st } = await ctx.api(
          `/api/agents/${getWorkerId()}/status`
        );
        if (st.status !== "running") break;
      }

      const { body } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      assert.equal(body.status, "error");

      // Restore
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "echo" },
      });
    });

    it("duplicate start returns 409", async () => {
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "tail -f /dev/null #" },
      });
      await ctx.api(`/api/agents/${getWorkerId()}/start`, {
        method: "POST",
        body: { prompt: "first" },
      });
      await new Promise((r) => setTimeout(r, 200));

      const { status } = await ctx.api(`/api/agents/${getWorkerId()}/start`, {
        method: "POST",
        body: { prompt: "second" },
      });
      assert.equal(status, 409);

      await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 2000));

      // Wait for agent to fully stop
      for (let i = 0; i < 5; i++) {
        const { body: st } = await ctx.api(
          `/api/agents/${getWorkerId()}/status`
        );
        if (st.status !== "running") break;
        await new Promise((r) => setTimeout(r, 500));
      }

      // Restore
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "echo" },
      });
    });

    it("GET nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent");
      assert.equal(status, 404);
    });
  });

  // ─── Agent Retry ───

  describe("Agent Retry", () => {
    it("retry nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/retry", {
        method: "POST",
      });
      assert.equal(status, 404);
    });

    it("retry existing agent without a retryable TaskRun returns 400", async () => {
      // Create a fresh agent that has never been started
      const { body: freshAgent } = await ctx.api(
        `/api/projects/${getProjectId()}/agents`,
        {
          method: "POST",
          body: { name: "retry-test-agent", role: "Retry test" },
        }
      );
      const { status, body } = await ctx.api(
        `/api/agents/${freshAgent.id}/retry`,
        { method: "POST" }
      );
      assert.equal(status, 400);
      assert.match(body.error, /No previous prompt to retry/);

      // Cleanup
      await ctx.api(`/api/agents/${freshAgent.id}`, { method: "DELETE" });
    });

    it("retry success creates a new TaskRun attempt", async () => {
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "sh -c \"cat >/dev/null; exit 7\"" },
      });
      const first = await ctx.api(`/api/agents/${getWorkerId()}/start`, {
        method: "POST",
        body: { prompt: "retry me" },
      });
      assert.equal(first.status, 200, first.raw);
      await new Promise((r) => setTimeout(r, 500));

      const retry = await ctx.api(`/api/agents/${getWorkerId()}/retry`, {
        method: "POST",
      });
      assert.equal(retry.status, 200, retry.raw);
      assert.equal(retry.body.task_id, first.body.task_id);

      const { getDatabase } = await import("../../src/db/database");
      const db = getDatabase();
      const attempts = db.prepare(
        "SELECT attempt FROM task_runs WHERE task_id = ? ORDER BY attempt"
      ).all(first.body.task_id) as Array<{ attempt: number }>;
      assert.deepEqual(attempts.map((row) => row.attempt), [1, 2]);

      await new Promise((r) => setTimeout(r, 500));
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "echo" },
      });
    });

    it("retry returns 409 when agent is running", async () => {
      // Start the agent with a long-running command
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "tail -f /dev/null #" },
      });
      await ctx.api(`/api/agents/${getWorkerId()}/start`, {
        method: "POST",
        body: { prompt: "retry test" },
      });
      await new Promise((r) => setTimeout(r, 300));

      const { status } = await ctx.api(`/api/agents/${getWorkerId()}/retry`, {
        method: "POST",
      });
      assert.equal(status, 409);

      // Stop and restore
      await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 2000));
      for (let i = 0; i < 5; i++) {
        const { body: st } = await ctx.api(
          `/api/agents/${getWorkerId()}/status`
        );
        if (st.status !== "running") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "echo" },
      });
    });
  });

  // ─── Agent Pause / Unpause ───

  describe("Agent Pause / Unpause", () => {
    it("pause nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/pause", {
        method: "POST",
      });
      assert.equal(status, 404);
    });

    it("unpause nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/unpause", {
        method: "POST",
      });
      assert.equal(status, 404);
    });

    it("pause idle agent succeeds", async () => {
      // Ensure agent is idle first
      const { body: st } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      if (st.status === "running") {
        await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
        await new Promise((r) => setTimeout(r, 2000));
      }

      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/pause`,
        {
          method: "POST",
        }
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Verify agent is paused and idle (stopped state removed)
      const { body: agent } = await ctx.api(`/api/agents/${getWorkerId()}`);
      assert.equal(agent.paused, 1);
      assert.equal(agent.status, "idle");
    });

    it("pause already paused agent returns 409", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/pause`,
        {
          method: "POST",
        }
      );
      assert.equal(status, 409);
      assert.ok(body.error.includes("already paused"));
    });

    it("start paused agent returns 409", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/start`,
        {
          method: "POST",
          body: { prompt: "should not start" },
        }
      );
      assert.equal(status, 409);
      assert.ok(body.error.includes("paused"));
    });

    it("retry paused agent returns 409", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/retry`,
        {
          method: "POST",
        }
      );
      assert.equal(status, 409);
      assert.match(body.error, /paused/i);
    });

    it("status endpoint shows paused=true", async () => {
      const { body } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      assert.equal(body.paused, true);
    });

    it("unpause agent succeeds", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/unpause`,
        { method: "POST" }
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Verify agent is unpaused and idle
      const { body: agent } = await ctx.api(`/api/agents/${getWorkerId()}`);
      assert.equal(agent.paused, 0);
      assert.equal(agent.status, "idle");
    });

    it("unpause already unpaused agent returns 409", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/unpause`,
        { method: "POST" }
      );
      assert.equal(status, 409);
      assert.ok(body.error.includes("not paused"));
    });

    it("status endpoint shows paused=false after unpause", async () => {
      const { body } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      assert.equal(body.paused, false);
    });

    it("agent can be started after unpause", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/start`,
        {
          method: "POST",
          body: { prompt: "after unpause" },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Wait for it to finish
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { body: st } = await ctx.api(
          `/api/agents/${getWorkerId()}/status`
        );
        if (st.status !== "running") break;
      }
    });

    it("pause stops a running agent", async () => {
      // Start with long-running command
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "tail -f /dev/null #" },
      });
      await ctx.api(`/api/agents/${getWorkerId()}/start`, {
        method: "POST",
        body: { prompt: "long running" },
      });
      await new Promise((r) => setTimeout(r, 500));

      // Pause while running
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/pause`,
        {
          method: "POST",
        }
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);

      await new Promise((r) => setTimeout(r, 2000));

      // Verify agent is paused and not running
      const { body: st } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      assert.equal(st.paused, true);
      assert.equal(st.is_running, false);

      // Unpause and restore
      await ctx.api(`/api/agents/${getWorkerId()}/unpause`, { method: "POST" });
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "echo" },
      });
    });
  });

  // ─── Error Recovery (Task runtime) ───

  describe("Error Recovery", () => {
    it("single process error is reflected through derived runtime state", async () => {
      // Run agent with a command that fails
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "false" },
      });
      await ctx.api(`/api/agents/${getWorkerId()}/start`, {
        method: "POST",
        body: { prompt: "should fail" },
      });

      // Wait for error
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { body: st } = await ctx.api(
          `/api/agents/${getWorkerId()}/status`
        );
        if (st.status !== "running") break;
      }

      const { body: agent } = await ctx.api(`/api/agents/${getWorkerId()}`);
      assert.equal(agent.status, "error");
      assert.equal(agent.runtime_state.status, "error");
      assert.ok(agent.runtime_state.last_task_run_id);

      // Restore
      await ctx.api(`/api/projects/${getProjectId()}`, {
        method: "PUT",
        body: { command_template: "echo" },
      });
    });
  });
}
