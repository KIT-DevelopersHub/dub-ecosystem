// The tests that make the policy layer self-enforcing for usage-meter.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match exactly,
//     in both directions. This is what turns "I added an endpoint and forgot the table line"
//     from a silent hole into a red build; the second case proves it by actually adding an
//     ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any future
//     table edit that loosens a permission shows up as an added line in the diff of this file.
//  3. RUNTIME — the key-gated dashboard read (401 / 403 / 200) and the four INTERNAL routes
//     (marker present vs absent), end to end through the real app.
//
// The reachability tests go through @dub/policy-gate's own `allows` / `protectableRouteKeys`,
// i.e. the exact comparison the gate runs in production — never a test-local re-reading.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PermissionGranter, RouteRule } from "@dub/policy-gate";
import { HDR_INTERNAL, HDR_USER_ID } from "@dub/observability";
import type { identity } from "@dub/types";
import { makeD1 } from "./d1";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import type { Env } from "../src/env";
import type { UsageSummary } from "../src/types";

// A granter that holds exactly `keys` — the gate's port, so no authz logic is faked, only the
// answer identity-roster would have given.
const holding =
  (...keys: identity.PermissionKey[]): PermissionGranter =>
  async (_userId, _orgId, requested) =>
    requested.filter((k) => keys.includes(k));

const allowAll: PermissionGranter = async (_u, _o, requested) => [...requested];
const denyAll: PermissionGranter = async () => [];

function buildApp(authz: PermissionGranter = allowAll) {
  return createApp({ authz });
}

// Every binding on Env is optional, so `{}` is a valid env; the DB-backed cases pass a real one.
const NO_BINDINGS = {} as Env;
const withDb = (): Env => ({ DB: makeD1().d1 });

const S2S = { [HDR_INTERNAL]: "1" };
// The most privileged thing that can arrive from OUTSIDE: api-gateway strips every inbound
// x-dub-* and re-adds only the user id, so an external request can never carry the marker.
const EXTERNAL = { [HDR_USER_ID]: "user_admin" };

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/usage/snapshots", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /usage/snapshots"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/usage\/snapshots/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.request("/usage/snapshots", { headers: EXTERNAL }, NO_BINDINGS);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// The usage-relevant grants of each system role, per the identity migrations that define them:
//   0007 (domain key: ALL FOUR roles get usage:view),
//   0008 (per-app tier: admin 編集, maintainer/organizer/member 閲覧 on the usage app).
// The last two rows are not roles but the two shapes the table was written to make meaningful.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:usage:view", "app:usage:edit", "usage:view"],
  maintainer: ["app:usage:view", "usage:view"],
  organizer: ["app:usage:view", "usage:view"],
  member: ["app:usage:view", "usage:view"],
  // 無料枠/課金ガード = 無効 in ロール管理, but the role still carries the domain key. Before the
  // gate `requireAuth()` let this read anyway; the tier now denies it outright.
  "disabled-tier-with-legacy-usage-key": ["usage:view"],
  // The app tier is 閲覧 but usage:view was unchecked in ロール管理's 詳細設定. That checkbox
  // decided nothing before this table; it decides now.
  "view-tier-without-detail-key": ["app:usage:view"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the reachability
 * question for every rule form, so the four INTERNAL routes correctly land in no role's set.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const DASHBOARD = ["GET /usage/summary"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /", "GET /internal/health", "POST /internal/meter/kick", "POST /internal/meter/refresh"];
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: DASHBOARD,
    maintainer: DASHBOARD,
    organizer: DASHBOARD,
    member: DASHBOARD,
    "disabled-tier-with-legacy-usage-key": NONE,
    "view-tier-without-detail-key": NONE,
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]));
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = [...INTERNAL_ROUTES, ...DASHBOARD].sort();
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(buildApp()).sort());
  });

  it("a caller holding nothing reaches nothing — there is no public route here", () => {
    expect(allowedRoutes([])).toEqual(NONE);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });
});

// The key-gated route at runtime. This is the behaviour change the migration introduces:
// `requireAuth()` alone used to admit every signed-in user; now the ロール管理 tier for the
// 無料枠/課金ガード app plus usage:view decide.
describe("GET /usage/summary (appLevel('usage','view') + usage:view)", () => {
  it("401s with no session at all (the trusted header is absent)", async () => {
    const res = await buildApp().request("/usage/summary", {}, withDb());
    expect(res.status).toBe(401);
  });

  it("403s a signed-in caller who holds neither key", async () => {
    const res = await buildApp(denyAll).request("/usage/summary", { headers: EXTERNAL }, withDb());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { reason: string; missing: string[] } } };
    expect(body.error.details.reason).toBe("missing_permission");
    expect(body.error.details.missing.sort()).toEqual(["app:usage:view", "usage:view"]);
  });

  it("403s the 無効-tier role that still carries usage:view (the bug this table closes)", async () => {
    const res = await buildApp(holding("usage:view")).request("/usage/summary", { headers: EXTERNAL }, withDb());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { missing: string[] } } };
    expect(body.error.details.missing).toEqual(["app:usage:view"]);
  });

  it("403s the 閲覧-tier role whose usage:view detail key is unchecked", async () => {
    const res = await buildApp(holding("app:usage:view")).request("/usage/summary", { headers: EXTERNAL }, withDb());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { missing: string[] } } };
    expect(body.error.details.missing).toEqual(["usage:view"]);
  });

  it("serves the dashboard contract to a caller holding both keys", async () => {
    const res = await buildApp(holding("app:usage:view", "usage:view")).request(
      "/usage/summary",
      { headers: EXTERNAL },
      withDb(),
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as UsageSummary;
    expect(Array.isArray(summary.services)).toBe(true);
    expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("fails closed (5xx) when SVC_IDENTITY is unbound — never a quiet allow", async () => {
    // `createApp()` with no authz override is the production wiring; with no binding the
    // granter throws, exactly as the removed requireViewer did for the same cause.
    const res = await createApp().request("/usage/summary", { headers: EXTERNAL }, withDb());
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// The INTERNAL rules at runtime: a Service-Binding call passes; the same request without the
// marker — i.e. anything that could arrive from outside — is refused.
describe("the four INTERNAL routes at runtime", () => {
  it("answer a service-to-service call carrying x-dub-internal", async () => {
    const app = buildApp();
    expect((await app.request("/internal/health", { headers: S2S }, NO_BINDINGS)).status).toBe(200);
    expect(await (await app.request("/", { headers: S2S }, NO_BINDINGS)).text()).toBe("usage-meter");
    // METER_DO / DB are unbound here, so each handler's own 503 proves the gate let it through.
    for (const path of ["/internal/meter/kick", "/internal/meter/refresh"]) {
      expect((await app.request(path, { method: "POST", headers: S2S }, NO_BINDINGS)).status).toBe(503);
    }
  });

  it("403 internal_only without the marker, however privileged the caller", async () => {
    const app = buildApp();
    for (const [path, method] of [
      ["/internal/health", "GET"],
      ["/", "GET"],
      ["/internal/meter/kick", "POST"],
      ["/internal/meter/refresh", "POST"],
    ] as const) {
      const res = await app.request(path, { method, headers: EXTERNAL }, NO_BINDINGS);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { details: { reason: string } } };
      expect(body.error.details.reason).toBe("internal_only");
    }
  });
});
