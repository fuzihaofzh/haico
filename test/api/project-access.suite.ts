import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export function registerProjectAccessSuites(ctx: ApiTestContext): void {
  describe("Project permission summaries (#520)", () => {
    it("returns owner/member_count/permission fields for owner and shared member views", async () => {
      const suffix = Date.now();
      const ownerUsername = `owner-${suffix}`;
      const memberUsername = `member-${suffix}`;

      const ownerRegister = await ctx.api("/api/auth/register", {
        method: "POST",
        body: {
          username: ownerUsername,
          password: "pass1234",
          display_name: "Owner User",
        },
      });
      assert.equal(ownerRegister.status, 201);

      const memberRegister = await ctx.api("/api/auth/register", {
        method: "POST",
        body: {
          username: memberUsername,
          password: "pass1234",
          display_name: "Shared Member",
        },
      });
      assert.equal(memberRegister.status, 201);

      const ownerLogin = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: ownerUsername, password: "pass1234" },
      });
      assert.equal(ownerLogin.status, 200);
      const ownerToken = ownerLogin.body.token;

      const memberLogin = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: memberUsername, password: "pass1234" },
      });
      assert.equal(memberLogin.status, 200);
      const memberToken = memberLogin.body.token;

      const created = await ctx.api("/api/projects", {
        method: "POST",
        headers: { cookie: `haico-auth=${ownerToken}` },
        body: {
          name: `shared-project-${suffix}`,
          description: "permission summary test",
          task_description: "verify permission metadata",
          command_template: "echo",
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.permission_level, "owner");
      assert.equal(created.body.can_manage, true);
      assert.equal(created.body.owner.username, ownerUsername);
      assert.equal(created.body.member_count, 1);
      const sharedProjectId = created.body.id;

      const shareRes = await ctx.api(
        `/api/projects/${sharedProjectId}/members`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: { username: memberUsername },
        }
      );
      assert.equal(shareRes.status, 201);

      const ownerList = await ctx.api("/api/projects", {
        headers: { cookie: `haico-auth=${ownerToken}` },
      });
      assert.equal(ownerList.status, 200);
      const ownerProject = ownerList.body.find(
        (project: any) => project.id === sharedProjectId
      );
      assert.ok(ownerProject, "owner should see the shared project");
      assert.equal(ownerProject.permission_level, "owner");
      assert.equal(ownerProject.can_manage, true);
      assert.equal(ownerProject.owner.username, ownerUsername);
      assert.equal(ownerProject.member_count, 2);

      const memberList = await ctx.api("/api/projects", {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(memberList.status, 200);
      const memberProject = memberList.body.find(
        (project: any) => project.id === sharedProjectId
      );
      assert.ok(memberProject, "shared member should see the project");
      assert.equal(memberProject.permission_level, "member");
      assert.equal(memberProject.can_manage, false);
      assert.equal(memberProject.owner.username, ownerUsername);
      assert.equal(memberProject.member_count, 2);

      const memberDetail = await ctx.api(`/api/projects/${sharedProjectId}`, {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(memberDetail.status, 200);
      assert.equal(memberDetail.body.permission_level, "member");
      assert.equal(memberDetail.body.can_manage, false);
      assert.equal(memberDetail.body.owner.username, ownerUsername);
      assert.equal(memberDetail.body.member_count, 2);
    });

    it("rejects project deletion by editor with a clear 403", async () => {
      const suffix = Date.now();
      const ownerUsername = `delete-owner-${suffix}`;
      const editorUsername = `delete-editor-${suffix}`;

      await ctx.api("/api/auth/register", {
        method: "POST",
        body: {
          username: ownerUsername,
          password: "pass1234",
          display_name: "Delete Owner",
        },
      });
      await ctx.api("/api/auth/register", {
        method: "POST",
        body: {
          username: editorUsername,
          password: "pass1234",
          display_name: "Delete Editor",
        },
      });

      const ownerToken = (
        await ctx.api("/api/auth/login", {
          method: "POST",
          body: { username: ownerUsername, password: "pass1234" },
        })
      ).body.token;
      const editorToken = (
        await ctx.api("/api/auth/login", {
          method: "POST",
          body: { username: editorUsername, password: "pass1234" },
        })
      ).body.token;

      const created = await ctx.api("/api/projects", {
        method: "POST",
        headers: { cookie: `haico-auth=${ownerToken}` },
        body: {
          name: `delete-permission-${suffix}`,
          description: "delete permission test",
          task_description: "verify editor cannot delete project",
          command_template: "echo",
        },
      });
      assert.equal(created.status, 201);

      const shareRes = await ctx.api(
        `/api/projects/${created.body.id}/members`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: { username: editorUsername, role: "editor" },
        }
      );
      assert.equal(shareRes.status, 201);

      const editorDelete = await ctx.api(`/api/projects/${created.body.id}`, {
        method: "DELETE",
        headers: { cookie: `haico-auth=${editorToken}` },
      });
      assert.equal(editorDelete.status, 403);
      assert.match(editorDelete.body.error, /owners or admins/);

      const ownerDelete = await ctx.api(`/api/projects/${created.body.id}`, {
        method: "DELETE",
        headers: { cookie: `haico-auth=${ownerToken}` },
      });
      assert.equal(ownerDelete.status, 200);
    });
  });

  describe("统一项目权限边界 (#525/#530)", () => {
    let ownerToken: string;
    let memberToken: string;
    let outsiderToken: string;
    let sharedProjectId: string;
    let hiddenProjectId: string;
    let sharedAgentId: string;
    let hiddenAgentId: string;
    let sharedKnowledgeId: string;
    let sharedOwnedKnowledgeId: string;
    let sharedMessageId: string;
    let sharedSearchIssueId: string;
    let hiddenSearchIssueId: string;

    before(async () => {
      const suffix = Date.now();
      const ownerUsername = `perm-owner-${suffix}`;
      const memberUsername = `perm-member-${suffix}`;
      const outsiderUsername = `perm-outsider-${suffix}`;

      for (const username of [
        ownerUsername,
        memberUsername,
        outsiderUsername,
      ]) {
        const register = await ctx.api("/api/auth/register", {
          method: "POST",
          body: { username, password: "pass1234", display_name: username },
        });
        assert.equal(register.status, 201);
      }

      ownerToken = (
        await ctx.api("/api/auth/login", {
          method: "POST",
          body: { username: ownerUsername, password: "pass1234" },
        })
      ).body.token;
      memberToken = (
        await ctx.api("/api/auth/login", {
          method: "POST",
          body: { username: memberUsername, password: "pass1234" },
        })
      ).body.token;
      outsiderToken = (
        await ctx.api("/api/auth/login", {
          method: "POST",
          body: { username: outsiderUsername, password: "pass1234" },
        })
      ).body.token;

      const sharedProject = await ctx.api("/api/projects", {
        method: "POST",
        headers: { cookie: `haico-auth=${ownerToken}` },
        body: {
          name: `perm-shared-${suffix}`,
          description: "shared project",
          task_description: "shared permission boundary test",
          command_template: "echo",
        },
      });
      assert.equal(sharedProject.status, 201);
      sharedProjectId = sharedProject.body.id;

      const hiddenProject = await ctx.api("/api/projects", {
        method: "POST",
        headers: { cookie: `haico-auth=${ownerToken}` },
        body: {
          name: `perm-hidden-${suffix}`,
          description: "hidden project",
          task_description: "hidden permission boundary test",
          command_template: "echo",
        },
      });
      assert.equal(hiddenProject.status, 201);
      hiddenProjectId = hiddenProject.body.id;

      const shareRes = await ctx.api(
        `/api/projects/${sharedProjectId}/members`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: { username: memberUsername },
        }
      );
      assert.equal(shareRes.status, 201);

      const sharedAgent = await ctx.api(
        `/api/projects/${sharedProjectId}/agents`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: { name: "perm-shared-worker", role: "shared worker" },
        }
      );
      assert.equal(sharedAgent.status, 201);
      sharedAgentId = sharedAgent.body.id;

      const hiddenAgent = await ctx.api(
        `/api/projects/${hiddenProjectId}/agents`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: { name: "perm-hidden-worker", role: "hidden worker" },
        }
      );
      assert.equal(hiddenAgent.status, 201);
      hiddenAgentId = hiddenAgent.body.id;

      const knowledgeRes = await ctx.api(
        `/api/projects/${sharedProjectId}/knowledge`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: {
            title: "Boundary knowledge",
            content: "visible to shared member",
            importance: "high",
          },
        }
      );
      assert.equal(knowledgeRes.status, 201);
      sharedKnowledgeId = knowledgeRes.body.id;

      const ownedKnowledgeRes = await ctx.api(
        `/api/agents/${sharedAgentId}/knowledge-memory`,
        {
          headers: { cookie: `haico-auth=${ownerToken}` },
        }
      );
      assert.equal(ownedKnowledgeRes.status, 200);
      sharedOwnedKnowledgeId = ownedKnowledgeRes.body.id;

      const messageRes = await ctx.api(
        `/api/agents/${sharedAgentId}/messages/send`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: {
            to: sharedAgentId,
            subject: "Boundary ping",
            body: "read-only member can see this inbox",
          },
        }
      );
      assert.equal(messageRes.status, 201);
      sharedMessageId = messageRes.body.id;

      const sharedIssue = await ctx.api(
        `/api/projects/${sharedProjectId}/issues`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: {
            title: "Boundary shared issue",
            body: "boundary-visible-token",
            created_by: "user",
            assigned_to: "user",
          },
        }
      );
      assert.equal(sharedIssue.status, 201);
      sharedSearchIssueId = sharedIssue.body.id;

      const hiddenIssue = await ctx.api(
        `/api/projects/${hiddenProjectId}/issues`,
        {
          method: "POST",
          headers: { cookie: `haico-auth=${ownerToken}` },
          body: {
            title: "Boundary hidden issue",
            body: "boundary-visible-token",
            created_by: "user",
            assigned_to: "user",
          },
        }
      );
      assert.equal(hiddenIssue.status, 201);
      hiddenSearchIssueId = hiddenIssue.body.id;
    });

    it("shared member can read shared project resources but cannot perform write actions", async () => {
      const sharedAgent = await ctx.api(`/api/agents/${sharedAgentId}`, {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(sharedAgent.status, 200);

      const sharedKnowledge = await ctx.api(
        `/api/knowledge/${sharedKnowledgeId}`,
        {
          headers: { cookie: `haico-auth=${memberToken}` },
        }
      );
      assert.equal(sharedKnowledge.status, 200);

      const sharedOwnedKnowledge = await ctx.api(
        `/api/agents/${sharedAgentId}/knowledge-memory`,
        {
          headers: { cookie: `haico-auth=${memberToken}` },
        }
      );
      assert.equal(sharedOwnedKnowledge.status, 200);
      assert.equal(sharedOwnedKnowledge.body.id, sharedOwnedKnowledgeId);

      const sharedInbox = await ctx.api(
        `/api/agents/${sharedAgentId}/messages`,
        {
          headers: { cookie: `haico-auth=${memberToken}` },
        }
      );
      assert.equal(sharedInbox.status, 200);
      assert.ok(
        sharedInbox.body.messages.some(
          (message: any) => message.id === sharedMessageId
        )
      );

      const markRead = await ctx.api(
        `/api/agents/${sharedAgentId}/messages/${sharedMessageId}`,
        {
          method: "PUT",
          headers: { cookie: `haico-auth=${memberToken}` },
        }
      );
      assert.equal(markRead.status, 403);

      const updateKnowledge = await ctx.api(
        `/api/knowledge/${sharedKnowledgeId}`,
        {
          method: "PUT",
          headers: { cookie: `haico-auth=${memberToken}` },
          body: { title: "member cannot edit" },
        }
      );
      assert.equal(updateKnowledge.status, 403);

      const updateOwnedKnowledge = await ctx.api(
        `/api/agents/${sharedAgentId}/knowledge-memory`,
        {
          method: "PUT",
          headers: { cookie: `haico-auth=${memberToken}` },
          body: { content: "member cannot edit owned knowledge" },
        }
      );
      assert.equal(updateOwnedKnowledge.status, 403);
    });

    it("non-member cannot access shared project resources by project id or direct entity id", async () => {
      const projectDetail = await ctx.api(`/api/projects/${sharedProjectId}`, {
        headers: { cookie: `haico-auth=${outsiderToken}` },
      });
      assert.equal(projectDetail.status, 403);

      const agentDetail = await ctx.api(`/api/agents/${sharedAgentId}`, {
        headers: { cookie: `haico-auth=${outsiderToken}` },
      });
      assert.equal(agentDetail.status, 403);

      const knowledgeDetail = await ctx.api(
        `/api/knowledge/${sharedKnowledgeId}`,
        {
          headers: { cookie: `haico-auth=${outsiderToken}` },
        }
      );
      assert.equal(knowledgeDetail.status, 403);

      const ownedKnowledge = await ctx.api(
        `/api/agents/${sharedAgentId}/knowledge-memory`,
        {
          headers: { cookie: `haico-auth=${outsiderToken}` },
        }
      );
      assert.equal(ownedKnowledge.status, 403);

      const ownedKnowledgeDetail = await ctx.api(
        `/api/knowledge/${sharedOwnedKnowledgeId}`,
        {
          headers: { cookie: `haico-auth=${outsiderToken}` },
        }
      );
      assert.equal(ownedKnowledgeDetail.status, 403);

      const inbox = await ctx.api(`/api/agents/${sharedAgentId}/messages`, {
        headers: { cookie: `haico-auth=${outsiderToken}` },
      });
      assert.equal(inbox.status, 403);
    });

    it("dashboard, notifications, my-issues and inbox search only include accessible projects", async () => {
      const dashboard = await ctx.api("/api/dashboard/summary", {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(dashboard.status, 200);
      assert.ok(
        sharedProjectId in dashboard.body.last_activity,
        "shared project should remain visible"
      );
      assert.ok(
        !(hiddenProjectId in dashboard.body.last_activity),
        "hidden project should be filtered out"
      );

      const search = await ctx.api(
        "/api/inbox/search?q=boundary-visible-token",
        {
          headers: { cookie: `haico-auth=${memberToken}` },
        }
      );
      assert.equal(search.status, 200);
      assert.ok(
        search.body.some((issue: any) => issue.id === sharedSearchIssueId)
      );
      assert.ok(
        !search.body.some((issue: any) => issue.id === hiddenSearchIssueId)
      );

      const notifications = await ctx.api("/api/notifications", {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(notifications.status, 200);
      assert.ok(
        notifications.body.user_issues.some(
          (issue: any) => issue.id === sharedSearchIssueId
        )
      );
      assert.ok(
        !notifications.body.user_issues.some(
          (issue: any) => issue.id === hiddenSearchIssueId
        )
      );

      const myIssues = await ctx.api("/api/my-issues", {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(myIssues.status, 200);
      assert.ok(
        myIssues.body.some((issue: any) => issue.id === sharedSearchIssueId)
      );
      assert.ok(
        !myIssues.body.some((issue: any) => issue.id === hiddenSearchIssueId)
      );
    });

    it("direct agent resources from hidden projects stay filtered for shared members", async () => {
      const hiddenAgent = await ctx.api(`/api/agents/${hiddenAgentId}`, {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(hiddenAgent.status, 403);
    });
  });

  // ─── Agents ───

  let workerId: string;
}
