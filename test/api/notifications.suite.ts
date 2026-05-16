import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface NotificationSuiteState {
  readonly projectId: string;
  readonly workerId: string;
}

export function registerNotificationSuites(
  ctx: ApiTestContext,
  state: NotificationSuiteState
): void {
  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before notification suite runs"
    );
    return state.projectId;
  }

  function getWorkerId(): string {
    assert.ok(
      state.workerId,
      "workerId should be initialized before notification suite runs"
    );
    return state.workerId;
  }

  describe("Notifications", () => {
    it("GET /api/notifications returns user issues and recent comments", async () => {
      const { status, body } = await ctx.api("/api/notifications");
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.user_issues));
      assert.ok(Array.isArray(body.recent_comments));
    });

    it("GET /api/notifications returns preview-sized issue and comment bodies", async () => {
      const longIssueBody = "issue-preview-".repeat(30);
      const longCommentBody = "comment-preview-".repeat(30);
      const { body: issue } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "Notification Preview Issue",
            body: longIssueBody,
            created_by: "user",
            assigned_to: "user",
          },
        }
      );
      await ctx.api(`/api/issues/${issue.id}/comments`, {
        method: "POST",
        body: { author_id: getWorkerId(), body: longCommentBody },
      });

      const { body } = await ctx.api("/api/notifications");
      const found = body.user_issues.find((i: any) => i.id === issue.id);
      assert.ok(found, "preview test issue should appear in notifications");
      assert.ok(
        found.body.length <= 150,
        "issue body should be truncated to notification preview length"
      );
      assert.ok(
        found.latest_comment_body.length <= 150,
        "latest comment body should be truncated to notification preview length"
      );

      const recent = body.recent_comments.find(
        (comment: any) => comment.issue_id === issue.id
      );
      assert.ok(
        recent,
        "preview test comment should appear in recent comments"
      );
      assert.ok(
        recent.body.length <= 150,
        "recent comment body should be truncated to notification preview length"
      );
    });

    it("GET /api/notifications includes issues only commented on by user in default scope", async () => {
      const { body: issue } = await ctx.api(
        `/api/projects/${getProjectId()}/issues`,
        {
          method: "POST",
          body: {
            title: "Notification Comment-Only Issue",
            body: "comment-only body",
            created_by: getWorkerId(),
            assigned_to: getWorkerId(),
          },
        }
      );

      await ctx.api(`/api/issues/${issue.id}/comments`, {
        method: "POST",
        body: { author_id: "user", body: "user is involved by comment only" },
      });

      const { body } = await ctx.api("/api/notifications");
      const found = body.user_issues.find((i: any) => i.id === issue.id);
      assert.ok(
        found,
        "comment-only user issue should appear in notifications"
      );
      assert.equal(
        found.is_actionable,
        0,
        "comment-only user issue should not become actionable unless assigned to user"
      );
    });

    it("GET /api/notifications supports since_updated_at incremental refresh", async () => {
      const baseline = await ctx.api("/api/notifications?limit=20");
      assert.equal(baseline.status, 200);
      const cursor = (baseline.body.user_issues || []).reduce(
        (max: string, issue: any) => {
          return issue.updated_at && issue.updated_at > max
            ? issue.updated_at
            : max;
        },
        "1970-01-01 00:00:00"
      );

      const created = await ctx.api(`/api/projects/${getProjectId()}/issues`, {
        method: "POST",
        body: {
          title: "Notification Incremental Issue",
          body: "incremental body",
          created_by: "user",
          assigned_to: "user",
        },
      });
      assert.equal(created.status, 201);

      const { status, body } = await ctx.api(
        `/api/notifications?since_updated_at=${encodeURIComponent(
          cursor
        )}&limit=20`
      );
      assert.equal(status, 200);
      assert.equal(body.pagination.incremental, true);
      assert.ok(
        body.user_issues.some((issue: any) => issue.id === created.body.id),
        "incremental notifications should include newly updated issue"
      );
    });

    it("GET /api/issues/:id/comments supports since_created_at with reactions", async () => {
      const created = await ctx.api(`/api/projects/${getProjectId()}/issues`, {
        method: "POST",
        body: {
          title: "Comment Incremental Issue",
          body: "comment incremental body",
          created_by: "user",
          assigned_to: "user",
        },
      });
      assert.equal(created.status, 201);

      const first = await ctx.api(`/api/issues/${created.body.id}/comments`, {
        method: "POST",
        body: { author_id: "user", body: "first incremental comment" },
      });
      assert.equal(first.status, 201);
      const second = await ctx.api(`/api/issues/${created.body.id}/comments`, {
        method: "POST",
        body: { author_id: getWorkerId(), body: "second incremental comment" },
      });
      assert.equal(second.status, 201);

      const { status, body } = await ctx.api(
        `/api/issues/${
          created.body.id
        }/comments?since_created_at=${encodeURIComponent(
          first.body.created_at
        )}`
      );
      assert.equal(status, 200);
      assert.ok(
        body.some((comment: any) => comment.id === second.body.id),
        "incremental comments should include later comments"
      );
      assert.ok(
        body.every((comment: any) => Array.isArray(comment.reactions)),
        "comments endpoint should attach reaction arrays"
      );
    });

    describe("pending status visibility (#380)", () => {
      let pendingProjectId: string;
      let pendingIssueId: string;
      let pendingAckedIssueId: string;
      let closedIssueId: string;

      before(async () => {
        const { body: proj } = await ctx.api("/api/projects", {
          method: "POST",
          body: {
            name: "notif-pending-test",
            description: "Notif pending test",
            task_description: "Test pending status in notifications",
          },
        });
        pendingProjectId = proj.id;

        const createIssue = async (title: string) => {
          const { body } = await ctx.api(
            `/api/projects/${pendingProjectId}/issues`,
            {
              method: "POST",
              body: {
                title,
                body: "test",
                created_by: "user",
                assigned_to: "user",
              },
            }
          );
          return body.id as string;
        };

        pendingIssueId = await createIssue("Notif Pending Issue");
        pendingAckedIssueId = await createIssue("Notif Pending Acked Issue");
        closedIssueId = await createIssue("Notif Closed Issue");

        await ctx.api(`/api/issues/${pendingIssueId}`, {
          method: "PUT",
          body: { status: "pending", actor: "user" },
        });
        await ctx.api(`/api/issues/${pendingAckedIssueId}`, {
          method: "PUT",
          body: { status: "pending", actor: "user" },
        });
        await ctx.api(`/api/issues/${pendingAckedIssueId}/acknowledge`, {
          method: "POST",
          body: {},
        });
        await ctx.api(`/api/issues/${closedIssueId}`, {
          method: "PUT",
          body: { status: "closed", actor: "user" },
        });
      });

      it("pending issues assigned to user appear in notifications", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find(
          (i: any) => i.id === pendingIssueId
        );
        assert.ok(found, "pending user issue should appear in notifications");
      });

      it("acknowledged pending issues still appear in notifications (grey state)", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find(
          (i: any) => i.id === pendingAckedIssueId
        );
        assert.ok(
          found,
          "acknowledged pending issue should still appear in notifications"
        );
        assert.ok(
          found.acknowledged_at,
          "acknowledged pending issue should have acknowledged_at set"
        );
      });

      it("closed issues do NOT appear in notifications", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find((i: any) => i.id === closedIssueId);
        assert.ok(!found, "closed issue should NOT appear in notifications");
      });
    });

    describe("acknowledged issue persists in notifications after controller takeover (#382)", () => {
      let ackProjectId: string;
      let ackedThenReassignedId: string;
      let ackedThenReassignedToUserId: string;

      before(async () => {
        const { body: proj } = await ctx.api("/api/projects", {
          method: "POST",
          body: {
            name: "ack-takeover-test",
            description: "Ack takeover test",
            task_description: "Test ack preservation on reassignment",
          },
        });
        ackProjectId = proj.id;

        // Issue 1: user acknowledges, then controller takes over
        const { body: i1 } = await ctx.api(
          `/api/projects/${ackProjectId}/issues`,
          {
            method: "POST",
            body: {
              title: "Acked Then Controller Takeover",
              body: "test",
              created_by: "user",
              assigned_to: "user",
            },
          }
        );
        ackedThenReassignedId = i1.id;

        // Issue 2: user acknowledges, then reassigned back to user
        const { body: i2 } = await ctx.api(
          `/api/projects/${ackProjectId}/issues`,
          {
            method: "POST",
            body: {
              title: "Acked Then Back To User",
              body: "test",
              created_by: "user",
              assigned_to: "user",
            },
          }
        );
        ackedThenReassignedToUserId = i2.id;

        // Acknowledge issue 1, then reassign to controller (agent)
        await ctx.api(`/api/issues/${ackedThenReassignedId}/acknowledge`, {
          method: "POST",
          body: {},
        });
        await ctx.api(`/api/issues/${ackedThenReassignedId}`, {
          method: "PUT",
          body: { assigned_to: "some-agent-id", actor: "system" },
        });

        // Acknowledge issue 2, then reassign to controller, then reassign back to user
        await ctx.api(
          `/api/issues/${ackedThenReassignedToUserId}/acknowledge`,
          { method: "POST", body: {} }
        );
        await ctx.api(`/api/issues/${ackedThenReassignedToUserId}`, {
          method: "PUT",
          body: { assigned_to: "some-agent-id", actor: "system" },
        });
        await ctx.api(`/api/issues/${ackedThenReassignedToUserId}`, {
          method: "PUT",
          body: { assigned_to: "user", actor: "system" },
        });
      });

      it("acknowledged issue still appears in notifications after controller takeover", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find(
          (i: any) => i.id === ackedThenReassignedId
        );
        assert.ok(
          found,
          "acknowledged issue reassigned to controller should still appear in notifications"
        );
      });

      it("acknowledged_at is preserved when issue reassigned away from user (not reset to null)", async () => {
        const { body } = await ctx.api(`/api/issues/${ackedThenReassignedId}`);
        assert.ok(
          body.acknowledged_at,
          "acknowledged_at should be preserved when issue reassigned to controller"
        );
      });

      it("acknowledged issue reassigned back to user resets acknowledged_at", async () => {
        const { body } = await ctx.api(
          `/api/issues/${ackedThenReassignedToUserId}`
        );
        assert.equal(
          body.acknowledged_at,
          null,
          "acknowledged_at should be reset when issue reassigned back to user"
        );
      });

      it("acknowledged issue appears as not actionRequired (grey state)", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find(
          (i: any) => i.id === ackedThenReassignedId
        );
        assert.ok(found, "issue should be in notifications");
        assert.ok(
          found.acknowledged_at,
          "acknowledged_at should be set, indicating grey/non-action-required state"
        );
      });
    });

    describe("done status visibility (#312)", () => {
      let notifProjectId: string;
      let openIssueId: string;
      let inProgressIssueId: string;
      let doneIssueId: string;
      let doneAckedIssueId: string;

      before(async () => {
        const { body: proj } = await ctx.api("/api/projects", {
          method: "POST",
          body: {
            name: "notif-done-test",
            description: "Notif done test",
            task_description: "Test done status in notifications",
          },
        });
        notifProjectId = proj.id;

        const createIssue = async (title: string) => {
          const { body } = await ctx.api(
            `/api/projects/${notifProjectId}/issues`,
            {
              method: "POST",
              body: {
                title,
                body: "test",
                created_by: "user",
                assigned_to: "user",
              },
            }
          );
          return body.id as string;
        };

        openIssueId = await createIssue("Notif Open Issue");
        inProgressIssueId = await createIssue("Notif InProgress Issue");
        doneIssueId = await createIssue("Notif Done Issue");
        doneAckedIssueId = await createIssue("Notif Done Acked Issue");

        await ctx.api(`/api/issues/${inProgressIssueId}`, {
          method: "PUT",
          body: { status: "in_progress", actor: "user" },
        });
        await ctx.api(`/api/issues/${doneIssueId}`, {
          method: "PUT",
          body: { status: "done", actor: "user" },
        });
        await ctx.api(`/api/issues/${doneAckedIssueId}`, {
          method: "PUT",
          body: { status: "done", actor: "user" },
        });
        await ctx.api(`/api/issues/${doneAckedIssueId}/acknowledge`, {
          method: "POST",
          body: {},
        });
      });

      it("open issues assigned to user appear in notifications", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find((i: any) => i.id === openIssueId);
        assert.ok(found, "open user issue should appear in notifications");
      });

      it("in_progress issues assigned to user appear in notifications", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find(
          (i: any) => i.id === inProgressIssueId
        );
        assert.ok(
          found,
          "in_progress user issue should appear in notifications"
        );
      });

      it("done issues assigned to user (unacknowledged) appear in notifications", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find((i: any) => i.id === doneIssueId);
        assert.ok(
          found,
          "done user issue with acknowledged_at=null should appear in notifications"
        );
      });

      it("done issues that are acknowledged still appear in notifications (as acknowledged)", async () => {
        const { body } = await ctx.api("/api/notifications");
        const found = body.user_issues.find(
          (i: any) => i.id === doneAckedIssueId
        );
        assert.ok(
          found,
          "done user issue with acknowledged_at set should still appear in notifications (grey state)"
        );
        assert.ok(
          found.acknowledged_at,
          "acknowledged issue should have acknowledged_at set"
        );
      });

      it("acknowledged issues are ordered after unacknowledged issues", async () => {
        const { body } = await ctx.api("/api/notifications");
        const issues = body.user_issues as any[];
        const ackedIndex = issues.findIndex(
          (i: any) => i.id === doneAckedIssueId
        );
        const unackedIndices = [openIssueId, inProgressIssueId, doneIssueId]
          .map((id) => issues.findIndex((i: any) => i.id === id))
          .filter((idx) => idx !== -1);
        assert.ok(ackedIndex !== -1, "acknowledged issue should be in list");
        assert.ok(
          unackedIndices.every((idx) => idx < ackedIndex),
          "unacknowledged issues should come before acknowledged"
        );
      });
    });
  });

  // ─── Search ───
}
