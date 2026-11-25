// The policy layer's self-enforcement for lp-analytics: the router and POLICY_TABLE must match both
// ways, and the role matrix freezes the view / edit / edit + lp:publish tiers.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, type RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { POLICY_TABLE } from "../src/policy-table";
import { makeApp } from "./harness";

function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const VIEW = ["GET /lp/links", "GET /lp/proposals", "GET /lp/publish", "GET /lp/site-config", "GET /lp/site-traffic", "GET /lp/stats", "GET /lp/visits"];
const EDIT = [
  "GET /lp/proposals/submissions",
  "PATCH /lp/links/:id",
  "PATCH /lp/proposals/submissions/:id",
  "POST /lp/links",
  "POST /lp/proposals/fields",
  "POST /lp/site-config/draft/reset",
  "PUT /lp/site-config/draft",
];
const PUBLISH = ["POST /lp/proposals/enabled", "POST /lp/publish", "POST /lp/site-config/publish"];

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", async () => {
    const { app } = await makeApp("memory");
    expect(checkRouteCoverage(app, POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).not.toThrow();
  });
});

describe("role x endpoint matrix (frozen)", () => {
  it("view / edit / edit + lp:publish", () => {
    expect(allowedRoutes([])).toEqual([]);
    expect(allowedRoutes(["app:lp:view"])).toEqual([...VIEW].sort());
    expect(allowedRoutes(["app:lp:view", "app:lp:edit"])).toEqual([...EDIT, ...VIEW].sort());
    expect(allowedRoutes(["app:lp:view", "app:lp:edit", "lp:publish"])).toEqual([...EDIT, ...PUBLISH, ...VIEW].sort());
  });

  it("every internal route is INTERNAL (no key opens them)", () => {
    const internal = Object.entries(POLICY_TABLE).filter(([route]) => route.includes("/internal/"));
    expect(internal.length).toBe(7);
    for (const [, rule] of internal) expect(rule).toBe("internal");
  });
});
