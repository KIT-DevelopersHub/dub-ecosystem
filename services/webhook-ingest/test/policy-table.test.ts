// The two tests that make the policy layer self-enforcing for this service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "member can now read deliveries" without reading the table.
//
// Both go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import type { RouteRule } from "@dub/policy-gate";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { FakeRepo, allowAll, AUTHED, fakeEnv } from "./helpers";

function buildApp() {
  const repo = new FakeRepo();
  return createApp({ buildRepo: () => repo, granted: allowAll });
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/webhooks/secrets", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /webhooks/secrets"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/webhooks\/secrets/);

    // Fail-closed, not fail-open: unreachable even for a caller the granter grants everything.
    const res = await app.fetch(new Request("https://hooks/webhooks/secrets", { headers: AUTHED }), fakeEnv());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// Webhook-relevant grants of each system role, per the identity migrations that define them:
//   0002 (maintainer gets webhook:read), 0005 (admin gets webhook:read). organizer and member
// are granted no webhook key by any migration. There is no `app:webhooks:*` tier to pair them
// with — APP_MANIFEST has no webhooks app (inventory 3.(c)) — so the domain key is the whole
// rule and this matrix is the whole story.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["webhook:read"],
  maintainer: ["webhook:read"],
  organizer: [],
  member: [],
  // Not a role: the anonymous provider (GitHub / Google / Stripe) that POSTs the ingress.
  "unauthenticated-provider": [],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so the INTERNAL route correctly lands in no
 * role's set — permission keys never open one to a request arriving from outside.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

// Open to the internet by design: the provider ingress pair. Reachable by EVERYONE, including
// a caller holding nothing — which is the honest answer a matrix should show, not hide.
const PUBLIC_ROUTES = ["GET /hooks/:source", "POST /hooks/:source"];
// Administrative delivery search: webhook:read.
const ADMIN_READS = ["GET /webhooks/deliveries", "GET /webhooks/deliveries/:id"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /internal/health"];

const WITH_WEBHOOK_READ = [...PUBLIC_ROUTES, ...ADMIN_READS].sort();
const PUBLIC_ONLY = [...PUBLIC_ROUTES].sort();

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: WITH_WEBHOOK_READ,
    maintainer: WITH_WEBHOOK_READ,
    organizer: PUBLIC_ONLY,
    member: PUBLIC_ONLY,
    "unauthenticated-provider": PUBLIC_ONLY,
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = [...INTERNAL_ROUTES, ...WITH_WEBHOOK_READ].sort();
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(buildApp()).sort());
  });

  it("the delivery reads are the ONLY thing a permission key buys here", () => {
    expect(allowedRoutes(["webhook:read"]).filter((r) => !PUBLIC_ONLY.includes(r))).toEqual(ADMIN_READS);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });
});
