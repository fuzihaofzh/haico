import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface IssueSuiteState {
  readonly projectId: string;
  readonly workerId: string;
}

export function registerIssueSuites(
  ctx: ApiTestContext,
  state: IssueSuiteState
): void {
  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before issue suite runs"
    );
    return state.projectId;
  }

  function getWorkerId(): string {
    assert.ok(
      state.workerId,
      "workerId should be initialized before issue suite runs"
    );
    return state.workerId;
  }

  let issueId: string;

  describe("Issues", () => {
    it("POST creates issue with auto-priority", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "Test issue",
            body: "Description",
            created_by: "user",
            assigned_to: getWorkerId(),
            labels: "bug,test",
          },
        }
      );
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.number, 1);
      assert.equal(body.status, "open");
      assert.equal(body.priority, 10); // user = highest
      issueId = body.id;
    });

    it("GET lists issues", async () => {
      const { body } = await ctx.api(`/api/projects/${getProjectId()}/issues`);
      assert.ok(body.issues.length >= 1);
      assert.ok(body.total >= 1);
    });

    it("GET filters by status", async () => {
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues?status=open`
      );
      assert.ok(body.issues.some((i: any) => i.id === issueId));
    });

    it("GET filters by assigned_to", async () => {
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues?assigned_to=${getWorkerId()}`
      );
      assert.ok(body.issues.some((i: any) => i.id === issueId));
    });

    it("GET issue detail includes comments", async () => {
      const { body } = await ctx.api(`/api/issues/${issueId}`);
      assert.equal(body.title, "Test issue");
      assert.ok(Array.isArray(body.comments));
    });

    it("PUT updates issue status", async () => {
      const { status, body } = await ctx.api(`/api/issues/${issueId}`, {
        method: "PUT",
        body: { status: "in_progress" },
      });
      assert.equal(status, 200);
      assert.equal(body.status, "in_progress");
    });

    it("POST adds comment", async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${issueId}/comments`,
        {
          method: "POST",
          body: { author_id: "user", body: "A comment" },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.body, "A comment");
    });

    it("GET comments lists them", async () => {
      const { body } = await ctx.api(`/api/issues/${issueId}/comments`);
      assert.ok(body.length >= 1);
    });

    it("DELETE only works on open issues", async () => {
      // Issue is in_progress, should fail
      const { status } = await ctx.api(`/api/issues/${issueId}`, {
        method: "DELETE",
      });
      assert.equal(status, 409);
    });

    it("POST requires title and created_by", async () => {
      const { status } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: { body: "no title" },
        }
      );
      assert.equal(status, 400);
    });
  });

  // ─── Issue by Number ───

  describe("Issue by Number", () => {
    it("GET /api/projects/:pid/issues/number/:num returns issue with comments", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues/number/1`
      );
      assert.equal(status, 200);
      assert.equal(body.number, 1);
      assert.ok(Array.isArray(body.comments));
      assert.ok(Array.isArray(body.reactions));
    });

    it("GET nonexistent issue number returns 404", async () => {
      const { status } = await ctx.api(
        `/api/projects/${getProjectId()}/issues/number/9999`
      );
      assert.equal(status, 404);
    });
  });

  // ─── Issue Timeline Events ───

  describe("Issue Timeline Events", () => {
    it("status change creates timeline event", async () => {
      // Issue was changed to in_progress earlier, check for event comment
      const { body } = await ctx.api(`/api/issues/${issueId}`);
      const statusEvents = body.comments.filter(
        (c: any) => c.event_type === "status_change"
      );
      assert.ok(
        statusEvents.length >= 1,
        "Should have at least one status_change event"
      );
    });

    it("invalid status returns 400", async () => {
      const { status } = await ctx.api(`/api/issues/${issueId}`, {
        method: "PUT",
        body: { status: "invalid_status" },
      });
      assert.equal(status, 400);
    });

    it("nonexistent issue returns 404 on update", async () => {
      const { status } = await ctx.api("/api/issues/nonexistent", {
        method: "PUT",
        body: { status: "open" },
      });
      assert.equal(status, 404);
    });

    it("nonexistent issue returns 404 on get", async () => {
      const { status } = await ctx.api("/api/issues/nonexistent");
      assert.equal(status, 404);
    });
  });

  // ─── Comments CRUD ───

  let commentId: string;

  describe("Comments CRUD", () => {
    it("POST comment requires author_id and body", async () => {
      const { status } = await ctx.api(`/api/issues/${issueId}/comments`, {
        method: "POST",
        body: { author_id: "user" }, // missing body
      });
      assert.equal(status, 400);
    });

    it("POST comment on nonexistent issue returns 404", async () => {
      const { status } = await ctx.api("/api/issues/nonexistent/comments", {
        method: "POST",
        body: { author_id: "user", body: "test" },
      });
      assert.equal(status, 404);
    });

    it("POST creates a comment and captures id", async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${issueId}/comments`,
        {
          method: "POST",
          body: { author_id: "user", body: "Editable comment" },
        }
      );
      assert.equal(status, 201);
      commentId = body.id;
    });

    it("PUT /api/comments/:id edits comment", async () => {
      const { status, body } = await ctx.api(`/api/comments/${commentId}`, {
        method: "PUT",
        body: { body: "Edited comment" },
      });
      assert.equal(status, 200);
      assert.equal(body.body, "Edited comment");
    });

    it("PUT nonexistent comment returns 404", async () => {
      const { status } = await ctx.api("/api/comments/nonexistent", {
        method: "PUT",
        body: { body: "test" },
      });
      assert.equal(status, 404);
    });

    it("DELETE /api/comments/:id removes comment", async () => {
      const { status, body } = await ctx.api(`/api/comments/${commentId}`, {
        method: "DELETE",
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
    });

    it("DELETE nonexistent comment returns 404", async () => {
      const { status } = await ctx.api("/api/comments/nonexistent", {
        method: "DELETE",
      });
      assert.equal(status, 404);
    });
  });

  // ─── Reactions ───

  describe("Reactions", () => {
    it("POST /api/reactions/issue/:id toggles on", async () => {
      const { status, body } = await ctx.api(
        `/api/reactions/issue/${issueId}`,
        {
          method: "POST",
          body: { user_id: "user", emoji: "👍" },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.toggled, "on");
    });

    it("POST same reaction toggles off", async () => {
      const { status, body } = await ctx.api(
        `/api/reactions/issue/${issueId}`,
        {
          method: "POST",
          body: { user_id: "user", emoji: "👍" },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.toggled, "off");
    });

    it("POST reaction requires user_id and emoji", async () => {
      const { status } = await ctx.api(`/api/reactions/issue/${issueId}`, {
        method: "POST",
        body: { user_id: "user" }, // missing emoji
      });
      assert.equal(status, 400);
    });

    it("GET /api/reactions/issue/:id lists reactions", async () => {
      // Add a reaction first
      await ctx.api(`/api/reactions/issue/${issueId}`, {
        method: "POST",
        body: { user_id: "user", emoji: "🎉" },
      });
      const { status, body } = await ctx.api(`/api/reactions/issue/${issueId}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.some((r: any) => r.emoji === "🎉"));
    });
  });

  // ─── Milestones ───

  let milestoneId: string;

  describe("Milestones", () => {
    it("POST /api/projects/:pid/milestones creates milestone", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/milestones`,
        {
          method: "POST",
          body: {
            title: "v1.0",
            description: "First release",
            due_date: "2026-06-01",
          },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.title, "v1.0");
      milestoneId = body.id;
    });

    it("POST milestone requires title", async () => {
      const { status } = await ctx.api(
        `/api/projects/${getProjectId()}/milestones`,
        {
          method: "POST",
          body: { description: "no title" },
        }
      );
      assert.equal(status, 400);
    });

    it("GET /api/projects/:pid/milestones lists milestones with progress", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/milestones`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.length >= 1);
      assert.equal(body[0].progress, 0); // no issues assigned yet
    });

    it("PUT /api/milestones/:id updates milestone", async () => {
      const { status, body } = await ctx.api(`/api/milestones/${milestoneId}`, {
        method: "PUT",
        body: { title: "v1.1", description: "Updated release" },
      });
      assert.equal(status, 200);
      assert.equal(body.title, "v1.1");
    });

    it("assign issue to milestone and check progress", async () => {
      // Assign the existing issue to milestone
      await ctx.api(`/api/issues/${issueId}`, {
        method: "PUT",
        body: { milestone_id: milestoneId },
      });
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/milestones`
      );
      const ms = body.find((m: any) => m.id === milestoneId);
      assert.equal(ms.total_issues, 1);
    });

    it("DELETE /api/milestones/:id removes milestone and unlinks issues", async () => {
      const { status, body } = await ctx.api(`/api/milestones/${milestoneId}`, {
        method: "DELETE",
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Verify issue's milestone_id is cleared
      const { body: issue } = await ctx.api(`/api/issues/${issueId}`);
      assert.equal(issue.milestone_id, null);
    });
  });

  describe("Search", () => {
    it("GET /api/projects/:pid/search finds issues by query", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/search?q=Test`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.issues));
      assert.ok(body.issues.length >= 1);
    });

    it("search returns empty for no match", async () => {
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/search?q=zzz_nonexistent_zzz`
      );
      assert.equal(body.issues.length, 0);
    });
  });

  // ─── Activity ───

  describe("Activity", () => {
    it("GET /api/projects/:id/activity returns timeline", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/activity`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.length > 0, "Should have activity events");
    });
  });

  // ─── Costs ───

  describe("Costs", () => {
    it("GET /api/projects/:id/costs returns cost summary", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/costs`
      );
      assert.equal(status, 200);
      assert.equal(typeof body.total_cost_usd, "number");
      assert.equal(typeof body.total_input_tokens, "number");
      assert.equal(typeof body.total_output_tokens, "number");
      assert.ok(typeof body.by_agent === "object");
    });
  });

  // ─── Agent Extended Endpoints ───

  describe("Agent Extended", () => {
    it("GET /api/agents/:id/system-prompt returns prompt", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/system-prompt`
      );
      assert.equal(status, 200);
      assert.ok(typeof body.prompt === "string");
      assert.ok(body.prompt.length > 0);
    });

    it("GET system-prompt for nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/system-prompt");
      assert.equal(status, 404);
    });

    it("GET /api/agents/:id/terminal returns text output", async () => {
      const res = await ctx.inject({
        url: `/api/agents/${getWorkerId()}/terminal`,
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers["content-type"]?.toString().includes("text/plain"));
      assert.ok(res.body.includes("worker-1"));
    });

    it("GET terminal for nonexistent agent returns 404", async () => {
      const res = await ctx.inject({
        url: "/api/agents/nonexistent/terminal",
      });
      assert.equal(res.statusCode, 404);
    });

    it("GET /api/agents/:id/logs/:run_id returns logs for specific run", async () => {
      // Get a run_id from existing logs
      const { body: logs } = await ctx.api(`/api/agents/${getWorkerId()}/logs`);
      if (logs.length > 0) {
        const runId = logs[0].run_id;
        const { status, body } = await ctx.api(
          `/api/agents/${getWorkerId()}/logs/${runId}`
        );
        assert.equal(status, 200);
        assert.ok(Array.isArray(body));
      }
    });

    it("GET status for nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/status");
      assert.equal(status, 404);
    });

    it("stop nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/stop", {
        method: "POST",
      });
      assert.equal(status, 404);
    });

    it("start nonexistent agent returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/start", {
        method: "POST",
        body: { prompt: "test" },
      });
      assert.equal(status, 404);
    });
  });

  // ─── Issue Delete (open issue) ───

  describe("Issue Delete", () => {
    let openIssueId: string;

    it("create and delete an open issue", async () => {
      const { body: created } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: { title: "Deletable issue", created_by: "user" },
        }
      );
      openIssueId = created.id;

      const { status } = await ctx.api(`/api/issues/${openIssueId}`, {
        method: "DELETE",
      });
      assert.equal(status, 200);
    });

    it("delete nonexistent issue returns 404", async () => {
      const { status } = await ctx.api("/api/issues/nonexistent", {
        method: "DELETE",
      });
      assert.equal(status, 404);
    });
  });

  // ─── Issues Pagination ───

  describe("Issues Pagination", () => {
    it("pagination params work", async () => {
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues?page=1&per_page=1`
      );
      assert.equal(body.per_page, 1);
      assert.ok(body.issues.length <= 1);
      assert.ok(body.total >= 1);
      assert.ok(body.total_pages >= 1);
    });

    it("sort by newest works", async () => {
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues?sort=newest`
      );
      assert.ok(body.issues.length >= 1);
    });

    it("search by q parameter works", async () => {
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues?q=Test`
      );
      assert.ok(body.issues.length >= 1);
    });
  });

  // ─── Issue Comment Count ───

  describe("Issue Comment Count", () => {
    let ccIssueId: string;

    it("issues list includes comment_count field", async () => {
      const { body } = await ctx.api(`/api/projects/${getProjectId()}/issues`);
      assert.ok(body.issues.length >= 1);
      for (const issue of body.issues) {
        assert.equal(
          typeof issue.comment_count,
          "number",
          `issue ${issue.id} should have numeric comment_count`
        );
      }
    });

    it("comment_count only counts event_type=comment (not status_change)", async () => {
      // issueId already has 1 real comment ("A comment") + status_change events from earlier tests
      const { body } = await ctx.api(`/api/projects/${getProjectId()}/issues`);
      const issue = body.issues.find((i: any) => i.id === issueId);
      assert.ok(issue, "should find test issue");
      // There was 1 real comment added earlier and status_change events should not count
      assert.equal(
        issue.comment_count,
        1,
        "comment_count should only count real comments, not status_change events"
      );
    });

    it("new issue has comment_count 0", async () => {
      const { body } = await ctx.api(`/api/projects/${getProjectId()}/issues`, {
        method: "POST",
        body: { title: "No comments issue", body: "Test", created_by: "user" },
      });
      ccIssueId = body.id;
      // Fetch list and check
      const { body: listBody } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`
      );
      const issue = listBody.issues.find((i: any) => i.id === ccIssueId);
      assert.ok(issue);
      assert.equal(issue.comment_count, 0);
    });

    it("comment_count increments after adding a comment", async () => {
      await ctx.api(`/api/issues/${ccIssueId}/comments`, {
        method: "POST",
        body: { author_id: "user", body: "First comment" },
      });
      await ctx.api(`/api/issues/${ccIssueId}/comments`, {
        method: "POST",
        body: { author_id: "user", body: "Second comment" },
      });
      const { body } = await ctx.api(`/api/projects/${getProjectId()}/issues`);
      const issue = body.issues.find((i: any) => i.id === ccIssueId);
      assert.equal(issue.comment_count, 2);
    });

    it("status change does not increment comment_count", async () => {
      // Change status (creates a status_change event, not a comment)
      await ctx.api(`/api/issues/${ccIssueId}`, {
        method: "PUT",
        body: { status: "in_progress" },
      });
      const { body } = await ctx.api(`/api/projects/${getProjectId()}/issues`);
      const issue = body.issues.find((i: any) => i.id === ccIssueId);
      assert.equal(
        issue.comment_count,
        2,
        "status_change should not affect comment_count"
      );
    });

    it("sort by comments works", async () => {
      const { body } = await ctx.api(
        `/api/projects/${getProjectId()}/issues?sort=comments`
      );
      assert.ok(body.issues.length >= 2);
      // First issue should have >= comments as second
      const counts = body.issues.map((i: any) => i.comment_count);
      for (let i = 1; i < counts.length; i++) {
        assert.ok(
          counts[i - 1] >= counts[i],
          `issues should be sorted by comment count descending`
        );
      }
    });
  });

  // ─── Agent Costs ───

  describe("Agent Costs", () => {
    it("GET /api/agents/:id/costs returns cost structure", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/costs`
      );
      assert.equal(status, 200);
      assert.equal(typeof body.total_cost_usd, "number");
      assert.equal(typeof body.total_input_tokens, "number");
      assert.equal(typeof body.total_output_tokens, "number");
      assert.equal(typeof body.total_runs, "number");
      assert.ok(Array.isArray(body.runs));
    });

    it("GET /api/agents/:id/costs returns 404 for nonexistent agent", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/costs");
      assert.equal(status, 404);
    });

    it("agent with no cost records returns total_runs 0", async () => {
      // Create a fresh agent that has never been started
      const { body: freshAgent } = await ctx.api(
        `/api/projects/${getProjectId()}/agents`,
        {
          method: "POST",
          body: { name: "no-cost-agent", role: "Test" },
        }
      );
      const { status, body } = await ctx.api(
        `/api/agents/${freshAgent.id}/costs`
      );
      assert.equal(status, 200);
      assert.equal(body.total_runs, 0);
      assert.equal(body.total_cost_usd, 0);
      assert.equal(body.runs.length, 0);

      await ctx.api(`/api/agents/${freshAgent.id}`, { method: "DELETE" });
    });
  });
}
