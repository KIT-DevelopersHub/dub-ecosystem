import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { makeHarness, jsonInit } from "./helpers";

describe("POST /verify (internal)", () => {
  it("requires x-dub-internal (403 without it)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/verify", jsonInit({ token: "x" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_INTERNAL_FORBIDDEN");
  });

  it("returns the AuthVerifyResponse contract for a valid token", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_v", "web");
    const app = buildApp(h.deps);
    const res = await app.request("/verify", jsonInit({ token: created.token }, { internal: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; userId: string | null; reason: string | null };
    expect(body).toMatchObject({ valid: true, userId: "usr_v", reason: null });
  });

  it("reports revoked for an unknown token", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/verify", jsonInit({ token: "a".repeat(43) }, { internal: true }));
    const body = (await res.json()) as { valid: boolean; reason: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("revoked");
  });
});

describe("POST /auth/refresh", () => {
  it("cookie path: rotates via Set-Cookie, body carries session only", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");
    const app = buildApp(h.deps);
    const res = await app.request(
      "/auth/refresh",
      jsonInit({}, { cookie: `dub_session=${created.token}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("dub_session=");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.session).toBeTruthy();
    expect(body.token).toBeUndefined();
  });

  it("bearer path: returns rotated token in body, no Set-Cookie", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "mobile");
    const app = buildApp(h.deps);
    const res = await app.request("/auth/refresh", jsonInit({}, { bearer: created.token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; session?: unknown };
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(created.token);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("revoked token -> 401 AUTH_SESSION_REVOKED", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/refresh", jsonInit({}, { bearer: "b".repeat(43) }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_SESSION_REVOKED");
  });

  it("duplicate refresh with the same cookie both return 200 (no spurious Invalid token)", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");
    const app = buildApp(h.deps);
    const cookie = `dub_session=${created.token}`;
    const first = await app.request("/auth/refresh", jsonInit({}, { cookie }));
    // A second refresh still carrying the pre-rotation cookie (multi-tab / retry
    // before the rotated Set-Cookie applied) must not 401.
    const second = await app.request("/auth/refresh", jsonInit({}, { cookie }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json() as { session?: unknown }).session).toBeTruthy();
    expect((await second.json() as { session?: unknown }).session).toBeTruthy();
  });
});

describe("POST /auth/logout", () => {
  it("cookie path clears the cookie and invalidates the session", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");
    const app = buildApp(h.deps);
    const res = await app.request("/auth/logout", jsonInit({}, { cookie: `dub_session=${created.token}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await h.deps.sessions.verify(created.token)).reason).toBe("revoked");
  });
});

describe("POST /auth/test-login", () => {
  it("issues a session when enabled (preview)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/test-login", jsonInit({ userId: "usr_seed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; session: { userId: string } };
    expect(body.token).toBeTruthy();
    expect(body.session.userId).toBe("usr_seed");
    expect(res.headers.get("set-cookie")).toContain("dub_session=");
  });

  it("is forbidden in production", async () => {
    const h = makeHarness({ ENVIRONMENT: "production" });
    const app = buildApp(h.deps);
    const res = await app.request("/auth/test-login", jsonInit({ userId: "usr_seed" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_TEST_LOGIN_DISABLED");
  });
});

describe("POST /mobile/exchange (internal)", () => {
  it("requires x-dub-internal", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/mobile/exchange", jsonInit({ code: "c" }));
    expect(res.status).toBe(403);
  });

  it("exchanges a mobile code into a mobile session (180d)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/mobile/exchange", jsonInit({ code: "mob-code" }, { internal: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; session: { client: string } };
    expect(body.session.client).toBe("mobile");
    expect((await h.deps.sessions.verify(body.token)).valid).toBe(true);
  });
});

describe("POST /internal/revoke-user (internal)", () => {
  it("requires x-dub-internal", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/internal/revoke-user", jsonInit({ userId: "usr_1", reason: "suspended" }));
    expect(res.status).toBe(403);
  });

  it("force-revokes all sessions for the user and audits it", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_x", "web");
    const app = buildApp(h.deps);
    const res = await app.request(
      "/internal/revoke-user",
      jsonInit({ userId: "usr_x", reason: "suspended" }, { internal: true }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    expect((await h.deps.sessions.verify(created.token)).reason).toBe("revoked");
    expect(h.audit.records.some((r) => r.action === "auth.session.revoked")).toBe(true);
  });
});

describe("POST /auth/refresh — malformed + body-token paths", () => {
  it("malformed token -> 401 AUTH_INVALID_TOKEN (auth.md §6)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/refresh", jsonInit({}, { bearer: "###not-a-token###" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_INVALID_TOKEN");
  });

  it("accepts the token from the { refreshToken } body (bearer path, rotates in body)", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_body", "mobile");
    const app = buildApp(h.deps);
    const res = await app.request("/auth/refresh", jsonInit({ refreshToken: created.token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; session?: { userId: string } };
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(created.token);
    expect(body.session?.userId).toBe("usr_body");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
