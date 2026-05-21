import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { ApiTestContext } from "./helpers";

export interface ProjectSuiteState {
  projectId: string;
  controllerId: string;
}

export function registerProjectSuites(
  ctx: ApiTestContext,
  state: ProjectSuiteState
): void {
  function getProjectId(): string {
    assert.ok(
      state.projectId,
      "projectId should be initialized before this project test runs"
    );
    return state.projectId;
  }

  function setProjectId(value: string): void {
    state.projectId = value;
  }

  function setControllerId(value: string): void {
    state.controllerId = value;
  }

  describe("Projects", () => {
    it("POST /api/command-profiles/check reports missing CLI clearly", async () => {
      const { status, body } = await ctx.api("/api/command-profiles/check", {
        method: "POST",
        body: {
          command: "haico-cli-that-does-not-exist",
          type: "codex",
        },
      });
      assert.equal(status, 200);
      assert.equal(body.binary_found, false);
      assert.equal(body.ready, false);
      assert.ok(Array.isArray(body.issues));
      assert.equal(body.issues[0].code, "missing_cli");
    });

    it("POST /api/generate-project classifies missing CLI as setup error", async () => {
      const { status, body } = await ctx.api("/api/generate-project", {
        method: "POST",
        body: {
          description: "Create a test project",
          tool_path: "haico-cli-that-does-not-exist",
          command_type: "codex",
        },
      });
      assert.equal(status, 400);
      assert.equal(body.error_code, "missing_cli");
      assert.equal(body.readiness.binary_found, false);
    });

    it("POST /api/projects creates project + controller", async () => {
      const { status, body } = await ctx.api("/api/projects", {
        method: "POST",
        body: {
          name: "test-project",
          description: "A test project",
          task_description: "Run tests",
          command_template: "echo",
        },
      });
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.name, "test-project");
      assert.equal(body.status, "active");
      setProjectId(body.id);
    });

    it("GET /api/projects lists projects", async () => {
      const { status, body } = await ctx.api("/api/projects");
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
    });

    it("GET /api/projects/:id returns project", async () => {
      const { status, body } = await ctx.api("/api/projects/" + getProjectId());
      assert.equal(status, 200);
      assert.equal(body.name, "test-project");
    });

    it("GET /api/projects/:id/orchestration-runs returns an array", async () => {
      const { status, body } = await ctx.api(
        "/api/projects/" + getProjectId() + "/orchestration-runs"
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
    });

    it("PUT /api/projects/:id updates project", async () => {
      const { status, body } = await ctx.api(
        "/api/projects/" + getProjectId(),
        {
          method: "PUT",
          body: { description: "Updated" },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.description, "Updated");
    });

    it("auto-created controller agent exists", async () => {
      const { body } = await ctx.api(
        "/api/projects/" + getProjectId() + "/agents"
      );
      assert.equal(body.length, 2); // controller + assistant
      const controller = body.find((a: any) => a.is_controller === 1);
      assert.ok(controller, "Should have a controller agent");
      setControllerId(controller.id);
    });

    it("GET nonexistent project returns 404", async () => {
      const { status } = await ctx.api("/api/projects/nonexistent");
      assert.equal(status, 404);
    });

    it("stores remote HAICO instances and aggregates remote projects", async () => {
      const login = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "admin1234" },
      });
      assert.equal(login.status, 200);
      const adminCookie = `haico-auth=${login.body.token}`;

      const remoteApp = Fastify({ logger: false });
      await remoteApp.post("/api/auth/login", async (request, reply) => {
        const body = request.body as { username?: string; password?: string } | undefined;
        if (body?.username !== "remote-admin" || body?.password !== "remote-secret") {
          return reply.status(401).send({ error: "Invalid remote credentials" });
        }
        return { ok: true, token: "remote-token-1234" };
      });
      await remoteApp.get("/api/projects", async (request, reply) => {
        const auth = String(request.headers.authorization || "");
        if (auth !== "Bearer remote-token-1234") {
          reply.status(401).send({ error: "Missing remote token" });
          return;
        }
        return [
          {
            id: "remote-project-1",
            name: "remote-project",
            description: "Remote project description",
            task_description: "Remote project task",
            status: "active",
            color: "#123456",
            member_count: 3,
            stats: {
              agents: 2,
              running: 1,
              agentError: 0,
              issues: 5,
              openIssues: 2,
              userIssues: [],
            },
            created_at: "2026-04-12T00:00:00.000Z",
            updated_at: "2026-04-12T01:00:00.000Z",
          },
        ];
      });

      await remoteApp.listen({ port: 0, host: "127.0.0.1" });
      const address = remoteApp.server.address();
      assert.ok(address && typeof address === "object");
      const remotePort =
        address && typeof address === "object" ? address.port : 0;

      try {
        const createRemote = await ctx.api("/api/remote-instances", {
          method: "POST",
          headers: { cookie: adminCookie },
          body: {
            name: "Remote Box",
            base_url: `127.0.0.1:${remotePort}`,
            remote_username: "remote-admin",
            remote_password: "remote-secret",
          },
        });
        assert.equal(createRemote.status, 201);
        assert.equal(createRemote.body.instance.name, "Remote Box");
        assert.equal(
          createRemote.body.instance.base_url,
          `http://127.0.0.1:${remotePort}`
        );
        assert.equal(createRemote.body.probe.ok, true);

        const listRemote = await ctx.api("/api/remote-instances", {
          headers: { cookie: adminCookie },
        });
        assert.equal(listRemote.status, 200);
        assert.equal(listRemote.body.instances.length, 1);

        const remoteProjects = await ctx.api("/api/remote-projects", {
          headers: { cookie: adminCookie },
        });
        assert.equal(remoteProjects.status, 200);
        assert.equal(remoteProjects.body.projects.length, 1);
        assert.equal(remoteProjects.body.projects[0].name, "remote-project");
        assert.equal(
          remoteProjects.body.projects[0].remote_instance_name,
          "Remote Box"
        );
        assert.equal(
          remoteProjects.body.projects[0].remote_url,
          `http://127.0.0.1:${remotePort}/projects/remote-project-1`
        );
      } finally {
        await remoteApp.close();
      }
    });
  });
}
