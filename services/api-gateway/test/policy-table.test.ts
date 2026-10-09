// The tests that make the policy layer self-enforcing for api-gateway. Four jobs, and the
// last two exist only because this service is the edge:
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, both directions. Turns "I added a gateway-owned route and forgot the table
//     line" from a silent hole into a red build (and the runtime deny is asserted too).
//  2. ROLE x ENDPOINT MATRIX — the reachable route set per key set, frozen, so any future
//     loosening is a visible diff here.
//  3. THE CATCH-ALL IS NOT A LOOPHOLE — the proxy mount must stay a pass-through while every
//     gateway-OWNED route stays gated, and no endpoint may be registered with `app.all`
//     (inventory 4.4). Pinned mechanically rather than trusted as a convention.
//  4. THE EDGE TRUSTS NO HEADER — `x-dub-user-id` is attacker-controlled here, so a spoofed
//     one must authorize nothing. This is the test that makes mounting a header-based gate
//     at the internet boundary safe.
//
// Everything goes through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the
// exact comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PermissionGranter, RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { API_PREFIX, GATEWAY_OWNED_SEGMENTS, ROUTES, firstSegment, stripApiPrefix } from "../src/routes";
import { authBinding, errOf, execCtx, fakeBinding, fakeQueue, json, makeEnv, validSession } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

/** Records what the gate asked identity, and grants only `held`. */
function spyAuthz(held: identity.PermissionKey[] = []) {
  const calls: { userId: string; orgId: string; keys: readonly identity.PermissionKey[] }[] = [];
  const granted: PermissionGranter = async (userId, orgId, keys) => {
    calls.push({ userId, orgId, keys });
    return keys.filter((k) => held.includes(k));
  };
  return { granted, calls };
}

function buildApp(authz?: PermissionGranter) {
  return createApp(authz ? { ...NO_RL, authz } : NO_RL);
}

/** Env with a working session verify (so only authorization is under test). */
function authedEnv(userId = "usr_1", overrides: Parameters<typeof makeEnv>[0] = {}) {
  return makeEnv({ SVC_AUTH: authBinding(validSession(userId)).fetcher, ...overrides });
}

const BEARER = { authorization: "Bearer sess-tok" };

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every gateway-owned endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new gateway-owned endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a gateway-owned route with no rule.
    app.get(`${API_PREFIX}/me/secrets`, (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /api/v1/me/secrets"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/api\/v1\/me\/secrets/);

    // Fail-closed, not fail-open: unreachable even for a caller with a valid session. Note
    // it does NOT fall through to the proxy either — a concrete method always wins the match.
    const res = await app.fetch(new Request(`https://x${API_PREFIX}/me/secrets`, { headers: BEARER }), authedEnv(), execCtx);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });

  it("the table's keys are the real external paths (prefix drift lock)", () => {
    // Keys are written literally for readability; this pins the prefix they were written
    // against, so changing API_PREFIX fails here with a clear reason as well as in coverage.
    expect(API_PREFIX).toBe("/api/v1");
    for (const key of Object.keys(POLICY_TABLE)) {
      const path = key.slice(key.indexOf(" ") + 1);
      if (path === "/healthz") continue; // root-mounted probe, deliberately outside the prefix
      expect(path.startsWith(`${API_PREFIX}/`)).toBe(true);
      // ...and every one of them lives under a segment the gateway OWNS.
      expect(GATEWAY_OWNED_SEGMENTS.has(firstSegment(stripApiPrefix(path)!))).toBe(true);
    }
  });
});

