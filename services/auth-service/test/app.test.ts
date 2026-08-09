import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { makeHarness, jsonInit, MemoryKV } from "./helpers";

function stateFromKv(kv: MemoryKV): string {
  for (const key of kv.store.keys()) if (key.startsWith("oauth_state:")) return key.slice("oauth_state:".length);
  throw new Error("no oauth_state stored");
}

describe("POST /auth/login", () => {
  it("issues state + PKCE and returns the authorization URL", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/login", jsonInit({ redirectUri: "https://app.test/home" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizationUrl: string; state: string };
    expect(body.state).toBeTruthy();
    expect(body.authorizationUrl).toContain(`state=${encodeURIComponent(body.state)}`);
    // server-side PKCE stored, single-use, TTL-bound
    const state = stateFromKv(h.kv);
    expect(state).toBe(body.state);
    expect(h.oauth.lastAuthorize?.codeChallenge).toBeTruthy();
  });

  it("rejects a redirectUri outside the allowlist", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/login", jsonInit({ redirectUri: "https://evil.test/x" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("GET /auth/callback", () => {
  async function startLogin(h: ReturnType<typeof makeHarness>): Promise<string> {
    const app = buildApp(h.deps);
    const res = await app.request("/auth/login", jsonInit({ redirectUri: "https://app.test/home" }));
    return ((await res.json()) as { state: string }).state;
  }

  it("success: exchange -> provision -> web session -> Set-Cookie -> 302", async () => {
    const h = makeHarness();
    const state = await startLogin(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/auth/callback?code=code123&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/home");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("dub_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Domain=.test.dev");
    expect(h.audit.records.some((r) => r.action === "auth.session.login" && r.result === "success")).toBe(true);
  });

  it("state mismatch -> 302 to error page with AUTH_STATE_MISMATCH", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request(`/auth/callback?code=code123&state=unknown`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=AUTH_STATE_MISMATCH");
  });

  it("oauth exchange failure -> 302 error, no session, failure audit", async () => {
    const h = makeHarness();
    h.oauth.webProfile = new Error("boom");
    const state = await startLogin(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/auth/callback?code=bad&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=AUTH_OAUTH_EXCHANGE_FAILED");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.audit.records.some((r) => r.result === "failure")).toBe(true);
  });

  it("invite-only rejection -> 302 error with AUTH_USER_REJECTED, no session", async () => {
    const h = makeHarness();
    h.identity.result = { status: "rejected", user: null };
    const state = await startLogin(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/auth/callback?code=code123&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=AUTH_USER_REJECTED");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

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
