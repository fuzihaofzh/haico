import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiTestContext } from "./helpers";

export interface AuthSuiteState {
  sessionToken: string;
}

export function registerAuthSuites(
  ctx: ApiTestContext,
  state: AuthSuiteState
): void {
  function getSessionToken(): string {
    assert.ok(
      state.sessionToken,
      "sessionToken should be initialized before this auth test runs"
    );
    return state.sessionToken;
  }

  function setSessionToken(value: string): void {
    state.sessionToken = value;
  }

  describe("Auth", () => {
    let adminUserId: string;
    let memberUserId: string;
    let memberToken: string;

    it("redirects protected pages to registration when no users exist", async () => {
      const res = await ctx.inject({ url: "/change-password" });
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/register");
    });

    it("returns JSON for protected APIs when no users exist", async () => {
      const { status, body, headers } = await ctx.api("/api/remote-instances");
      assert.equal(status, 401);
      assert.equal(headers.location, undefined);
      assert.equal(
        body.error,
        "No authentication configured. Visit /register to create the first account."
      );
    });

    it("GET /login redirects to /register when no users exist", async () => {
      const res = await ctx.inject({ url: "/login" });
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/register");
    });

    it("removed single-password endpoints are unavailable", async () => {
      const setup = await ctx.api("/api/auth/setup", {
        method: "POST",
        body: { password: "test1234" },
      });
      const singlePasswordLogin = await ctx.api("/api/auth", {
        method: "POST",
        body: { password: "test1234" },
      });
      assert.equal(setup.status, 404);
      assert.equal(singlePasswordLogin.status, 404);
    });

    it("POST /api/auth/register creates the first user as admin and logs in", async () => {
      const { status, body, headers } = await ctx.api("/api/auth/register", {
        method: "POST",
        body: {
          username: "testadmin",
          password: "admin1234",
          display_name: "Test Admin",
        },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, "admin");
      assert.equal(body.user.username, "testadmin");
      assert.ok(body.token);
      assert.ok(String(headers["set-cookie"]).includes("haico-auth="));
      adminUserId = body.user.id;
      setSessionToken(body.token);
    });

    it("returns JSON for unauthenticated protected APIs after a user exists", async () => {
      const { status, body, headers } = await ctx.api("/api/remote-instances", {
        headers: { cookie: "" },
      });
      assert.equal(status, 401);
      assert.equal(headers.location, undefined);
      assert.deepEqual(body, { error: "Unauthorized" });
    });

    it("GET /login shows login page when users exist", async () => {
      const res = await ctx.inject({ url: "/login" });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes("Login"));
    });

    it("GET /setup is removed", async () => {
      const res = await ctx.inject({ url: "/setup" });
      assert.equal(res.statusCode, 404);
    });

    it("POST /api/auth/login authenticates a user", async () => {
      const { status, body, headers } = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "admin1234" },
      });
      assert.equal(status, 200);
      assert.ok(body.token);
      assert.equal(body.user.username, "testadmin");
      assert.ok(String(headers["set-cookie"]).includes("haico-auth="));
      setSessionToken(body.token);
    });

    it("POST /api/auth/login accepts htmx form-encoded credentials", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: "username=testadmin&password=admin1234",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "hx-request": "true",
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.token);
      assert.equal(body.user.username, "testadmin");
    });

    it("POST /api/auth/login rejects wrong passwords", async () => {
      const { status } = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "wrongpass" },
      });
      assert.equal(status, 401);
    });

    it("password-hash style tokens are rejected", async () => {
      const { status } = await ctx.api("/api/auth/me", {
        headers: { cookie: "haico-auth=not-a-session-token" },
      });
      assert.equal(status, 401);
    });

    it("HAICO_NO_AUTH does not bypass authentication", async () => {
      const previous = process.env.HAICO_NO_AUTH;
      process.env.HAICO_NO_AUTH = "true";
      try {
        const { status } = await ctx.api("/api/projects", {
          headers: { cookie: "" },
        });
        assert.equal(status, 401);
      } finally {
        if (previous === undefined) delete process.env.HAICO_NO_AUTH;
        else process.env.HAICO_NO_AUTH = previous;
      }
    });

    it("GET /api/auth/me returns the current user", async () => {
      const { status, body } = await ctx.api("/api/auth/me", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.equal(body.username, "testadmin");
      assert.equal(body.role, "admin");
    });

    it("unauthenticated register is rejected after the first user exists", async () => {
      const { status, body } = await ctx.api("/api/auth/register", {
        method: "POST",
        headers: { cookie: "" },
        body: { username: "blockedmember", password: "member1234" },
      });
      assert.equal(status, 403);
      assert.equal(body.error, "Admin access required");
    });

    it("admin can register a member", async () => {
      const { status, body } = await ctx.api("/api/auth/register", {
        method: "POST",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
        body: { username: "testmember", password: "member1234" },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, "member");
      memberUserId = body.user.id;

      const login = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testmember", password: "member1234" },
      });
      assert.equal(login.status, 200);
      memberToken = login.body.token;
    });

    it("member cannot register another user", async () => {
      const { status } = await ctx.api("/api/auth/register", {
        method: "POST",
        headers: { cookie: `haico-auth=${memberToken}` },
        body: { username: "blockedbyrole", password: "member1234" },
      });
      assert.equal(status, 403);
    });

    it("GET /api/auth/users lists users for admins only", async () => {
      const adminUsers = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(adminUsers.status, 200);
      assert.ok(Array.isArray(adminUsers.body.users));
      assert.ok(adminUsers.body.users.length >= 2);

      const memberUsers = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(memberUsers.status, 403);
    });

    it("admin can update and delete another user", async () => {
      const updated = await ctx.api(`/api/auth/users/${memberUserId}`, {
        method: "PUT",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
        body: { role: "admin" },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.user.role, "admin");

      const deleted = await ctx.api(`/api/auth/users/${memberUserId}`, {
        method: "DELETE",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(deleted.status, 200);
    });

    it("admin cannot delete self", async () => {
      const { status } = await ctx.api(`/api/auth/users/${adminUserId}`, {
        method: "DELETE",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 400);
    });

    it("change-password requires the current user password", async () => {
      const wrong = await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "wrongpass", password: "newpass1234" },
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(wrong.status, 401);

      const short = await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "admin1234", password: "ab" },
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(short.status, 400);
    });

    it("change-password invalidates old sessions and returns a fresh session", async () => {
      const oldToken = getSessionToken();
      const changed = await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "admin1234", password: "newpass1234" },
        headers: { cookie: `haico-auth=${oldToken}` },
      });
      assert.equal(changed.status, 200);
      assert.ok(changed.body.token);

      const oldSession = await ctx.api("/api/auth/me", {
        headers: { cookie: `haico-auth=${oldToken}` },
      });
      assert.equal(oldSession.status, 401);

      const newLogin = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "newpass1234" },
      });
      assert.equal(newLogin.status, 200);

      const oldPassword = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "admin1234" },
      });
      assert.equal(oldPassword.status, 401);

      const restored = await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "newpass1234", password: "admin1234" },
        headers: { cookie: `haico-auth=${newLogin.body.token}` },
      });
      assert.equal(restored.status, 200);
      setSessionToken(restored.body.token);
    });

    it("GET /change-password returns HTML for authenticated users", async () => {
      const res = await ctx.inject({
        url: "/change-password",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes("Change"));
    });

    it("localhost no longer bypasses authentication", async () => {
      const { status } = await ctx.api("/api/projects", {
        headers: { cookie: "" },
      });
      assert.equal(status, 401);
    });

    it("settings remote instances partial requires admin session", async () => {
      const unauthenticated = await ctx.inject({
        url: "/settings/partials/remote-instances",
        headers: { cookie: "" },
      });
      assert.equal(unauthenticated.statusCode, 302);
      assert.equal(unauthenticated.headers.location, "/login");

      const authenticated = await ctx.inject({
        url: "/settings/partials/remote-instances",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(authenticated.statusCode, 200);
      assert.ok(authenticated.headers["content-type"]?.includes("text/html"));
      assert.ok(authenticated.body.includes("No remote HAICO instances yet."));
    });

    it("POST /api/auth/logout clears cookie", async () => {
      const { status, body } = await ctx.api("/api/auth/logout", {
        method: "POST",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const login = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "admin1234" },
      });
      assert.equal(login.status, 200);
      setSessionToken(login.body.token);
    });
  });
}