// ── the catch-all: pass-through for proxied routes, no cover for owned ones ──
describe("the /api/v1/* proxy mount is a pass-through, not a gate bypass", () => {
  it("registers NO endpoint with app.all (inventory 4.4 — the gate cannot see those)", () => {
    // `app.all(path, handler)` is recorded exactly like `app.use(path, mw)`, so an ENDPOINT
    // registered that way would skip the gate. The proxy mount is the sole deliberate ALL
    // registration and is middleware-shaped (path ends in "/*" or is "*"), which is why it
    // never appears as a protectable endpoint here.
    expect(protectableRouteKeys(buildApp()).filter((k) => k.startsWith("ALL "))).toEqual([]);
  });

  it("pins the deliberate ALL mounts, so a new app.all endpoint fails CI by name", () => {
    const allPaths = [...new Set(buildApp().routes.filter((r) => r.method.toUpperCase() === "ALL").map((r) => r.path))].sort();
    // "/*"         = the app.use("*") middlewares (cors/requestId/rateLimit/policyGate) and
    //                the final 404 thrower, all app-wide by design. Hono normalises the "*"
    //                these are registered with to "/*", which `isMiddlewareMount` matches on
    //                its `endsWith("/*")` arm.
    // "/api/v1/*"  = the transparent proxy mount (see src/policy-table.ts for why it is not
    //                a table entry). Anything else here is an ungated endpoint — add a
    //                concrete method (app.get/post/...) and a POLICY_TABLE line instead.
    expect(allPaths).toEqual(["/*", "/api/v1/*"]);
  });

  it("forwards a proxied route without consulting the table (the downstream decides)", async () => {
    const authz = spyAuthz(["identity:admin"]); // would grant anything, if it were asked
    const task = fakeBinding(() => json(200, { ok: true }));
    const res = await buildApp(authz.granted).fetch(
      new Request(`https://x${API_PREFIX}/tasks/t_1`, { headers: BEARER }),
      authedEnv("usr_1", { SVC_TASK: task.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(task.requests).toHaveLength(1);
    // No key check happened at the edge: task-service's own table owns that decision.
    expect(authz.calls).toEqual([]);
  });

  it("never proxies a gateway-owned segment — an unmatched owned path is a 404, not a forward", async () => {
    // GATEWAY_OWNED_SEGMENTS is enforced in gateway-route.ts, so even if a ROUTES entry were
    // added for an owned segment the admin/me surface could not be reached through the proxy.
    for (const r of ROUTES) expect(GATEWAY_OWNED_SEGMENTS.has(r.segment)).toBe(false);

    const drive = fakeBinding(() => json(200, { ok: true }));
    const res = await buildApp().fetch(
      new Request(`https://x${API_PREFIX}/admin/users`, { headers: BEARER }),
      authedEnv("usr_1", { SVC_DRIVE_PROXY: drive.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(404);
    expect((await errOf(res)).code).toBe("GATEWAY_ROUTE_NOT_FOUND");
  });
});

// ── the edge trusts no inbound header ──
describe("the actor comes from the session, never from x-dub-user-id", () => {
  const SPOOFED = { "x-dub-user-id": "usr_admin" };

  it("401s an AUTHENTICATED route whose caller only spoofs the trusted header", async () => {
    const res = await buildApp().fetch(new Request(`https://x${API_PREFIX}/me`, { headers: SPOOFED }), authedEnv(), execCtx);
    expect(res.status).toBe(401);
    expect((await errOf(res)).code).toBe("UNAUTHENTICATED");
  });

  it("401s the admin password route on a spoofed header, without asking identity anything", async () => {
    const authz = spyAuthz(["identity:admin"]); // the victim really is an admin
    const authSvc = fakeBinding(() => json(200, { ok: true, password: "leaked" }));
    const res = await buildApp(authz.granted).fetch(
      new Request(`https://x${API_PREFIX}/admin/users/usr_target/password`, { headers: SPOOFED }),
      makeEnv({ SVC_AUTH: authSvc.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(401);
    // The permission check is never even reached, and auth-service is never asked for a
    // password: a forged header buys nothing at the edge.
    expect(authz.calls).toEqual([]);
    expect(authSvc.requests.filter((r) => new URL(r.url).pathname.includes("/password"))).toHaveLength(0);
  });

  it("asks identity for identity:admin with the SESSION's id, and 403s when it is absent", async () => {
    const authz = spyAuthz([]); // signed in, but not an admin
    const res = await buildApp(authz.granted).fetch(
      new Request(`https://x${API_PREFIX}/admin/users/usr_target/password`, { headers: { ...BEARER, ...SPOOFED } }),
      authedEnv("usr_member"),
      execCtx,
    );
    expect(res.status).toBe(403);
    expect((await errOf(res)).details).toMatchObject({ reason: "missing_permission", missing: ["identity:admin"] });
    // The subject is the verified session user — NOT the spoofed header value.
    expect(authz.calls).toEqual([{ userId: "usr_member", orgId: "org_devhub", keys: ["identity:admin"] }]);
  });
});

// ── public routes keep working without a session (the LP) ──
describe("PUBLIC routes need no session and cost no verify", () => {
  it("GET /healthz answers with no credentials at all", async () => {
    const res = await buildApp().fetch(new Request("https://x/healthz"), makeEnv(), execCtx);
    expect(res.status).toBe(200);
  });

  it("POST /api/v1/public/inquiries is accepted unauthenticated, and auth-service is not called", async () => {
    const authSvc = fakeBinding(() => json(200, validSession()));
    const { queue } = fakeQueue();
    const app = createApp({ ...NO_RL, turnstile: async () => true });
    const res = await app.fetch(
      new Request(`https://x${API_PREFIX}/public/inquiries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "sponsor", name: "Bob", email: "bob@example.com", message: "hello", turnstileToken: "tok" }),
      }),
      makeEnv({ SVC_AUTH: authSvc.fetcher, EVT_NOTIFICATION: queue }),
      execCtx,
    );
    expect(res.status).toBe(200);
    // PUBLIC resolves no actor, so the gate adds no verify subrequest to a public form post.
    expect(authSvc.requests).toHaveLength(0);
  });

  it("POST /api/v1/public/participation is accepted unauthenticated", async () => {
    const member = fakeBinding(() => json(200, { accepted: true, matchKind: "none" }));
    const app = createApp({ ...NO_RL, turnstile: async () => true });
    const res = await app.fetch(
      new Request(`https://x${API_PREFIX}/public/participation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lastName: "山田",
          firstName: "太郎",
          schoolEmail: "taro@school.ac.jp",
          gmail: "taro@gmail.com",
          phone: "090-1111-2222",
          grade: "3",
          department: "情報工学科",
          desiredActivity: "dev",
          turnstileToken: "tok",
        }),
      }),
      makeEnv({ SVC_MEMBER: member.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);
  });
});

// ── a-5: drive's internal-only routes are 404'd at the edge (double defense) ──
describe("drive internal-only paths 404 at the edge (inventory a-5)", () => {
  const INTERNAL_DRIVE: [string, string][] = [
    ["GET", "/drive/health/quota"],
    ["POST", "/drive/watch"],
    ["POST", "/drive/watch/ch_1/stop"],
  ];

  it("never forwards them, whatever the caller holds", async () => {
    for (const [method, path] of INTERNAL_DRIVE) {
      const drive = fakeBinding(() => json(200, { leaked: true }));
      const res = await buildApp().fetch(
        new Request(`https://x${API_PREFIX}${path}`, { method, headers: BEARER }),
        authedEnv("usr_1", { SVC_DRIVE_PROXY: drive.fetcher }),
        execCtx,
      );
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await errOf(res)).code).toBe("GATEWAY_ROUTE_NOT_FOUND");
      expect(drive.requests, `${method} ${path} must not reach drive-proxy`).toHaveLength(0);
    }
  });

  it("still forwards the external drive routes (the guard is not over-broad)", async () => {
    const drive = fakeBinding(() => json(200, { ok: true }));
    const res = await buildApp().fetch(
      new Request(`https://x${API_PREFIX}/drive/files`, { headers: BEARER }),
      authedEnv("usr_1", { SVC_DRIVE_PROXY: drive.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(drive.requests).toHaveLength(1);
  });
});

// ── role x endpoint matrix ──
// NOTE on reading this matrix: `allows` answers "do these KEYS suffice", which is `true` for
// AUTHENTICATED whatever the key set — the honest answer to "which roles can reach /me" is
// "all of them" (rule.ts). An empty key set therefore means "signed in, holds nothing", NOT
// an anonymous caller; anonymous access is a 401 and is covered by the runtime tests above.
const KEY_SETS: Record<string, identity.PermissionKey[]> = {
  "admin (identity:admin)": ["identity:admin"],
  "member (identity:read, app:members:view)": ["identity:read", "app:members:view"],
  "signed-in holding nothing": [],
};

function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const PUBLIC_ROUTES = [
  "GET /healthz",
  "POST /api/v1/public/inquiries",
  "POST /api/v1/public/lp-visits",
  "POST /api/v1/public/participation",
];
const SELF_ROUTES = [
  "GET /api/v1/bff/home",
  "GET /api/v1/me",
  "GET /api/v1/me/participation",
  "GET /api/v1/me/profile",
  "POST /api/v1/me/participation",
  "POST /api/v1/me/password",
  "POST /api/v1/me/profile",
];
const ADMIN_ROUTES = ["GET /api/v1/admin/users/:userId/password", "POST /api/v1/admin/users/:userId/password"];

const EVERYONE = [...PUBLIC_ROUTES, ...SELF_ROUTES].sort();
const WITH_ADMIN = [...PUBLIC_ROUTES, ...SELF_ROUTES, ...ADMIN_ROUTES].sort();

describe("role x endpoint matrix (frozen)", () => {
  it("matches the committed matrix for every key set", () => {
    expect(Object.fromEntries(Object.entries(KEY_SETS).map(([role, keys]) => [role, allowedRoutes(keys)]))).toEqual({
      "admin (identity:admin)": WITH_ADMIN,
      "member (identity:read, app:members:view)": EVERYONE,
      "signed-in holding nothing": EVERYONE,
    });
  });

  it("the matrix covers the whole table and the whole router (nothing omitted)", () => {
    expect(WITH_ADMIN).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(WITH_ADMIN).toEqual(protectableRouteKeys(buildApp()).sort());
  });

  it("the password surface is the only key-gated pair, and no /me route takes a subject id", () => {
    const gated = Object.entries(POLICY_TABLE)
      .filter(([, rule]) => Array.isArray(rule))
      .map(([route]) => route)
      .sort();
    expect(gated).toEqual(ADMIN_ROUTES);
    // The AUTHENTICATED guard rail from rule.ts, enforced: a route whose path names a subject
    // can never be self-scoped, so it must not be AUTHENTICATED.
    for (const route of SELF_ROUTES) expect(route).not.toMatch(/:/);
  });
});
