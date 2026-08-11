// Gateway-owned password management routes (themes #5a/#5b/#5c). These compose entry
// verify + authorization + a genuine internal forward to auth-service. The proxy path
// is deliberately bypassed (auth-service admin routes are internal-only), so these tests
// assert the gateway attaches the trusted headers auth-service requires and never lets a
// non-admin through.
import { describe, it, expect } from "vitest";
import { HDR_INTERNAL } from "@dub/observability";
import type { auth } from "@dub/types";
import { createApp } from "../src/app";
import { fakeBinding, validSession, json, makeEnv, execCtx, type CapturedBinding } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const app = () => createApp(NO_RL);

/** SVC_AUTH stub: answers /verify (entry auth) AND the password endpoints. */
function authSvc(opts: {
  userId?: string;
  invalid?: boolean;
  onPassword?: (req: Request, path: string) => Response;
} = {}): CapturedBinding {
  return fakeBinding((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/verify") {
      return opts.invalid
        ? json(200, { valid: false, userId: null, session: null, reason: "malformed" })
        : json(200, validSession(opts.userId ?? "usr_admin"));
    }
    if (opts.onPassword) return opts.onPassword(req, path);
    return json(200, { ok: true });
  });
}

/** SVC_IDENTITY stub answering /internal/users/:id/permissions. */
function identityPerms(perms: string[]): CapturedBinding {
  return fakeBinding((req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/internal/users/") && path.endsWith("/permissions")) {
      return json(200, { permissions: perms });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } });
  });
}

describe("POST /api/v1/me/password (self change #5b)", () => {
  it("forwards the session token + body to auth-service /auth/password", async () => {
    const auth = authSvc({ userId: "usr_1", onPassword: (_req, path) => (path === "/auth/password" ? json(200, { ok: true }) : json(404, {})) });
    const env = makeEnv({ SVC_AUTH: auth.fetcher });

    const res = await app().fetch(
      new Request("https://x/api/v1/me/password", {
        method: "POST",
        headers: { authorization: "Bearer sess-tok", "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: "old-pw", newPassword: "new-pw-123456" }),
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const fwd = auth.requests.find((r) => new URL(r.url).pathname === "/auth/password");
    expect(fwd).toBeDefined();
    // the raw session token is re-attached so auth-service can identify the user
    expect(fwd!.headers.get("authorization")).toBe("Bearer sess-tok");
    const body = (await fwd!.json()) as auth.SelfPasswordChangeRequest;
    expect(body).toEqual({ currentPassword: "old-pw", newPassword: "new-pw-123456" });
  });

  it("requires a session (401 without a token)", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc({ invalid: true }).fetcher });
    const res = await app().fetch(
      new Request("https://x/api/v1/me/password", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      env,
      execCtx,
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/admin/users/:id/password (set/re-issue #5a)", () => {
  it("admin: forwards internally with x-dub-internal + actor id, returns the generated password", async () => {
    const auth = authSvc({
      userId: "usr_admin",
      onPassword: (_req, path) =>
        path === "/internal/admin/users/usr_target/password" ? json(200, { ok: true, password: "Gen3rated!pw" }) : json(404, {}),
    });
    const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: identityPerms(["identity:read", "identity:admin"]).fetcher });

    const res = await app().fetch(
      new Request("https://x/api/v1/admin/users/usr_target/password", {
        method: "POST",
        headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
        body: JSON.stringify({ generate: true }),
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, password: "Gen3rated!pw" });

    const fwd = auth.requests.find((r) => new URL(r.url).pathname === "/internal/admin/users/usr_target/password");
    expect(fwd).toBeDefined();
    expect(fwd!.headers.get(HDR_INTERNAL)).toBe("1");
    expect(fwd!.headers.get("x-dub-user-id")).toBe("usr_admin");
  });

  it("non-admin: 403 and auth-service password endpoint is never called", async () => {
    const auth = authSvc({ userId: "usr_member", onPassword: () => json(200, { ok: true }) });
    const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: identityPerms(["identity:read"]).fetcher });

    const res = await app().fetch(
      new Request("https://x/api/v1/admin/users/usr_target/password", {
        method: "POST",
        headers: { authorization: "Bearer member-tok", "content-type": "application/json" },
        body: JSON.stringify({ generate: true }),
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(403);
    expect(auth.requests.some((r) => new URL(r.url).pathname.includes("/internal/admin/"))).toBe(false);
  });

  it("requires a session (401 without a token)", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc({ invalid: true }).fetcher, SVC_IDENTITY: identityPerms(["identity:admin"]).fetcher });
    const res = await app().fetch(
      new Request("https://x/api/v1/admin/users/usr_target/password", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      env,
      execCtx,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/admin/users/:id/password (view #5c)", () => {
  it("admin: returns the decrypted password with x-dub-internal forwarded", async () => {
    const auth = authSvc({
      userId: "usr_admin",
      onPassword: (_req, path) =>
        path === "/internal/admin/users/usr_target/password"
          ? json(200, { userId: "usr_target", email: "t@developershub.jp", password: "Curr3nt!pw" })
          : json(404, {}),
    });
    const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: identityPerms(["identity:admin"]).fetcher });

    const res = await app().fetch(
      new Request("https://x/api/v1/admin/users/usr_target/password", { headers: { authorization: "Bearer admin-tok" } }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "usr_target", email: "t@developershub.jp", password: "Curr3nt!pw" });

    const fwd = auth.requests.find((r) => r.method === "GET" && new URL(r.url).pathname === "/internal/admin/users/usr_target/password");
    expect(fwd?.headers.get(HDR_INTERNAL)).toBe("1");
  });

  it("non-admin: 403", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc({ userId: "usr_member" }).fetcher, SVC_IDENTITY: identityPerms(["identity:read"]).fetcher });
    const res = await app().fetch(
      new Request("https://x/api/v1/admin/users/usr_target/password", { headers: { authorization: "Bearer member-tok" } }),
      env,
      execCtx,
    );
    expect(res.status).toBe(403);
  });
});
