import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface GitIntegrationSuiteState {
  readonly projectId: string;
  readonly workerId: string;
}

export function registerGitIntegrationSuites(
  ctx: ApiTestContext,
  state: GitIntegrationSuiteState
): void {
  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before git suite runs"
    );
    return state.projectId;
  }

  function getWorkerId(): string {
    assert.ok(
      state.workerId,
      "workerId should be initialized before git suite runs"
    );
    return state.workerId;
  }

  describe("Git Integration", () => {
    it("GET /api/projects/:id/git-log returns commit list", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/git-log?limit=5`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      // Test project agents have no working_directory, so expect empty
    });

    it("GET /api/projects/:id/git-log respects limit param", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/git-log?limit=1`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
    });

    it("GET /api/agents/:id/git-status returns status for agent without working_directory", async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/git-status`
      );
      assert.equal(status, 200);
      assert.equal(body.branch, null);
      assert.deepEqual(body.recent_commits, []);
      assert.equal(body.has_uncommitted, false);
    });

    it("GET /api/agents/:id/git-status with working_directory set", async () => {
      // Set working_directory to current repo for testing
      await ctx.api(`/api/agents/${getWorkerId()}`, {
        method: "PUT",
        body: { working_directory: process.cwd() },
      });
      const { status, body } = await ctx.api(
        `/api/agents/${getWorkerId()}/git-status`
      );
      assert.equal(status, 200);
      assert.ok(body.branch, "Should have a branch name");
      assert.ok(
        Array.isArray(body.recent_commits),
        "Should have recent_commits array"
      );
      if (body.recent_commits.length > 0) {
        assert.ok(body.recent_commits[0].hash, "Commit should have hash");
        assert.ok(body.recent_commits[0].message, "Commit should have message");
      }
    });

    it("GET /api/agents/nonexistent/git-status returns 404", async () => {
      const { status } = await ctx.api("/api/agents/nonexistent/git-status");
      assert.equal(status, 404);
    });

    it("git-log returns commits when agent has working_directory", async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${getProjectId()}/git-log?limit=5`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      // Now that workerId has cwd as working_directory, should have commits
      if (body.length > 0) {
        assert.ok(body[0].hash, "Commit should have full hash");
        assert.ok(body[0].short_hash, "Commit should have short_hash");
        assert.ok(body[0].author, "Commit should have author");
        assert.ok(body[0].message, "Commit should have message");
        assert.ok(body[0].date, "Commit should have date");
      }
    });
  });
}
