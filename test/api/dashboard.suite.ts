import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface DashboardSuiteState {
  readonly sessionToken: string;
  readonly projectId: string;
  readonly controllerId: string;
}

export function registerDashboardSuites(
  ctx: ApiTestContext,
  state: DashboardSuiteState
): void {
  function getSessionToken(): string {
    assert.ok(
      state.sessionToken,
      "sessionToken should be initialized before dashboard suite runs"
    );
    return state.sessionToken;
  }

  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before dashboard suite runs"
    );
    return state.projectId;
  }

  function getControllerId(): string {
    assert.ok(
      state.controllerId,
      "controllerId should be initialized before dashboard suite runs"
    );
    return state.controllerId;
  }

  describe("Dashboard Summary", () => {
    it("GET /api/dashboard/summary returns aggregate stats (with auth)", async () => {
      const { status, body } = await ctx.api("/api/dashboard/summary", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.ok(typeof body.agents === "object");
      assert.equal(typeof body.agents.total, "number");
      assert.equal(typeof body.agents.running, "number");
      assert.equal(typeof body.agents.error_count, "number");
      assert.ok(typeof body.issues === "object");
      assert.equal(typeof body.issues.total, "number");
      assert.equal(typeof body.issues.open, "number");
      assert.equal(typeof body.total_cost_usd, "number");
      assert.ok(typeof body.last_activity === "object");
    });

    it("GET /api/dashboard/summary requires auth (not localhost-safe)", async () => {
      const res = await ctx.inject({
        url: "/api/dashboard/summary",
        headers: { cookie: "" },
      });
      assert.equal(
        res.statusCode,
        401,
        "Dashboard API should require authentication"
      );
    });

    it("GET /api/dashboard/usage-by-project returns data (with auth)", async () => {
      const { status, body } = await ctx.api(
        "/api/dashboard/usage-by-project?period=day",
        {
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.ok(
        typeof body === "object" && body !== null,
        "usage-by-project should return an object"
      );
      assert.ok(
        Array.isArray(body.time_buckets),
        "should have time_buckets array"
      );
      assert.ok(Array.isArray(body.projects), "should have projects array");
      assert.ok(typeof body.data === "object", "should have data object");
      assert.equal(body.period, "day");
    });

    it("GET /api/dashboard/usage-by-project requires auth", async () => {
      const res = await ctx.inject({
        url: "/api/dashboard/usage-by-project",
        headers: { cookie: "" },
      });
      assert.equal(res.statusCode, 401);
    });

    // ── Activity Stream (#618) ──

    it("GET /api/dashboard/activity-stream returns event list (with auth)", async () => {
      const { status, body } = await ctx.api("/api/dashboard/activity-stream", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body), "activity-stream should return an array");
      for (const evt of body) {
        assert.ok(evt.event_type, "each event should have event_type");
        assert.ok(evt.time, "each event should have time");
      }
    });

    it("GET /api/dashboard/activity-stream supports project_id filter", async () => {
      const { status, body } = await ctx.api(
        `/api/dashboard/activity-stream?project_id=${getProjectId()}`,
        {
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      for (const evt of body) {
        assert.equal(
          evt.project_id,
          getProjectId(),
          "filtered events should belong to the requested project"
        );
      }
    });

    it("GET /api/dashboard/activity-stream supports limit parameter", async () => {
      const { status, body } = await ctx.api(
        "/api/dashboard/activity-stream?limit=2",
        {
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.length <= 2, "should respect limit parameter");
    });

    it("GET /api/dashboard/activity-stream requires auth", async () => {
      const res = await ctx.inject({
        url: "/api/dashboard/activity-stream",
        headers: { cookie: "" },
      });
      assert.equal(res.statusCode, 401);
    });

    it("activity-stream includes approval events with agent_name (#627)", async () => {
      // Create an approval request via the API
      const { status: createStatus, body: approval } = await ctx.api(
        `/api/projects/${getProjectId()}/approvals`,
        {
          method: "POST",
          body: {
            agent_id: getControllerId(),
            title: "Test approval for activity stream",
            description: "Verify agent_name appears in activity stream",
            risk_level: "high",
          },
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(createStatus, 201, "approval should be created");

      // Fetch activity stream and verify no 500 error
      const { status, body } = await ctx.api("/api/dashboard/activity-stream", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200, "activity-stream should not return 500");
      assert.ok(Array.isArray(body));

      // Find the approval event
      const approvalEvt = body.find(
        (e: any) =>
          e.event_type === "approval_created" && e.object_id === approval.id
      );
      assert.ok(
        approvalEvt,
        "activity stream should include the approval event"
      );
      assert.ok(
        approvalEvt.agent_name,
        "approval event should have agent_name from joined agents table"
      );
    });

    // ── Agent Board (#618) ──

    it("GET /api/dashboard/agents returns agent list (with auth)", async () => {
      const { status, body } = await ctx.api("/api/dashboard/agents", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body), "agents should return an array");
      for (const agent of body) {
        assert.ok(agent.id, "each agent should have id");
        assert.ok(agent.name, "each agent should have name");
        assert.ok(
          typeof agent.status === "string",
          "each agent should have status"
        );
        assert.ok(agent.project_id, "each agent should have project_id");
        assert.ok(agent.project_name, "each agent should have project_name");
      }
    });

    it("GET /api/dashboard/agents supports status filter", async () => {
      const { status, body } = await ctx.api(
        "/api/dashboard/agents?status=idle",
        {
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      for (const agent of body) {
        assert.equal(
          agent.status,
          "idle",
          "filtered agents should have the requested status"
        );
      }
    });

    it("GET /api/dashboard/agents requires auth", async () => {
      const res = await ctx.inject({
        url: "/api/dashboard/agents",
        headers: { cookie: "" },
      });
      assert.equal(res.statusCode, 401);
    });

    // ── Today Cost (#618) ──

    it("GET /api/dashboard/today-cost returns cost data (with auth)", async () => {
      const { status, body } = await ctx.api("/api/dashboard/today-cost", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.equal(
        typeof body.today_cost_usd,
        "number",
        "should have today_cost_usd"
      );
      assert.ok(
        typeof body.by_project === "object",
        "should have by_project object"
      );
    });

    it("GET /api/dashboard/today-cost requires auth", async () => {
      const res = await ctx.inject({
        url: "/api/dashboard/today-cost",
        headers: { cookie: "" },
      });
      assert.equal(res.statusCode, 401);
    });

    // ── Usage-by-project period variants (#618) ──

    it("GET /api/dashboard/usage-by-project supports hour period", async () => {
      const { status, body } = await ctx.api(
        "/api/dashboard/usage-by-project?period=hour",
        {
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.period, "hour");
      assert.ok(Array.isArray(body.time_buckets));
    });

    it("GET /api/dashboard/usage-by-project supports week period", async () => {
      const { status, body } = await ctx.api(
        "/api/dashboard/usage-by-project?period=week",
        {
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.period, "week");
      assert.ok(Array.isArray(body.time_buckets));
    });

    it("GET /api/dashboard/usage-by-project supports month period", async () => {
      const { status, body } = await ctx.api(
        "/api/dashboard/usage-by-project?period=month",
        {
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.period, "month");
      assert.ok(Array.isArray(body.time_buckets));
    });
  });

  // ─── Git Integration ───
}
