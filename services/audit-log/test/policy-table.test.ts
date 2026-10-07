// The two tests that make the policy layer self-enforcing for audit-log.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "member can now read the audit log" without reading the
//     table.
//
// Both go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { HEADERS } from "@dub/observability";
import { makeD1 } from "./d1";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import type { Env } from "../src/env";

/** identity-roster double: allows every key it is asked about, or nothing. */
function identityBinding(allowed: boolean): Fetcher {
  return {
    fetch: async (req: Request) => {
      const body = (await req.json()) as identity.AuthzCheckRequest;
      const decisions = body.checks.map(() => ({ allowed, evaluatedAt: new Date().toISOString(), ttlSeconds: 60 }));
      return new Response(JSON.stringify({ decisions }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
}

function buildEnv(opts: { allow?: boolean } = {}): Env {
  const { d1 } = makeD1();
  return { DB: d1, SVC_IDENTITY: identityBinding(opts.allow ?? true) };
}

const AUTHED = { [HEADERS.userId]: "usr_admin" };
const S2S = { [HEADERS.internal]: "1" };

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(createApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(createApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = createApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule. An
    // audit-log leak is irreversible, so fail-closed matters more here than anywhere.
    app.get("/audit/export", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /audit/export"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/audit\/export/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.fetch(new Request("https://svc/audit/export", { headers: AUTHED }), buildEnv());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// Audit-relevant grants of each system role, per the identity migration that defines them
// (infra/d1/migrations/identity/0002_system_roles.sql: admin, maintainer and organizer all
// hold audit:read; member does not). The per-app tier (0008/0010) adds nothing here —
// `audit` has no entry in APP_MANIFEST, so no app:*:view key applies to this service.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["audit:read"],
  maintainer: ["audit:read"],
  organizer: ["audit:read"],
  member: [],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so the three INTERNAL routes correctly land in
 * no role's set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const READS = ["GET /audit/logs", "GET /audit/logs/:id"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely. The
// whole write surface lives here, which is the invariant that keeps the log evidence-grade.
const INTERNAL_ROUTES = ["GET /internal/health", "POST /internal/audit-async", "POST /internal/log"];
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: [...READS].sort(),
    maintainer: [...READS].sort(),
    organizer: [...READS].sort(),
    member: NONE,
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = [...INTERNAL_ROUTES, ...READS].sort();
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(createApp()).sort());
  });

  it("a caller holding nothing reaches nothing — there is no public route here", () => {
    expect(allowedRoutes([])).toEqual(NONE);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });
});

// The rules at runtime, end to end through the real app.
describe("the gate in front of the real handlers", () => {
  it("answers the app-health-monitor probe carrying x-dub-internal", async () => {
    const res = await createApp().fetch(new Request("https://svc/internal/health", { headers: S2S }), buildEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "audit-log" });
  });

  it("403s the health probe without the marker, even for a caller holding everything", async () => {
    const res = await createApp().fetch(new Request("https://svc/internal/health", { headers: AUTHED }), buildEnv());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "internal_only",
    );
  });

  it("the internal marker buys no read: it is a separate axis from audit:read", async () => {
    // An s2s caller may APPEND (POST /internal/log) but may not QUERY — /audit/logs demands
    // the key, and the marker never substitutes for one (rule.ts).
    const res = await createApp().fetch(new Request("https://svc/audit/logs", { headers: S2S }), buildEnv());
    expect(res.status).toBe(401); // no actor to attribute audit:read to
  });

  it("401s a read with no session and 403s one without audit:read", async () => {
    const anon = await createApp().fetch(new Request("https://svc/audit/logs"), buildEnv());
    expect(anon.status).toBe(401);

    const denied = await createApp().fetch(
      new Request("https://svc/audit/logs", { headers: AUTHED }),
      buildEnv({ allow: false }),
    );
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error: { message: string; details: { missing: string[] } } };
    expect(body.error.details.missing).toEqual(["audit:read"]);
  });

  it("serves a read to a caller holding audit:read", async () => {
    const res = await createApp().fetch(new Request("https://svc/audit/logs", { headers: AUTHED }), buildEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });
});
