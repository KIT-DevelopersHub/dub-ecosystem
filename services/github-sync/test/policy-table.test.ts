// The two tests that make the policy layer self-enforcing for this service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "maintainer can now register repos" without reading the
//     table.
//
// Both go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PermissionGranter, RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { makeHarness, fixedNow, allowAll, memAuthzHolding } from "./helpers";

function buildApp(authz: PermissionGranter = allowAll) {
  const h = makeHarness();
  const webhookRaw = { get: async () => null } as unknown as R2Bucket;
  return createApp({
    authz,
    service: h.service,
    publisher: h.publisher,
    now: fixedNow,
    queue: { engine: h.engine, processed: h.stores.processed, webhookRaw },
  });
}

/** Every externally reachable route needs these two alongside a session. */
const AUTHED = { "x-dub-request-id": "req_test", "x-dub-user-id": "user_1" };

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/github/repos/:id/tokens", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /github/repos/:id/tokens"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/github\/repos\/:id\/tokens/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.request("/github/repos/ghr_main/tokens", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// The GitHub-relevant grants of each system role, per the identity migrations that define
// them: 0002 (maintainer gets github:read/write/sync and deliberately NOT github:admin —
// "dangerous integration admin = org-admin tier"), 0005 (admin gets all four). organizer and
// member hold no github:* key at all, so the whole surface is closed to them.
//
// There is no `app:github:*` tier in this matrix because there is no `github` app in
// APP_MANIFEST (see src/policy-table.ts) — the fine-grained keys are the entire decision.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["github:read", "github:write", "github:sync", "github:admin"],
  maintainer: ["github:read", "github:write", "github:sync"],
  organizer: [],
  member: [],
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
  "GET /github/links",
  "GET /github/repos",
  "GET /github/sync/runs",
  "GET /github/sync/runs/:id",
];
const LINK_WRITES = ["DELETE /github/links/:id", "POST /github/links"];
const SYNC = ["POST /github/sync"];
const REPO_ADMIN = ["DELETE /github/repos/:id", "PATCH /github/repos/:id", "POST /github/repos"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = [
  "GET /internal/health",
  "POST /internal/events-async",
  "POST /internal/reconcile/kick",
  "POST /internal/webhooks-async",
];
// The whole external surface — what a caller can reach through api-gateway at most.
const FULL = [...READS, ...LINK_WRITES, ...SYNC, ...REPO_ADMIN].sort();
// maintainer: everything except the three github:admin repo-configuration routes.
const NO_REPO_ADMIN = [...READS, ...LINK_WRITES, ...SYNC].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: NO_REPO_ADMIN,
    organizer: NONE,
    member: NONE,
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

// The matrix above is a statement about the rules; these drive the real router end to end,
// so a mistake in the mount order (the gate must be FIRST) also shows up here.
describe("the gate at runtime", () => {
  const MAINTAINER = memAuthzHolding("github:read", "github:write", "github:sync");

  it("401s a request with no session before any handler runs", async () => {
    const res = await buildApp().request("/github/links", { headers: { "x-dub-request-id": "r" } });
    expect(res.status).toBe(401);
  });

  it("lets a github:read holder list links", async () => {
    const res = await buildApp(MAINTAINER).request("/github/links", { headers: AUTHED });
    expect(res.status).toBe(200);
  });

  it("refuses repo registration to maintainer (github:admin is the org-admin tier)", async () => {
    const res = await buildApp(MAINTAINER).request("/github/repos", {
      method: "POST",
      headers: { ...AUTHED, "content-type": "application/json" },
      body: JSON.stringify({ owner: "acme", repo: "web", eventId: "evt_1" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { missing: string[] } } };
    expect(body.error.details.missing).toEqual(["github:admin"]);
  });

  it("a repo-read key does not open the sync trigger (keys are per-route, not per-service)", async () => {
    const res = await buildApp(memAuthzHolding("github:read")).request("/github/sync", {
      method: "POST",
      headers: { ...AUTHED, "content-type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { missing: string[] } } };
    expect(body.error.details.missing).toEqual(["github:sync"]);
  });
});

// The INTERNAL rule at runtime, end to end through the real app: a Service-Binding probe
// (app-health-monitor sends exactly these headers) passes; the same request without the
// marker — i.e. anything that could arrive from outside, since api-gateway strips every
// inbound x-dub-* — is refused, for every one of the four internal routes.
describe("GET /internal/health (INTERNAL)", () => {
  it("answers a service-to-service probe carrying x-dub-internal", async () => {
    const res = await buildApp().request("/internal/health", { headers: { "x-dub-internal": "1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "github-sync" });
  });

  it("403s without the marker, even for an authenticated caller holding everything", async () => {
    const res = await buildApp().request("/internal/health", { headers: AUTHED });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("internal_only");
  });

  it("the same holds for the three POST /internal/* routes", async () => {
    for (const path of ["/internal/events-async", "/internal/webhooks-async", "/internal/reconcile/kick"]) {
      const res = await buildApp().request(path, {
        method: "POST",
        headers: { ...AUTHED, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status, path).toBe(403);
      const body = (await res.json()) as { error: { details: { reason: string } } };
      expect(body.error.details.reason, path).toBe("internal_only");
    }
  });
});
