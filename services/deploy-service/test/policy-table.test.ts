// The two tests that make the policy layer self-enforcing for deploy-service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire. This is
//     the ecosystem's only strong-privilege executor, so an unlisted route here is the
//     worst-case version of that mistake.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "organizer can now deploy" without reading the table.
//
// Both go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { makeTestDeps, DUMMY_ENV, req, type TestDeps } from "./helpers";

const ADMIN = "usr_admin";

const PERMS: Record<string, string[]> = {
  [ADMIN]: ["infra:read", "infra:deploy", "infra:dns", "infra:admin"],
};

function buildApp(deps: TestDeps = makeTestDeps({ perms: PERMS })) {
  return createApp(() => deps);
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.post("/deploy/sites/:id/rollback", (c) => c.json({ rolled_back: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["POST /deploy/sites/:id/rollback"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/POST \/deploy\/sites\/:id\/rollback/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every infra key.
    const res = await app.fetch(req("/deploy/sites/site_1/rollback", { method: "POST", userId: ADMIN }), DUMMY_ENV);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// The infra grants of each system role, per infra/d1/migrations/identity/0002_system_roles.sql:
// admin holds all four keys; maintainer holds infra:read + infra:deploy but deliberately NOT
// infra:dns / infra:admin ("full operational power, no org administration"); organizer holds
// infra:read only; member holds none.
//
// The last row is the reason this table does NOT use appLevel("lp", ...): app:lp:view/edit
// are granted to role_sys_admin ONLY (migration 0009), so pairing these routes with the
// LP管理 tier would silently revoke maintainer's deploy right and organizer's read right.
// The row proves the current rules are tier-independent — see src/policy-table.ts.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["infra:read", "infra:deploy", "infra:dns", "infra:admin", "app:lp:view", "app:lp:edit"],
  maintainer: ["infra:read", "infra:deploy"],
  organizer: ["infra:read"],
  member: [],
  "maintainer-without-the-lp-app-tier": ["infra:read", "infra:deploy"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so the INTERNAL health route correctly lands in
 * no role's set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const READS = [
  "GET /deploy/deployments",
  "GET /deploy/deployments/:id",
  "GET /deploy/domains",
  "GET /deploy/sites",
];
const DEPLOY = ["POST /deploy/deployments"];
const DNS = ["POST /deploy/dns/records"];
const SITE_ADMIN = ["POST /deploy/sites"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /health"];
const FULL = [...READS, ...DEPLOY, ...DNS, ...SITE_ADMIN].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    // Operational: may deploy, may not register a site or touch DNS.
    maintainer: [...READS, ...DEPLOY].sort(),
    organizer: [...READS].sort(),
    member: NONE,
    "maintainer-without-the-lp-app-tier": [...READS, ...DEPLOY].sort(),
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

// The rules at runtime, end to end through the real app and the real granter.
describe("the gate in front of the real handlers", () => {
  it("answers the app-health-monitor probe carrying x-dub-internal", async () => {
    const res = await buildApp().fetch(
      new Request("https://svc/health", { headers: { "x-dub-request-id": "req_probe", "x-dub-internal": "1" } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "deploy-service" });
  });

  it("403s the health probe without the marker, even for a caller holding every infra key", async () => {
    const res = await buildApp().fetch(req("/health", { userId: ADMIN }), DUMMY_ENV);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "internal_only",
    );
  });

  it("the internal marker buys no key: an s2s call still cannot deploy", async () => {
    const res = await buildApp().fetch(
      new Request("https://svc/deploy/deployments", {
        method: "POST",
        headers: { "x-dub-request-id": "req_s2s", "x-dub-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ siteId: "site_1" }),
      }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(401); // no actor to attribute infra:deploy to
  });

  it("names the missing key in the 403 and never reaches the handler", async () => {
    const deps = makeTestDeps({ perms: { ...PERMS, usr_reader: ["infra:read"] } });
    const res = await buildApp(deps).fetch(
      req("/deploy/dns/records", {
        method: "POST",
        userId: "usr_reader",
        body: { zone: "zone_hp", type: "A", name: "x.example", content: "1.2.3.4" },
      }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { missing: string[] } } };
    expect(body.error.details.missing).toEqual(["infra:dns"]);
    // Denied before any side effect: no audit intent, no CF call (design §6 ordering).
    expect(deps.audit.recordIntent).not.toHaveBeenCalled();
    expect(deps.cf.createDnsRecord).not.toHaveBeenCalled();
  });

  // The gate's `userId` variable is what reqCtx() now attributes audit records to (it used
  // to come from auth-client's authn context). If that wiring breaks, every audit record
  // silently becomes actorId: null — so assert the actor explicitly.
  it("publishes the authenticated actor to the handlers (audit records keep their actorId)", async () => {
    const deps = makeTestDeps({ perms: PERMS });
    const site = await deps.repo.createSite({
      name: "hp",
      domain: null,
      cfProjectName: "hp",
      zoneId: null,
      defaultBranch: "main",
      createdBy: ADMIN,
    });
    const res = await buildApp(deps).fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(202);
    expect(deps.audit.intents[0]!.actorId).toBe(ADMIN);
    expect(deps.audit.intents[0]!.ctx.userId).toBe(ADMIN);
    expect(deps.repo.deployments[0]!.requestedBy).toBe(ADMIN);
  });
});
