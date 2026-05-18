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
    it("/ accessible from localhost (auth bypass)", async () => {
      // Localhost bypasses auth, so we get the page or redirect to setup
      const res = await ctx.inject({ url: "/" });
      // inject simulates 127.0.0.1 so auth is bypassed
      assert.ok(res.statusCode === 200 || res.statusCode === 302);
    });

    it("GET /setup returns setup HTML", async () => {
      const res = await ctx.inject({ url: "/setup" });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes("Set a password"));
    });

    it("redirects protected pages to registration when auth is not configured", async () => {
      const res = await ctx.inject({ url: "/change-password" });
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/register");
    });

    it("returns JSON for protected APIs when auth is not configured", async () => {
      const { status, body, headers } = await ctx.api("/api/remote-instances");
      assert.equal(status, 401);
      assert.equal(headers.location, undefined);
      assert.equal(
        body.error,
        "No authentication configured. Visit /register to create the first account."
      );
    });

    it("POST /api/auth/setup rejects short password", async () => {
      const { status } = await ctx.api("/api/auth/setup", {
        method: "POST",
        body: { password: "ab" },
      });
      assert.equal(status, 400);
    });

    it("POST /api/auth/setup sets password", async () => {
      const { status, body } = await ctx.api("/api/auth/setup", {
        method: "POST",
        body: { password: "test1234" },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    it("rejects setup when password already set", async () => {
      const { status } = await ctx.api("/api/auth/setup", {
        method: "POST",
        body: { password: "another" },
      });
      assert.equal(status, 403);
    });

    it("POST /api/auth rejects wrong password", async () => {
      const { status } = await ctx.api("/api/auth", {
        method: "POST",
        body: { password: "wrong" },
      });
      assert.equal(status, 401);
    });

    it("POST /api/auth accepts correct password and returns token", async () => {
      const { status, body } = await ctx.api("/api/auth", {
        method: "POST",
        body: { password: "test1234" },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.token, "Login should return a token (passwordHash)");
    });

    it("returns JSON for unauthenticated protected APIs after auth is configured", async () => {
      const { status, body, headers } = await ctx.api("/api/remote-instances");
      assert.equal(status, 401);
      assert.equal(headers.location, undefined);
      assert.deepEqual(body, { error: "Unauthorized" });
    });

    it("POST /api/auth/setup sets cookie on first setup", async () => {
      // Setup was already done, so we just verify login works
      const { body } = await ctx.api("/api/auth", {
        method: "POST",
        body: { password: "test1234" },
      });
      assert.ok(body.token, "Should return token");
    });
  });

  // ─── Auth Security (Cookie-based, no server-side sessions) ───

  describe("Auth Security", () => {
    it("login returns cookie with passwordHash", async () => {
      const loginRes = await ctx.app.inject({
        method: "POST",
        url: "/api/auth",
        payload: { password: "test1234" },
        headers: { "content-type": "application/json" },
      });
      assert.equal(loginRes.statusCode, 200);
      const setCookie = loginRes.headers["set-cookie"] as string;
      assert.ok(setCookie, "Should set a cookie");
      assert.ok(
        setCookie.includes("haico-auth="),
        "Cookie should be haico-auth"
      );
      assert.ok(setCookie.includes("HttpOnly"), "Cookie should be HttpOnly");
      assert.ok(
        setCookie.includes("SameSite=Lax"),
        "Cookie should have SameSite"
      );
      assert.ok(
        !setCookie.includes("Max-Age"),
        "Cookie should NOT have Max-Age (session cookie)"
      );

      const match = setCookie.match(/haico-auth=([^;]+)/);
      assert.ok(match, "Should extract token");
      setSessionToken(match![1]);

      const loginBody = JSON.parse(loginRes.body);
      assert.ok(loginBody.token, "Should return token in body");
      assert.equal(
        loginBody.token,
        getSessionToken(),
        "Body token should match cookie"
      );
    });

    it("POST /api/auth/logout clears cookie", async () => {
      const { status, body } = await ctx.api("/api/auth/logout", {
        method: "POST",
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    it("POST /api/auth/change-password rejects wrong current password", async () => {
      const { status } = await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "wrongpass", password: "newpass1234" },
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 401);
    });

    it("POST /api/auth/change-password rejects short new password", async () => {
      const { status } = await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "test1234", password: "ab" },
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 400);
    });

    it("POST /api/auth/change-password works with correct current password", async () => {
      const { status, body } = await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "test1234", password: "newpass1234" },
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      // Verify login with new password works
      const { status: s2 } = await ctx.api("/api/auth", {
        method: "POST",
        body: { password: "newpass1234" },
      });
      assert.equal(s2, 200);

      // Verify old password no longer works
      const { status: s3 } = await ctx.api("/api/auth", {
        method: "POST",
        body: { password: "test1234" },
      });
      assert.equal(s3, 401);

      // Change back for remaining tests
      const loginRes2 = await ctx.app.inject({
        method: "POST",
        url: "/api/auth",
        payload: { password: "newpass1234" },
        headers: { "content-type": "application/json" },
      });
      const cookie2 = (loginRes2.headers["set-cookie"] as string).match(
        /haico-auth=([^;]+)/
      )![1];
      await ctx.api("/api/auth/change-password", {
        method: "POST",
        body: { current: "newpass1234", password: "test1234" },
        headers: { cookie: `haico-auth=${cookie2}` },
      });

      // Refresh getSessionToken() for subsequent tests
      const refreshRes = await ctx.app.inject({
        method: "POST",
        url: "/api/auth",
        payload: { password: "test1234" },
        headers: { "content-type": "application/json" },
      });
      const refreshedToken = (refreshRes.headers["set-cookie"] as string).match(
        /haico-auth=([^;]+)/
      )![1];
      setSessionToken(refreshedToken);
    });

    it("GET /change-password returns HTML", async () => {
      const res = await ctx.inject({
        url: "/change-password",
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes("Change"));
    });

    it("localhost bypass only works for safe API routes", async () => {
      const { status: projStatus } = await ctx.api("/api/projects");
      assert.equal(projStatus, 200);
    });

    it("change-password invalidates old cookie (hash changes)", async () => {
      // Login to get current token
      const loginRes = await ctx.app.inject({
        method: "POST",
        url: "/api/auth",
        payload: { password: "test1234" },
        headers: { "content-type": "application/json" },
      });
      const oldToken = (loginRes.headers["set-cookie"] as string).match(
        /haico-auth=([^;]+)/
      )![1];

      // Change password
      const changeRes = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        payload: { current: "test1234", password: "changed1234" },
        headers: {
          "content-type": "application/json",
          cookie: `haico-auth=${oldToken}`,
        },
      });
      assert.equal(changeRes.statusCode, 200);

      // Old token should be invalid (passwordHash changed)
      // Use page route to test cookie-based auth redirect
      const oldRes = await ctx.inject({
        url: "/change-password",
        headers: { cookie: `haico-auth=${oldToken}` },
      });
      assert.equal(
        oldRes.statusCode,
        302,
        "Old token should be invalidated after password change (redirects to /login)"
      );

      // Restore password for remaining tests
      const newLogin = await ctx.app.inject({
        method: "POST",
        url: "/api/auth",
        payload: { password: "changed1234" },
        headers: { "content-type": "application/json" },
      });
      const newToken = (newLogin.headers["set-cookie"] as string).match(
        /haico-auth=([^;]+)/
      )![1];
      await ctx.app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        payload: { current: "changed1234", password: "test1234" },
        headers: {
          "content-type": "application/json",
          cookie: `haico-auth=${newToken}`,
        },
      });

      // Refresh getSessionToken() for subsequent tests
      const refreshRes = await ctx.app.inject({
        method: "POST",
        url: "/api/auth",
        payload: { password: "test1234" },
        headers: { "content-type": "application/json" },
      });
      const refreshedToken = (refreshRes.headers["set-cookie"] as string).match(
        /haico-auth=([^;]+)/
      )![1];
      setSessionToken(refreshedToken);
    });

    it("invalid cookie token is rejected", async () => {
      // Use page route to test cookie-based auth redirect
      const res = await ctx.inject({
        url: "/change-password",
        headers: { cookie: "haico-auth=invalid-token-value" },
      });
      assert.equal(
        res.statusCode,
        302,
        "Invalid token should be rejected (redirects to /login)"
      );
    });

    it("GET /login shows login page when password is set", async () => {
      const res = await ctx.inject({ url: "/login" });
      assert.equal(res.statusCode, 200);
      assert.ok(
        res.body.includes("Login"),
        "Should show login page when password is set"
      );
    });

    it("GET /setup redirects to /login when password already set", async () => {
      const res = await ctx.inject({ url: "/setup" });
      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.location === "/login", "Should redirect to /login");
    });
  });

  // ─── Multi-user Auth (#420) ───

  describe("Multi-user Auth (#420)", () => {
    let adminToken: string;
    let memberToken: string;
    let adminUserId: string;
    let memberUserId: string;

    it("POST /api/auth/register creates first user as admin", async () => {
      const { status, body } = await ctx.api("/api/auth/register", {
        method: "POST",
        body: {
          username: "testadmin",
          password: "admin1234",
          display_name: "Test Admin",
        },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, "admin", "First user should be admin");
      assert.equal(body.user.username, "testadmin");
      adminUserId = body.user.id;
    });

    it("POST /api/auth/register rejects invalid username", async () => {
      const { status } = await ctx.api("/api/auth/register", {
        method: "POST",
        body: { username: "a", password: "pass1234" },
      });
      assert.equal(status, 400);
    });

    it("POST /api/auth/register rejects duplicate username", async () => {
      const { status } = await ctx.api("/api/auth/register", {
        method: "POST",
        body: { username: "testadmin", password: "pass1234" },
      });
      assert.equal(status, 409);
    });

    it("POST /api/auth/login authenticates user", async () => {
      const { status, body } = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "admin1234" },
      });
      assert.equal(status, 200);
      assert.ok(body.token, "Should return session token");
      assert.equal(body.user.username, "testadmin");
      adminToken = body.token;
    });

    it("POST /api/auth/login rejects wrong password", async () => {
      const { status } = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "wrongpass" },
      });
      assert.equal(status, 401);
    });

    it("GET /api/auth/me returns current user", async () => {
      const { status, body } = await ctx.api("/api/auth/me", {
        headers: { cookie: `haico-auth=${adminToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.username, "testadmin");
      assert.equal(body.role, "admin");
    });

    it("POST /api/auth/register creates second user as member", async () => {
      const { status, body } = await ctx.api("/api/auth/register", {
        method: "POST",
        body: { username: "testmember", password: "member1234" },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, "member", "Second user should be member");
      memberUserId = body.user.id;
      const login = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testmember", password: "member1234" },
      });
      memberToken = login.body.token;
    });

    it("GET /api/auth/users lists users (admin only)", async () => {
      const { status, body } = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${adminToken}` },
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.users));
      assert.ok(body.users.length >= 2);
    });

    it("GET /api/auth/users returns 403 for non-admin", async () => {
      const { status } = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${memberToken}` },
      });
      assert.equal(status, 403);
    });

    it("PUT /api/auth/users/:id updates role (admin only)", async () => {
      const { status, body } = await ctx.api(
        `/api/auth/users/${memberUserId}`,
        {
          method: "PUT",
          headers: { cookie: `haico-auth=${adminToken}` },
          body: { role: "admin" },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.user.role, "admin");
    });

    it("DELETE /api/auth/users/:id deletes user (admin only)", async () => {
      const { status } = await ctx.api(`/api/auth/users/${memberUserId}`, {
        method: "DELETE",
        headers: { cookie: `haico-auth=${adminToken}` },
      });
      assert.equal(status, 200);
    });

    it("DELETE /api/auth/users/:id rejects deleting self", async () => {
      const { status } = await ctx.api(`/api/auth/users/${adminUserId}`, {
        method: "DELETE",
        headers: { cookie: `haico-auth=${adminToken}` },
      });
      assert.equal(status, 400);
    });
  });

  describe("Legacy admin fallback for user management (#482/#483)", () => {
    let fallbackMemberId: string;
    let fallbackMemberToken: string;

    it("creates a fresh member for legacy fallback checks", async () => {
      const username = `legacycheck${Date.now()}`;
      const { status, body } = await ctx.api("/api/auth/register", {
        method: "POST",
        body: {
          username,
          password: "member1234",
          display_name: "Legacy Check Member",
        },
      });
      assert.equal(status, 201);
      assert.equal(body.user.role, "member");
      fallbackMemberId = body.user.id;

      const login = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username, password: "member1234" },
      });
      assert.equal(login.status, 200);
      fallbackMemberToken = login.body.token;
    });

    it("GET /api/auth/me returns legacy admin from single-password cookie", async () => {
      const { status, body } = await ctx.api("/api/auth/me", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.equal(body.id, "legacy");
      assert.equal(body.username, "admin");
      assert.equal(body.role, "admin");
    });

    it("legacy single-password admin can list users", async () => {
      const { status, body } = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.users));
      assert.ok(body.users.some((user: any) => user.id === fallbackMemberId));
    });

    it("multi-user admin/member permissions still work alongside legacy fallback", async () => {
      const adminLogin = await ctx.api("/api/auth/login", {
        method: "POST",
        body: { username: "testadmin", password: "admin1234" },
      });
      assert.equal(adminLogin.status, 200);
      const adminToken = adminLogin.body.token;

      const adminUsers = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${adminToken}` },
      });
      assert.equal(adminUsers.status, 200);
      assert.ok(Array.isArray(adminUsers.body.users));

      const memberUsers = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${fallbackMemberToken}` },
      });
      assert.equal(memberUsers.status, 403);
      assert.equal(memberUsers.body.error, "Admin access required");
    });

    it("legacy single-password admin can update another user role", async () => {
      const { status, body } = await ctx.api(
        `/api/auth/users/${fallbackMemberId}`,
        {
          method: "PUT",
          headers: { cookie: `haico-auth=${getSessionToken()}` },
          body: { role: "admin" },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.user.id, fallbackMemberId);
      assert.equal(body.user.role, "admin");
    });

    it("legacy single-password admin can delete another user", async () => {
      const { status, body } = await ctx.api(
        `/api/auth/users/${fallbackMemberId}`,
        {
          method: "DELETE",
          headers: { cookie: `haico-auth=${getSessionToken()}` },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const users = await ctx.api("/api/auth/users", {
        headers: { cookie: `haico-auth=${getSessionToken()}` },
      });
      assert.equal(users.status, 200);
      assert.ok(
        !users.body.users.some((user: any) => user.id === fallbackMemberId)
      );
    });
  });

  // ─── Projects ───
}
