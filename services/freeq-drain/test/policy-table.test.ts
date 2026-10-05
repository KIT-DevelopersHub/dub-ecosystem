// The tests that make the policy layer self-enforcing for freeq-drain.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match exactly,
//     in both directions. This is what turns "I added an endpoint and forgot the table line"
//     from a silent hole into a red build; the second case proves it by actually adding an
//     ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — frozen. This service's table is all-INTERNAL, so the honest
//     frozen matrix is "no permission key, not even the entire catalog, reaches anything".
//     The day someone adds an externally reachable route, this file's diff shows it.
//  3. THE INTERNAL RULE END TO END — a Service-Binding call passes, the same request without
//     the marker is refused, on every one of the three routes.
//
// All three go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import { HDR_INTERNAL, HDR_USER_ID } from "@dub/observability";
import { identity } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import type { Env } from "../src/env";

// Every binding on Env is optional (a missing one degrades rather than crashes), so the empty
// object is a valid env — and the gate runs before any handler touches a binding anyway.
const EMPTY_ENV = {} as Env;

const S2S = { [HDR_INTERNAL]: "1" };
// What an external request can look like at its most privileged: api-gateway strips every
// inbound x-dub-* and re-adds ONLY the user id, so this is the upper bound of what can arrive.
const EXTERNAL = { [HDR_USER_ID]: "user_admin" };

const ROUTES = ["GET /", "GET /internal/health", "POST /internal/drain/kick"] as const;

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(createApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(createApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = createApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/internal/drain/state", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /internal/drain/state"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/internal\/drain\/state/);

    // Fail-closed, not fail-open: unreachable even for a genuine service-to-service caller.
    const res = await app.request("/internal/drain/state", { headers: S2S }, EMPTY_ENV);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the reachability
 * question for every rule form, so an internal-only route correctly lands in no caller's set.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const EVERY_KEY_IN_THE_CATALOG: identity.PermissionKey[] = identity.PERMISSION_CATALOG.map((p) => p.key);

describe("role x endpoint matrix (frozen)", () => {
  it("no caller reaches anything from outside — the whole table is internal-only", () => {
    // Deliberately stronger than a per-role matrix: not "admin cannot", but "a caller holding
    // EVERY key in PERMISSION_CATALOG cannot". INTERNAL is a different axis from permissions,
    // so there is no key, and no combination of keys, that opens one of these doors.
    expect(allowedRoutes(EVERY_KEY_IN_THE_CATALOG)).toEqual([]);
    expect(allowedRoutes([])).toEqual([]);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    expect([...ROUTES].sort()).toEqual(Object.keys(POLICY_TABLE).sort());
    expect([...ROUTES].sort()).toEqual(protectableRouteKeys(createApp()).sort());
  });
});

// The INTERNAL rule at runtime, end to end through the real app: a Service-Binding call passes;
// the same request without the marker — i.e. anything that could arrive from outside, since
// api-gateway strips every inbound x-dub-* — is refused with 403 internal_only.
describe("every route is INTERNAL at runtime", () => {
  it("answers a service-to-service call carrying x-dub-internal", async () => {
    const app = createApp();
    expect((await app.request("/internal/health", { headers: S2S }, EMPTY_ENV)).status).toBe(200);
    expect(await (await app.request("/", { headers: S2S }, EMPTY_ENV)).text()).toBe("freeq-drain");
    // DRAIN_DO is unbound in this env, so the handler's own 503 proves the gate let it through.
    expect((await app.request("/internal/drain/kick", { method: "POST", headers: S2S }, EMPTY_ENV)).status).toBe(503);
  });

  it("403s internal_only without the marker, on every route, however privileged the caller", async () => {
    const app = createApp();
    for (const [path, method] of [
      ["/internal/health", "GET"],
      ["/", "GET"],
      ["/internal/drain/kick", "POST"],
    ] as const) {
      const res = await app.request(path, { method, headers: EXTERNAL }, EMPTY_ENV);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { details: { reason: string } } };
      expect(body.error.details.reason).toBe("internal_only");
    }
  });
});
