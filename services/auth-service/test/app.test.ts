import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { makeHarness, jsonInit } from "./helpers";

describe("POST /verify (internal)", () => {
  // Still 403, but the rejection now comes from policyGate (the INTERNAL rule in
  // POLICY_TABLE) rather than a hand-rolled requireInternal, so the code is @dub/errors'
  // generic FORBIDDEN carrying `details.reason = "internal_only"`. The service-local
  // AUTH_INTERNAL_FORBIDDEN code is no longer produced anywhere.
  it("requires x-dub-internal (403 without it)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/verify", jsonInit({ token: "x" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details.reason).toBe("internal_only");
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

// Cookie Max-Age must track the EFFECTIVE deadline = min(sliding absolute, idle). Handing
// the browser a 90d cookie for a session the idle rule kills in 30d means a month of
// requests carrying a token the server already rejects.
// NOTE: app.ts sizes Max-Age off wall-clock Date.now() (Deps carries no clock), so these
// tests align the harness clock with real time and assert a small tolerance band.
describe("session cookie Max-Age", () => {
  const DAY = 86_400;
  const maxAgeOf = (setCookie: string | null): number => {
    const m = /Max-Age=(\d+)/.exec(setCookie ?? "");
    if (!m) throw new Error(`no Max-Age in Set-Cookie: ${setCookie}`);
    return Number(m[1]);
  };
  const near = (actual: number, expected: number): void => {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(5); // ms-level clock skew only
  };

  it("uses the 30d idle deadline, not the 90d absolute one, on a fresh session", async () => {
    const h = makeHarness();
    h.setNow(Date.now());
    const app = buildApp(h.deps);
    const res = await app.request("/auth/test-login", jsonInit({ userId: "usr_cookie" }));
    expect(res.status).toBe(200);
    const maxAge = maxAgeOf(res.headers.get("set-cookie"));
    near(maxAge, 30 * DAY);
    expect(maxAge).toBeLessThan(90 * DAY);
  });

  it("follows the absolute deadline when IT is the smaller of the two", async () => {
    // Idle window wider than the absolute one => the absolute deadline governs.
    const h = makeHarness({ SESSION_IDLE_TTL_SEC: String(365 * DAY) });
    h.setNow(Date.now());
    const app = buildApp(h.deps);
    const res = await app.request("/auth/test-login", jsonInit({ userId: "usr_cookie2" }));
    near(maxAgeOf(res.headers.get("set-cookie")), 90 * DAY);
  });

  it("refresh re-issues the cookie at the slid effective deadline", async () => {
    const h = makeHarness();
    const now = Date.now();
    h.setNow(now);
    const created = await h.deps.sessions.create("usr_cookie3", "web");
    // Ten days on, the original idle window has 20d left — but refreshing re-arms both
    // deadlines, so the replacement cookie is a full 30d from that moment (= now + 40d).
    h.setNow(now + 10 * DAY * 1000);
    const app = buildApp(h.deps);
    const res = await app.request("/auth/refresh", jsonInit({}, { cookie: `dub_session=${created.token}` }));
    expect(res.status).toBe(200);
    near(maxAgeOf(res.headers.get("set-cookie")), 40 * DAY);
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

  // Clearing the browser cookie is NOT logout: if the token never reaches this handler
  // (the gateway used to strip it) sessions.logout() is a silent no-op and the session
  // stays usable in KV until the 30d absolute TTL. Assert the record is really gone.
  it("cookie path DELETES the session record server-side (not just the browser cookie)", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_bye", "web");
    const key = `session:${created.token}`;
    expect(h.kv.store.has(key)).toBe(true);

    const app = buildApp(h.deps);
    const res = await app.request("/auth/logout", jsonInit({}, { cookie: `dub_session=${created.token}` }));
    expect(res.status).toBe(200);
    expect(h.kv.store.has(key)).toBe(false);
    // Anyone replaying the token afterwards (shared machine, leaked cookie) is rejected.
    expect((await h.deps.sessions.verify(created.token)).valid).toBe(false);
  });

  it("without any credential the session survives — the token MUST reach this handler", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_stay", "web");
    const app = buildApp(h.deps);
    // Exactly what the SPA's logout did while the gateway stripped the cookie: 200 OK,
    // cookie cleared client-side, session still live server-side. Regression anchor for
    // the gateway-side forwardCredentials fix.
    const res = await app.request("/auth/logout", jsonInit({}));
    expect(res.status).toBe(200);
    expect(h.kv.store.has(`session:${created.token}`)).toBe(true);
    expect((await h.deps.sessions.verify(created.token)).valid).toBe(true);
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

// STAGING-ONLY one-click demo login. The route is REGISTERED only when DEMO_AUTOLOGIN=1,
// so with the flag off (production) it does not exist at all (404) — no backdoor.
describe("POST /auth/demo-login (staging-only)", () => {
  it("mints a session for the fixed demo account (no password) when DEMO_AUTOLOGIN=1", async () => {
    // Note: staging runs ENVIRONMENT=production, so the flag alone must enable it.
    const h = makeHarness({ ENVIRONMENT: "production", DEMO_AUTOLOGIN: "1", DEMO_AUTOLOGIN_EMAIL: "demo-admin@developershub.jp" });
    const app = buildApp(h.deps);
    const res = await app.request("/auth/demo-login", jsonInit({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; session: { userId: string } };
    expect(body.token).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain("dub_session=");
    // it resolved via the roster allowlist for the configured demo email
    expect(h.identity.lookupCalls).toContain("demo-admin@developershub.jp");
  });

  it("does NOT exist (404) when DEMO_AUTOLOGIN is unset — production has no backdoor", async () => {
    const h = makeHarness({ ENVIRONMENT: "production" }); // DEMO_AUTOLOGIN not set
    const app = buildApp(h.deps);
    const res = await app.request("/auth/demo-login", jsonInit({}));
    expect(res.status).toBe(404);
  });

  it("still rejects when the demo account is not an active roster user", async () => {
    const h = makeHarness({ DEMO_AUTOLOGIN: "1" });
    h.identity.lookupUser = null; // demo email not on the allowlist
    const app = buildApp(h.deps);
    const res = await app.request("/auth/demo-login", jsonInit({}));
    expect(res.status).toBe(403);
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
