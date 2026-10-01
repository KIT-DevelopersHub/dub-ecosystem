import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { dubErrorHandler, CommonErrorCodes } from "@dub/errors";
import type { identity } from "@dub/types";
import {
  policyGate,
  definePolicyTable,
  appLevel,
  allows,
  missingKeys,
  PUBLIC,
  INTERNAL,
  checkRouteCoverage,
  assertRouteCoverage,
  protectableRouteKeys,
  type PermissionGranter,
  type PolicyGateVars,
} from "../src/index";

const AUTHED = { "x-dub-user-id": "usr_1" };
/** The marker @dub/http's createServiceClient puts on every genuine s2s call. */
const S2S = { "x-dub-internal": "1" };

/** Granter for a caller holding exactly `keys`. */
function holding(...keys: identity.PermissionKey[]): PermissionGranter {
  const held = new Set<string>(keys);
  return async (_u, _o, requested) => requested.filter((k) => held.has(k));
}

const TABLE = definePolicyTable({
  "GET /health": PUBLIC,
  "GET /internal/drain": INTERNAL,
  "GET /items": ["task:read"],
  "POST /items": ["task:read", "task:write"],
  "DELETE /items/:id": ["task:delete"],
});

/** `build()` mirrors the production wiring: gate first, routes after. */
function build(granted: PermissionGranter, extra?: (app: Hono<{ Variables: PolicyGateVars }>) => void) {
  const app = new Hono<{ Variables: PolicyGateVars }>();
  app.onError(dubErrorHandler({ service: "test" }));
  app.use("*", policyGate({ service: "test", table: TABLE, granted }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/internal/drain", (c) => c.json({ drained: true, userId: c.get("userId") ?? null }));
  app.get("/items", (c) => c.json({ userId: c.get("userId") }));
  app.post("/items", (c) => c.json({ ok: true }, 201));
  app.delete("/items/:id", (c) => c.json({ id: c.req.param("id") }));
  extra?.(app);
  return app;
}

describe("policyGate", () => {
  it("lets a PUBLIC route through with no credentials", async () => {
    const res = await build(holding()).request("/health");
    expect(res.status).toBe(200);
  });

  it("401s a gated route with no x-dub-user-id", async () => {
    const res = await build(holding("task:read")).request("/items");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe(CommonErrorCodes.UNAUTHENTICATED);
  });

  it("allows when every required key is held, and exposes userId to the handler", async () => {
    const res = await build(holding("task:read")).request("/items", { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "usr_1" });
  });

  it("403s and names the missing key when one of several is absent", async () => {
    const res = await build(holding("task:read")).request("/items", { method: "POST", headers: AUTHED });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(CommonErrorCodes.FORBIDDEN);
    expect(body.error.details.missing).toEqual(["task:write"]);
  });

  it("matches the route PATTERN, not the literal path (params resolve to one rule)", async () => {
    const app = build(holding("task:delete"));
    expect((await app.request("/items/abc", { method: "DELETE", headers: AUTHED })).status).toBe(200);
    expect((await app.request("/items/xyz", { method: "DELETE", headers: AUTHED })).status).toBe(200);
  });

  it("distinguishes methods on the same path", async () => {
    // holds the read key only: GET passes, POST (read+write) does not.
    const app = build(holding("task:read"));
    expect((await app.request("/items", { headers: AUTHED })).status).toBe(200);
    expect((await app.request("/items", { method: "POST", headers: AUTHED })).status).toBe(403);
  });

  // ── the property the whole package exists for ──
  it("DENIES a route that exists but is absent from the table (fail closed)", async () => {
    const app = build(holding("task:read", "task:write", "task:delete"), (a) => {
      // a brand-new endpoint whose author forgot the policy table
      a.get("/items/:id/secret", (c) => c.json({ leaked: true }));
    });
    const res = await app.request("/items/abc/secret", { headers: AUTHED });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.details.reason).toBe("no_policy_rule");
    expect(body.error.details.route).toBe("GET /items/:id/secret");
  });

  it("leaves a request matching no route to Hono's 404", async () => {
    const res = await build(holding()).request("/nope", { headers: AUTHED });
    expect(res.status).toBe(404);
  });

  it("fails closed (5xx, never allow) when the granter throws", async () => {
    const broken: PermissionGranter = async () => {
      throw new Error("identity unreachable");
    };
    const res = await build(broken).request("/items", { headers: AUTHED });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// ── INTERNAL: the second rule form, deliberately NOT a synonym for PUBLIC ──
// The property being pinned: an internal-only route is closed to every external caller no
// matter how privileged, and open to a service-to-service call carrying no user at all.
// api-gateway strips every inbound x-dub-* and never re-adds x-dub-internal on an external
// forward (services/api-gateway/src/proxy.ts), so the marker cannot be spoofed from outside
// — these tests assert the receiving half of that contract.
describe("INTERNAL routes", () => {
  it("allows a service-to-service call carrying the x-dub-internal marker", async () => {
    const res = await build(holding()).request("/internal/drain", { headers: S2S });
    expect(res.status).toBe(200);
  });

  it("needs no x-dub-user-id: an s2s probe has no acting user", async () => {
    const res = await build(holding()).request("/internal/drain", { headers: S2S });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drained: true, userId: null });
  });

  it("exposes the acting user when the calling service propagated one", async () => {
    const res = await build(holding()).request("/internal/drain", { headers: { ...S2S, ...AUTHED } });
    expect(await res.json()).toEqual({ drained: true, userId: "usr_1" });
  });

  it("403s without the marker, naming internal_only", async () => {
    const res = await build(holding()).request("/internal/drain");
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(CommonErrorCodes.FORBIDDEN);
    expect(body.error.details.reason).toBe("internal_only");
    expect(body.error.details.route).toBe("GET /internal/drain");
  });

  // The PUBLIC/INTERNAL distinction in one assertion: an authenticated caller holding EVERY
  // permission in the table still cannot reach an INTERNAL route from outside. Had this route
  // been marked PUBLIC "because only we call it", this request would have returned 200.
  it("403s an external caller holding every permission (keys never substitute for the marker)", async () => {
    const app = build(holding("task:read", "task:write", "task:delete"));
    const res = await app.request("/internal/drain", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.details.reason).toBe("internal_only");
  });

  // The converse: the marker is not a master key either.
  it("does not let the marker substitute for a permission on a keyed route", async () => {
    const app = build(holding("task:read"));
    const res = await app.request("/items", { method: "POST", headers: { ...AUTHED, ...S2S } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.details.missing).toEqual(["task:write"]);
  });

  it("still 401s a keyed route reached s2s without a user id", async () => {
    const res = await build(holding("task:read")).request("/items", { headers: S2S });
    expect(res.status).toBe(401);
  });
});

describe("route coverage", () => {
  it("passes when the table matches the router exactly", () => {
    expect(checkRouteCoverage(build(holding()), TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
  });

  it("reports a route added without a table entry", () => {
    const app = build(holding(), (a) => a.get("/items/:id/secret", (c) => c.json({})));
    const result = checkRouteCoverage(app, TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /items/:id/secret"]);
    expect(() => assertRouteCoverage(app, TABLE)).toThrow(/GET \/items\/:id\/secret/);
  });

  it("reports a table entry matching no route (typo'd key)", () => {
    const typo = { ...TABLE, "GET /item": ["task:read"] } as const;
    const result = checkRouteCoverage(build(holding()), typo);
    expect(result.ok).toBe(false);
    expect(result.orphaned).toEqual(["GET /item"]);
  });

  it("ignores catch-all middleware and collapses per-handler duplicates", () => {
    const app = new Hono();
    app.use("*", async (_c, next) => next());
    app.use("/items/*", async (_c, next) => next());
    app.get("/items", async (_c, next) => next(), (c) => c.json({}));
    expect(protectableRouteKeys(app)).toEqual(["GET /items"]);
  });
});

describe("rules", () => {
  it("appLevel resolves the ロール管理 tier through APP_MANIFEST", () => {
    expect(appLevel("driveshare", "view", "drive:read")).toEqual(["app:driveshare:view", "drive:read"]);
    expect(appLevel("driveshare", "edit", "drive:write")).toEqual([
      "app:driveshare:view",
      "app:driveshare:edit",
      "drive:write",
    ]);
  });

  it("appLevel throws on an unregistered app id", () => {
    expect(() => appLevel("nope", "view")).toThrow(/unknown app id/);
  });

  it("required keys are conjunctive; PUBLIC needs nothing", () => {
    expect(allows(["task:read", "task:write"], ["task:read"])).toBe(false);
    expect(allows(["task:read", "task:write"], ["task:read", "task:write"])).toBe(true);
    expect(missingKeys(["task:read", "task:write"], ["task:write"])).toEqual(["task:read"]);
    expect(allows(PUBLIC, [])).toBe(true);
  });

  // `allows` is what the per-service role x endpoint matrices use, so this is the assertion
  // that keeps INTERNAL routes out of every role's reachable set.
  it("no set of permission keys makes an INTERNAL route reachable by an external caller", () => {
    expect(allows(INTERNAL, [])).toBe(false);
    expect(allows(INTERNAL, ["task:read", "task:write", "task:delete"])).toBe(false);
  });

  // The documented trap: missingKeys answers "which demanded keys are absent", not "allowed".
  // INTERNAL demands no keys, hence [] — which is exactly why reachability goes through allows.
  it("missingKeys returns [] for both key-free rule forms", () => {
    expect(missingKeys(PUBLIC, [])).toEqual([]);
    expect(missingKeys(INTERNAL, [])).toEqual([]);
  });
});
