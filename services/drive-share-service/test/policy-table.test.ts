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
import type { identity } from "@dub/types";
import type { RouteRule } from "@dub/policy-gate";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { allowAll, AUTHED, buildRoleGrants, fakeRoster, stubGoogleAccount } from "./helpers";
import type { PermissionGranter } from "@dub/policy-gate";

function buildApp(authz: PermissionGranter = allowAll) {
  const client = createMockDriveShareClient();
  const service = createDriveShareService({ client, config: { listPageSize: 50 } });
  const { service: roleGrants } = buildRoleGrants({
    drive: client,
    roster: fakeRoster({ role_sys_member: ["staff-a@example.com"] }, { role_sys_member: "member" }),
  });
  return createApp({ service, roleGrants, authz, googleAccount: stubGoogleAccount() });
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/driveshare/files/:id/audit", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /driveshare/files/:id/audit"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/driveshare\/files\/:id\/audit/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.request("/driveshare/files/fld_root/audit", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// Drive-relevant grants of each system role, per the identity migrations that define them:
//   0002 (domain keys: maintainer gets drive:read/write), 0005 (admin gets drive:read/write),
//   0008 (per-app tier: admin/maintainer 編集, organizer/member 閲覧).
// The last two rows are not roles but the two legacy shapes the table was written to fix.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write", "identity:admin"],
  maintainer: ["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write"],
  organizer: ["app:driveshare:view"],
  member: ["app:driveshare:view"],
  // Drive共有 = 無効 in ロール管理, but the role still carries the legacy domain keys. Before
  // the gate this wrote through the API anyway; the tier now denies it outright.
  "disabled-tier-with-legacy-drive-keys": ["drive:read", "drive:write"],
  // Drive共有 = 閲覧 holding a legacy drive:write. Reads only — the tier is authoritative.
  "view-tier-with-legacy-write-key": ["app:driveshare:view", "drive:read", "drive:write"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so an internal-only route (`INTERNAL` or
 * `internalWithKeys`) correctly lands in no role's set — permission keys never open one to a
 * request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const READS = [
  "GET /driveshare/files",
  "GET /driveshare/files/:id/permissions",
  "GET /driveshare/files/:id/role-grants",
  "GET /driveshare/role-grants",
];
const WRITES = [
  "DELETE /driveshare/files/:id/permissions/:permId",
  "DELETE /driveshare/files/:id/role-grants/:roleId",
  "PATCH /driveshare/files/:id/permissions/:permId",
  "POST /driveshare/files/:id/permissions",
  "POST /driveshare/files/:id/role-grants",
  "POST /driveshare/files/:id/role-grants/:roleId/reapply",
  "PUT /driveshare/files/:id/link",
];
// Switching the Google account the service acts as: system admin only (identity:admin).
const ADMIN_ONLY = [
  "GET /driveshare/google-account",
  "POST /driveshare/google-account/callback",
  "POST /driveshare/google-account/connect",
];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /internal/health"];
// The whole external surface — what a caller can reach through api-gateway at most.
const FULL = [...READS, ...WRITES, ...ADMIN_ONLY].sort();
const OPERATOR = [...READS, ...WRITES].sort();
const READ_ONLY = [...READS].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: OPERATOR,
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

// The INTERNAL rule at runtime, end to end through the real app: a Service-Binding probe
// (app-health-monitor sends exactly these headers) passes; the same request without the
// marker — i.e. anything that could arrive from outside, since api-gateway strips every
// inbound x-dub-* — is refused.
describe("GET /internal/health (INTERNAL)", () => {
  const S2S = { "x-dub-internal": "1" };

  it("answers a service-to-service probe carrying x-dub-internal", async () => {
    const res = await buildApp().request("/internal/health", { headers: S2S });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "drive-share-service" });
  });

  it("403s without the marker, even for an authenticated caller holding everything", async () => {
    const res = await buildApp().request("/internal/health", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "internal_only",
    );
  });
});
