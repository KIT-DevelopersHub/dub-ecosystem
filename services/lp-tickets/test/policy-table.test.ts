// The policy layer's self-enforcement for lp-tickets: the router and POLICY_TABLE must match both
// ways, and the role matrix freezes today's lp-analytics rules (view / edit / edit + lp:publish).
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, type RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { POLICY_TABLE } from "../src/policy-table";
import { get, makeApp, send } from "./harness";

const VIEW = ["GET /lp/tickets"];
const EDIT = [
  "GET /lp/tickets/orders",
  "PATCH /lp/tickets/types/:id",
  "POST /lp/tickets/fields",
  "POST /lp/tickets/preview-token",
  "POST /lp/tickets/types",
];
const PUBLISH = [
  "GET /lp/tickets/coupons",
  "PATCH /lp/tickets/coupons/:id",
  "POST /lp/tickets/coupons",
  "POST /lp/tickets/cta",
  "POST /lp/tickets/enabled",
  "POST /lp/tickets/orders/:id/approve",
];

function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", async () => {
    const { app } = await makeApp("memory");
    expect(checkRouteCoverage(app, POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).not.toThrow();
  });

  it("denies a route shipped without a table entry", async () => {
    const { app } = await makeApp("memory", "edit", ["lp:publish"]);
    app.get("/lp/tickets/leak", (c) => c.json({ leaked: true }));
    expect(checkRouteCoverage(app, POLICY_TABLE).unlisted).toEqual(["GET /lp/tickets/leak"]);
    expect((await app.fetch(get("/lp/tickets/leak"))).status).toBe(403);
  });
});

describe("role x endpoint matrix (frozen)", () => {
  it("view / edit / edit + lp:publish", () => {
    expect(allowedRoutes([])).toEqual([]);
    expect(allowedRoutes(["app:lp:view"])).toEqual(VIEW);
    expect(allowedRoutes(["app:lp:view", "app:lp:edit"])).toEqual([...EDIT, ...VIEW].sort());
    expect(allowedRoutes(["app:lp:view", "app:lp:edit", "lp:publish"])).toEqual([...EDIT, ...PUBLISH, ...VIEW].sort());
    // lp:publish without 編集 opens nothing extra: the tier caps it.
    expect(allowedRoutes(["app:lp:view", "lp:publish"])).toEqual(VIEW);
  });

  it("every /lp/internal/* and the health route are INTERNAL (no key opens them)", () => {
    const internal = Object.entries(POLICY_TABLE).filter(([route]) => route.includes("/internal/"));
    expect(internal.length).toBe(9);
    for (const [, rule] of internal) expect(rule).toBe("internal");
  });
});

describe("INTERNAL at runtime", () => {
  it("401 without a session, 403 without the marker even when signed in", async () => {
    const { app } = await makeApp("memory", "edit", ["lp:publish"]);
    expect((await app.fetch(get("/lp/tickets", {}))).status).toBe(401);
    expect((await app.fetch(get("/lp/internal/tickets"))).status).toBe(403);
    expect((await app.fetch(send("POST", "/lp/internal/tickets/stripe-webhook", {}))).status).toBe(403);
  });

  it("answers the health probe only with the marker", async () => {
    const { app } = await makeApp("memory");
    expect((await app.fetch(get("/internal/health", { "x-dub-internal": "1" }))).status).toBe(200);
    expect((await app.fetch(get("/internal/health", {}))).status).toBe(403);
  });
});
