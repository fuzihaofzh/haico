import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { registerAgentSuites } from "./api/agents.suite";
import { registerApiRetrySuites } from "./api/api-retry.suite";
import { registerAuthSuites } from "./api/auth.suite";
import { registerAutomationTriggerSuites } from "./api/automation-triggers.suite";
import { registerDashboardSuites } from "./api/dashboard.suite";
import type { ApiTestContext } from "./api/helpers";
import { registerFocusedApiRegressionSuites } from "./api/focused-regressions.suite";
import { registerGitIntegrationSuites } from "./api/git-integration.suite";
import { registerIssueSuites } from "./api/issues.suite";
import { registerKnowledgeAndCollaborationSuites } from "./api/knowledge-collaboration.suite";
import { registerNotificationSuites } from "./api/notifications.suite";
import { registerProcessManagerSuites } from "./api/process-manager.suite";
import { registerProjectSuites } from "./api/projects.suite";
import { registerProjectAccessSuites } from "./api/project-access.suite";
import { registerSchedulingRegressionSuites } from "./api/scheduling-regressions.suite";

// Use isolated test DB
const TEST_DB = path.join(__dirname, "test.db");
process.env.HAICO_DB_PATH = TEST_DB;
process.env.HAICO_PORT = "0"; // won't matter, we use inject

const authConfigDir = path.join(require("os").homedir(), ".haico");
const authConfigPath = path.join(authConfigDir, "config.json");

// Helper: use Fastify inject (in-process, no real network needed)
function inject(
  app: FastifyInstance,
  opts: {
    method?: string;
    url: string;
    body?: any;
    headers?: Record<string, string>;
  }
) {
  const headers: Record<string, string> = { ...opts.headers };
  // Only set content-type when there's a body
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return app.inject({
    method: (opts.method as any) || "GET",
    url: opts.url,
    payload: opts.body,
    headers,
  });
}

async function api(
  app: FastifyInstance,
  url: string,
  opts: { method?: string; body?: any; headers?: Record<string, string> } = {}
) {
  const res = await inject(app, { url, ...opts });
  let body: any = {};
  try {
    body = JSON.parse(res.body);
  } catch {}
  return { status: res.statusCode, body, headers: res.headers, raw: res.body };
}

let app: FastifyInstance;

const apiTestContext: ApiTestContext = {
  get app() {
    return app;
  },
  api(url, opts = {}) {
    return api(app, url, opts);
  },
  inject(opts) {
    return inject(app, opts);
  },
};

describe("HAICO API", () => {
  before(async () => {
    // Clean slate
    for (const f of [
      TEST_DB,
      TEST_DB + "-wal",
      TEST_DB + "-shm",
      authConfigPath,
    ]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    const { createApp } = await import("../src/app");
    app = await createApp({
      port: 0,
      host: "127.0.0.1",
      logger: false,
      skipScheduler: true,
    });
  });

  after(async () => {
    const { destroyApp } = await import("../src/app");
    await destroyApp(app);
    for (const f of [
      TEST_DB,
      TEST_DB + "-wal",
      TEST_DB + "-shm",
      authConfigPath,
    ]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  // ─── Auth ───

  let sessionToken: string;

  registerAuthSuites(apiTestContext, {
    get sessionToken() {
      return sessionToken;
    },
    set sessionToken(value: string) {
      sessionToken = value;
    },
  });
  let projectId: string;
  let controllerId: string;
  let workerId: string;

  registerProjectSuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
    set projectId(value: string) {
      projectId = value;
    },
    get controllerId() {
      return controllerId;
    },
    set controllerId(value: string) {
      controllerId = value;
    },
  });
  registerProjectAccessSuites(apiTestContext);
  registerAgentSuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
    get workerId() {
      return workerId;
    },
    set workerId(value: string) {
      workerId = value;
    },
  });
  registerIssueSuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
    get workerId() {
      return workerId;
    },
  });
  registerNotificationSuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
    get workerId() {
      return workerId;
    },
  });
  // ─── Dashboard Summary ───

  registerDashboardSuites(apiTestContext, {
    get sessionToken() {
      return sessionToken;
    },
    get projectId() {
      return projectId;
    },
    get controllerId() {
      return controllerId;
    },
  });
  registerGitIntegrationSuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
    get workerId() {
      return workerId;
    },
  });
  registerAutomationTriggerSuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
    get workerId() {
      return workerId;
    },
  });
  registerApiRetrySuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
    get workerId() {
      return workerId;
    },
  });
  describe("Cleanup", () => {
    it("DELETE agent", async () => {
      const { status } = await api(app, `/api/agents/${workerId}`, {
        method: "DELETE",
      });
      assert.equal(status, 200);
      const { status: s2 } = await api(app, `/api/agents/${workerId}`);
      assert.equal(s2, 404);
    });

    it("DELETE project cascades", async () => {
      const { status } = await api(app, `/api/projects/${projectId}`, {
        method: "DELETE",
      });
      assert.equal(status, 200);
      const { status: cs } = await api(app, `/api/agents/${controllerId}`);
      assert.equal(cs, 404);
      const { status: ps } = await api(app, `/api/projects/${projectId}`);
      assert.equal(ps, 404);
    });
  });

  registerFocusedApiRegressionSuites(apiTestContext);
  registerKnowledgeAndCollaborationSuites(apiTestContext);
  registerSchedulingRegressionSuites(apiTestContext, {
    get projectId() {
      return projectId;
    },
  });
  registerProcessManagerSuites(apiTestContext);
});
