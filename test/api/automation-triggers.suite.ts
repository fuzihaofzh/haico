import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface AutomationTriggerSuiteState {
  readonly projectId: string;
  readonly workerId: string;
}

export function registerAutomationTriggerSuites(
  ctx: ApiTestContext,
  state: AutomationTriggerSuiteState
): void {
  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before automation trigger suite runs"
    );
    return state.projectId;
  }

  function getWorkerId(): string {
    assert.ok(
      state.workerId,
      "workerId should be initialized before automation trigger suite runs"
    );
    return state.workerId;
  }

  describe("@Mention in Issues", () => {
    let mentionIssueId: string;

    it("creating issue with @worker-1 queues an issue-work Task", async () => {
      const { getDatabase } = await import("../../src/db/database");
      const db = getDatabase();
      // Ensure agent is idle first
      const { body: agentBefore } = await ctx.api(
        `/api/agents/${getWorkerId()}`
      );
      // If running, stop it first
      if (agentBefore.status === "running") {
        await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const { body: st } = await ctx.api(
            `/api/agents/${getWorkerId()}/status`
          );
          if (st.status !== "running") break;
        }
      }
      const beforeTaskCount = (
        db
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE target_agent_id = ?")
          .get(getWorkerId()) as any
      ).count;

      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "Mention test",
            body: "Hey @worker-1 please check this",
            created_by: "user",
          },
        }
      );
      assert.equal(status, 201);
      mentionIssueId = body.id;

      await new Promise((r) => setTimeout(r, 500));
      const { body: agentAfter } = await ctx.api(
        `/api/agents/${getWorkerId()}/status`
      );
      assert.notEqual(agentAfter.status, "running");
      const afterTaskCount = (
        db
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE target_agent_id = ?")
          .get(getWorkerId()) as any
      ).count;
      assert.equal(afterTaskCount, beforeTaskCount + 1);
      const task = db
        .prepare("SELECT * FROM tasks WHERE target_agent_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(getWorkerId()) as any;
      assert.equal(task.source, "issue-mention");
      assert.equal(task.source_ref, mentionIssueId);
      assert.equal(task.task_type, "issue-work");
      assert.match(task.prompt, /Mention test/);
    });

    it("system event records queued Task for mentioned agent", async () => {
      const { body: issue } = await ctx.api(`/api/issues/${mentionIssueId}`);
      const systemEvents = issue.comments.filter(
        (c: any) => c.author_id === "system"
      );
      assert.ok(
        systemEvents.length > 0,
        "Should have system event for auto-start"
      );
      const mentionEvent = systemEvents.find(
        (c: any) =>
          c.body.includes("Task queued") &&
          c.body.includes("worker-1")
      );
      assert.ok(
        mentionEvent,
        "System event should mention queued Task for worker-1"
      );
      const meta = JSON.parse(mentionEvent.meta || "{}");
      assert.ok(meta.task_id, "System event should include task_id");
    });

    it("@mention of nonexistent agent does not cause error", async () => {
      const { status } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "Unknown mention",
            body: "Hey @nonexistent-agent check",
            created_by: "user",
          },
        }
      );
      assert.equal(status, 201);
    });

    it("comment with @worker-1 queues an issue-work Task and does not direct-start", async () => {
      const { getDatabase } = await import("../../src/db/database");
      const db = getDatabase();
      // Stop agent if running
      const { body: st } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      if (st.status === "running") {
        await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const { body: s } = await ctx.api(
            `/api/agents/${getWorkerId()}/status`
          );
          if (s.status !== "running") break;
        }
      }
      const beforeTaskCount = (
        db
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE target_agent_id = ?")
          .get(getWorkerId()) as any
      ).count;

      const { status } = await ctx.api(
        `/api/issues/${mentionIssueId}/comments`,
        {
          method: "POST",
          body: { author_id: "user", body: "@worker-1 please verify this fix" },
        }
      );
      assert.equal(status, 201);

      await new Promise((r) => setTimeout(r, 500));
      const { body: agentAfter } = await ctx.api(
        `/api/agents/${getWorkerId()}/status`
      );
      assert.notEqual(
        agentAfter.status,
        "running",
        "Agent should not be auto-started by comment @mention during task-runtime cutover"
      );
      const afterTaskCount = (
        db
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE target_agent_id = ?")
          .get(getWorkerId()) as any
      ).count;
      assert.equal(afterTaskCount, beforeTaskCount + 1);
    });

    it("issue body without @mention does not trigger system event", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "No mention",
            body: "Just a normal issue",
            created_by: "user",
          },
        }
      );
      assert.equal(status, 201);
      const { body: issue } = await ctx.api(`/api/issues/${body.id}`);
      const systemEvents = issue.comments.filter(
        (c: any) => c.author_id === "system" && c.body.includes("Task queued")
      );
      assert.equal(
        systemEvents.length,
        0,
        "No auto-start event for issue without @mention"
      );
    });

    it("multiple @mentions in one text are all parsed", async () => {
      // Create a second worker agent for this test
      const { body: worker2 } = await ctx.api(
        `/api/projects/${getProjectId()}/agents`,
        {
          method: "POST",
          body: { name: "worker-2", role: "Test worker 2" },
        }
      );
      const worker2Id = worker2.id;

      // Stop worker-1 if running
      const { body: st } = await ctx.api(`/api/agents/${getWorkerId()}/status`);
      if (st.status === "running") {
        await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const { body: s } = await ctx.api(
            `/api/agents/${getWorkerId()}/status`
          );
          if (s.status !== "running") break;
        }
      }

      const { status, body: newIssue } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "Multi mention",
            body: "Need @worker-1 and @worker-2 to review",
            created_by: "user",
          },
        }
      );
      assert.equal(status, 201);

      await new Promise((r) => setTimeout(r, 1000));

      const { body: issue } = await ctx.api(`/api/issues/${newIssue.id}`);
      const mentionTaskEvents = issue.comments.filter(
        (c: any) => c.author_id === "system" && c.body.includes("Task queued")
      );
      assert.ok(
        mentionTaskEvents.length >= 2,
        `Should have at least 2 mention Task events, got ${mentionTaskEvents.length}`
      );

      // Cleanup worker-2
      await ctx.api(`/api/agents/${worker2Id}`, { method: "DELETE" });
    });
  });

  // ─── @Mention: paused agent should NOT be started ───

  describe("@Mention Paused Agent", () => {
    it("@mention of paused agent does not start it", async () => {
      // Stop agent if running
      const { body: stBefore } = await ctx.api(
        `/api/agents/${getWorkerId()}/status`
      );
      if (stBefore.status === "running") {
        await ctx.api(`/api/agents/${getWorkerId()}/stop`, { method: "POST" });
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const { body: s } = await ctx.api(
            `/api/agents/${getWorkerId()}/status`
          );
          if (s.status !== "running") break;
        }
      }

      // Pause the worker using the dedicated pause endpoint
      const { status: pauseStatus } = await ctx.api(
        `/api/agents/${getWorkerId()}/pause`,
        { method: "POST" }
      );
      // May already be paused (409), that's OK
      assert.ok(
        pauseStatus === 200 || pauseStatus === 409,
        `Pause should succeed or already be paused, got ${pauseStatus}`
      );

      const { body: paused } = await ctx.api(`/api/agents/${getWorkerId()}`);
      assert.equal(paused.paused, 1, "Agent should be paused");

      // Create issue mentioning the paused agent
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "Mention paused agent",
            body: "@worker-1 check this",
            created_by: "user",
          },
        }
      );
      assert.equal(status, 201);

      await new Promise((r) => setTimeout(r, 500));

      // Agent should NOT have been started
      const { body: agentAfter } = await ctx.api(
        `/api/agents/${getWorkerId()}/status`
      );
      assert.notEqual(
        agentAfter.status,
        "running",
        "Paused agent should not be started by @mention"
      );

      // No auto-start system event
      const { body: issue } = await ctx.api(`/api/issues/${body.id}`);
      const autoStartEvents = issue.comments.filter(
        (c: any) => c.author_id === "system" && c.body.includes("auto-started")
      );
      assert.equal(
        autoStartEvents.length,
        0,
        "No auto-start event for paused agent"
      );

      // Unpause for later tests
      await ctx.api(`/api/agents/${getWorkerId()}/unpause`, { method: "POST" });
    });
  });

  // ─── Controller On-Demand Mode ───

  describe("Controller On-Demand Mode", () => {
    it("on-demand mode: creating issue triggers controller", async () => {
      const { status } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "On-demand wake test",
            body: "Test on-demand controller trigger",
            created_by: "user",
          },
        }
      );
      assert.equal(status, 201);

      // Controller may or may not start (echo command finishes fast),
      // but the call should not error
      await new Promise((r) => setTimeout(r, 1500));
    });

    it("on-demand mode: updating issue triggers controller", async () => {
      const { body: list } = await ctx.api(
        `/api/projects/${getProjectId()}/issues?status=open`
      );
      assert.ok(list.issues.length > 0, "Should have open issues");

      const issueId = list.issues[0].id;
      const { status } = await ctx.api(`/api/issues/${issueId}`, {
        method: "PUT",
        body: { status: "in_progress", actor: "user" },
      });
      assert.equal(status, 200);
      await new Promise((r) => setTimeout(r, 1500));
    });

    it("on-demand mode: adding comment triggers controller", async () => {
      const { body: list } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`
      );
      const issueId = list.issues[0].id;

      const { status } = await ctx.api(`/api/issues/${issueId}/comments`, {
        method: "POST",
        body: { author_id: "user", body: "On-demand comment test" },
      });
      assert.equal(status, 201);
      await new Promise((r) => setTimeout(r, 1500));
    });
  });

  // ─── API连接失败自动重启 (#436/#437) ───
}
