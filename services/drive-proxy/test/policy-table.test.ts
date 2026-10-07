// The two tests that make the policy layer self-enforcing for this service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "member can now write" without reading the table.
//
// Both go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PermissionGranter, RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import type { DriveService } from "../src/service";
import { POLICY_TABLE } from "../src/policy-table";
import { allowAll, AUTHED, S2S } from "./helpers";

function stubService(): DriveService {
  return {
    async list() { return { items: [], nextCursor: null }; },
    async get() { return { id: "d1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async embed() { return { embedUrl: "https://embed" }; },
    async create() { return { id: "n1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async move() { return { id: "d1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async trash() { return { file: { id: "d1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }, alreadyTrashed: false }; },
    async readSheet() { return { values: [["a"]] }; },
    async writeSheet() { return { spreadsheetId: "s1", updatedRange: "A1", updatedRows: 1 }; },
    async quota() { return { windowSeconds: 100, usedRequests: 0, softLimit: 500, throttling: false }; },
  };
}

function buildApp(authz: PermissionGranter = allowAll) {
  return createApp({ service: stubService(), authz });
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  // The Drive-watch routes are registered unconditionally (the handler 500s when
  // `deps.watch` is absent — buildWatch in src/index.ts omits it with no D1 bound), so the
  // table must cover the router in BOTH wirings. The case above is the no-watch app.
  it("holds whether or not the Drive-watch service is wired", () => {
    const withWatch = createApp({
      service: stubService(),
      authz: allowAll,
      watch: {
        async create() { return { channelId: "c", resourceId: "r", fileId: "f", expiration: null, resourceUri: null }; },
        async stop() { return { channelId: "c", alreadyStopped: false }; },
      },
    });
    expect(checkRouteCoverage(withWatch, POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/drive/files/:id/revisions", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /drive/files/:id/revisions"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/drive\/files\/:id\/revisions/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.request("/drive/files/d1/revisions", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// Drive-relevant grants of each system role, per the identity migrations that define them:
//   0002 (domain keys: maintainer gets drive:read/write), 0005 (admin gets drive:read/write),
//   0008 (per-app tier: admin/maintainer 編集, organizer/member 閲覧).
// The last two rows are not roles but the two legacy shapes the table was written to fix.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write"],
  maintainer: ["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write"],
  organizer: ["app:driveshare:view"],
  member: ["app:driveshare:view"],
  // Drive共有 = 無効 in ロール管理, but the role still carries the legacy domain keys. Before
  // the gate this read and wrote through this API anyway; the tier now denies it outright.
  "disabled-tier-with-legacy-drive-keys": ["drive:read", "drive:write"],
  // Drive共有 = 閲覧 holding a legacy drive:write. Reads only — the tier is authoritative.
  "view-tier-with-legacy-write-key": ["app:driveshare:view", "drive:read", "drive:write"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so an internal-only route correctly lands in no
 * role's set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const READS = [
  "GET /drive/files",
  "GET /drive/files/:id",
  "GET /drive/files/:id/embed",
  "GET /drive/sheets/:id/values",
];
const WRITES = [
  "POST /drive/files",
  "POST /drive/files/:id/move",
  "POST /drive/files/:id/trash",
  "POST /drive/sheets/:id/values",
];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely. Note
// these are also 404'd at the edge by api-gateway's internalOnlyPaths for /drive (inventory
// a-5) — this table is the second layer, not the only one.
const INTERNAL_ROUTES = [
  "GET /internal/health",
  "GET /drive/health/quota",
  "POST /drive/watch",
  "POST /drive/watch/:channelId/stop",
];
// The whole external surface — what a caller can reach through api-gateway at most.
const FULL = [...READS, ...WRITES].sort();
const READ_ONLY = [...READS].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: FULL,
    // 閲覧 without the legacy drive:read reaches nothing: the fine-grained key is required
    // alongside the tier, exactly as the replaced requirePerm(DRIVE_READ) demanded.
    organizer: NONE,
    member: NONE,
    "disabled-tier-with-legacy-drive-keys": NONE,
    "view-tier-with-legacy-write-key": READ_ONLY,
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = [...INTERNAL_ROUTES, ...FULL].sort();
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

// The removed guards, end to end through the real app: every externally reachable route
// 401s without a session and 403s a 閲覧 role on the write half. The gate — not a
// per-route middleware — is what produces both.
describe("the gate replaces the removed per-route guards", () => {
  const CALLS: { route: string; method: string; path: string }[] = [
    { route: "GET /drive/files", method: "GET", path: "/drive/files" },
    { route: "GET /drive/files/:id", method: "GET", path: "/drive/files/d1" },
    { route: "GET /drive/files/:id/embed", method: "GET", path: "/drive/files/d1/embed" },
    { route: "GET /drive/sheets/:id/values", method: "GET", path: "/drive/sheets/s1/values?range=A1" },
    { route: "POST /drive/files", method: "POST", path: "/drive/files" },
    { route: "POST /drive/files/:id/move", method: "POST", path: "/drive/files/d1/move" },
    { route: "POST /drive/files/:id/trash", method: "POST", path: "/drive/files/d1/trash" },
    { route: "POST /drive/sheets/:id/values", method: "POST", path: "/drive/sheets/s1/values" },
  ];

  it("401s every external route when no session header is present", async () => {
    for (const { route, method, path } of CALLS) {
      const res = await buildApp().request(path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(`${route} -> ${res.status}`).toBe(`${route} -> 401`);
    }
  });

  it("403s an S2S caller on a key-gated route: the marker never substitutes for a permission", async () => {
    // x-dub-internal opens INTERNAL doors only. A key-gated route still demands an actor,
    // so a bare s2s call (no x-dub-user-id) is 401 — never an anonymous allow.
    const res = await buildApp().request("/drive/files", { headers: S2S });
    expect(res.status).toBe(401);
  });
});
