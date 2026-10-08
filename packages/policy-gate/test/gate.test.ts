import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { dubErrorHandler, errors, CommonErrorCodes } from "@dub/errors";
import type { identity } from "@dub/types";
import {
  policyGate,
  definePolicyTable,
  appLevel,
  allows,
  missingKeys,
  PUBLIC,
  AUTHENTICATED,
  INTERNAL,
  internalWithKeys,
  requiredKeysOf,
  checkRouteCoverage,
  assertRouteCoverage,
  protectableRouteKeys,
  type ActorResolver,
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

/** Wraps a granter to record whether the gate consulted identity at all. */
function counting(inner: PermissionGranter): PermissionGranter & { calls: number } {
  const fn = async (...args: Parameters<PermissionGranter>) => {
    fn.calls += 1;
    return inner(...args);
  };
  fn.calls = 0;
  return fn;
}

const TABLE = definePolicyTable({
  "GET /health": PUBLIC,
  "GET /me": AUTHENTICATED,
  "GET /internal/drain": INTERNAL,
  "POST /internal/settings": internalWithKeys(["task:read", "task:write"]),
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
  app.get("/me", (c) => c.json({ userId: c.get("userId") }));
  app.get("/internal/drain", (c) => c.json({ drained: true, userId: c.get("userId") ?? null }));
  app.post("/internal/settings", (c) => c.json({ saved: true, userId: c.get("userId") }));
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

// ── AUTHENTICATED: authn without authz, deliberately NOT a synonym for PUBLIC ──
// The property being pinned: a session is REQUIRED (so this is not PUBLIC) and no key is
// (so this is not RequiredKeys), and the gate reaches identity zero times — there is nothing
// to ask. For the routes it is meant for (api-gateway's `/me` family, which take the subject
// from the session and cannot be told to act on someone else) that is the whole decision.
describe("AUTHENTICATED routes", () => {
  it("401s without x-dub-user-id: a session is required, unlike PUBLIC", async () => {
    const res = await build(holding()).request("/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe(CommonErrorCodes.UNAUTHENTICATED);
  });

  it("allows any signed-in caller holding no permission at all, and exposes userId", async () => {
    const res = await build(holding()).request("/me", { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "usr_1" });
  });

  it("never consults identity (no key to ask about, so no subrequest)", async () => {
    const granter = counting(holding());
    const res = await build(granter).request("/me", { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(granter.calls).toBe(0);
    // Contrast: a keyed route on the same app does call it exactly once.
    await build(granter).request("/items", { headers: AUTHED });
    expect(granter.calls).toBe(1);
  });

  it("stays allowed even when identity is unreachable (nothing to fail closed on)", async () => {
    const broken: PermissionGranter = async () => {
      throw new Error("identity unreachable");
    };
    expect((await build(broken).request("/me", { headers: AUTHED })).status).toBe(200);
    // ...while a keyed route on the same broken identity is denied.
    expect((await build(broken).request("/items", { headers: AUTHED })).status).toBeGreaterThanOrEqual(500);
  });

  it("is not reachable by an s2s call that carries the marker but no user", async () => {
    const res = await build(holding()).request("/me", { headers: S2S });
    expect(res.status).toBe(401);
  });
});

// ── the actor port: how api-gateway can mount this layer at the internet boundary ──
// Default actor = the trusted x-dub-user-id header, which is a FACT downstream because
// api-gateway minted it. At the edge it is attacker input, so the gateway supplies a resolver
// that verifies the session instead. These pin the properties that make that safe.
describe("actor resolver (edge wiring)", () => {
  function buildWithActor(actor: ActorResolver, granted: PermissionGranter = holding("task:read")) {
    const app = new Hono<{ Variables: PolicyGateVars }>();
    app.onError(dubErrorHandler({ service: "test" }));
    app.use("*", policyGate({ service: "test", table: TABLE, granted, actor }));
    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/me", (c) => c.json({ userId: c.get("userId") }));
    app.get("/items", (c) => c.json({ userId: c.get("userId") }));
    app.get("/internal/drain", (c) => c.json({ userId: c.get("userId") ?? null }));
    return app;
  }

  it("identifies the caller from the resolver and IGNORES a spoofed header (AUTHENTICATED)", async () => {
    const res = await buildWithActor(() => "usr_session").request("/me", { headers: { "x-dub-user-id": "usr_attacker" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "usr_session" });
  });

  it("attributes permissions to the resolved user, not the header (keyed route)", async () => {
    const seen: string[] = [];
    const granted: PermissionGranter = async (userId, _org, keys) => {
      seen.push(userId);
      return keys;
    };
    const res = await buildWithActor(() => "usr_session", granted).request("/items", {
      headers: { "x-dub-user-id": "usr_attacker" },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["usr_session"]);
  });

  it("is never called for a PUBLIC route (a public endpoint costs no verify)", async () => {
    let calls = 0;
    const res = await buildWithActor(() => {
      calls += 1;
      return "usr_session";
    }).request("/health");
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
  });

  it("401s when the resolver finds no session", async () => {
    const res = await buildWithActor(() => undefined).request("/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.message).toContain("no authenticated actor");
  });

  it("propagates the resolver's own failure unchanged (a verify outage stays a 502, not a 401)", async () => {
    const res = await buildWithActor(() => {
      throw errors.upstreamUnavailable("auth-service");
    }).request("/me");
    expect(res.status).toBe(502);
  });

  it("takes an INTERNAL route's actor from the trusted header, not the resolver", async () => {
    // On an s2s call the actor is what the calling service propagated; running a
    // session-verify resolver there would 401 a legitimate probe that carries no session.
    const res = await buildWithActor(() => {
      throw new Error("resolver must not run here");
    }).request("/internal/drain", { headers: { ...S2S, ...AUTHED } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "usr_1" });
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

// ── internalWithKeys: the conjunction, for a route that is BOTH internal-only and key-gated ──
// mail-automation's 13 routes are the case: no gateway segment reaches them AND they demand
// `mail:read`/`mail:admin` of the user the calling service propagated. Writing either half
// alone would misstate the route in the one artifact reviewers trust, so both are asserted
// here — and asserted as a conjunction, i.e. each half denies on its own.
describe("internalWithKeys routes", () => {
  const S2S_AUTHED = { ...S2S, ...AUTHED };
  const bothKeys = () => holding("task:read", "task:write");

  it("allows an s2s call whose propagated user holds every key", async () => {
    const res = await build(bothKeys()).request("/internal/settings", { method: "POST", headers: S2S_AUTHED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, userId: "usr_1" });
  });

  it("403s internal_only without the marker, however privileged the caller", async () => {
    const res = await build(bothKeys()).request("/internal/settings", { method: "POST", headers: AUTHED });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.details.reason).toBe("internal_only");
    expect(body.error.details.route).toBe("POST /internal/settings");
  });

  // The marker check runs FIRST, so an external caller is told "internal-only" and never
  // learns which permission would have been required: no permission oracle on a closed door.
  it("does not leak the required keys to an external caller", async () => {
    const res = await build(holding()).request("/internal/settings", { method: "POST", headers: AUTHED });
    const body = (await res.json()) as any;
    expect(body.error.details.reason).toBe("internal_only");
    expect(body.error.details.required).toBeUndefined();
    expect(body.error.details.missing).toBeUndefined();
  });

  // Unlike a bare INTERNAL route, this form names keys, so it needs an actor to attribute
  // them to. A marker-only probe is a 401, NOT an anonymous allow.
  it("401s a marker-carrying call that propagated no user id", async () => {
    const res = await build(bothKeys()).request("/internal/settings", { method: "POST", headers: S2S });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe(CommonErrorCodes.UNAUTHENTICATED);
  });

  it("403s and names the missing key when the propagated user is short one", async () => {
    const res = await build(holding("task:read")).request("/internal/settings", {
      method: "POST",
      headers: S2S_AUTHED,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.details.reason).toBe("missing_permission");
    expect(body.error.details.required).toEqual(["task:read", "task:write"]);
    expect(body.error.details.missing).toEqual(["task:write"]);
  });

  it("the marker buys no key: holding nothing is 403 even on a genuine s2s call", async () => {
    const res = await build(holding()).request("/internal/settings", { method: "POST", headers: S2S_AUTHED });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.details.missing).toEqual(["task:read", "task:write"]);
  });

  it("fails closed when identity is unreachable", async () => {
    const broken: PermissionGranter = async () => {
      throw new Error("identity unreachable");
    };
    const res = await build(broken).request("/internal/settings", { method: "POST", headers: S2S_AUTHED });
    expect(res.status).toBeGreaterThanOrEqual(500);
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
  it("missingKeys returns [] for all three key-free rule forms", () => {
    expect(missingKeys(PUBLIC, [])).toEqual([]);
    expect(missingKeys(AUTHENTICATED, [])).toEqual([]);
    expect(missingKeys(INTERNAL, [])).toEqual([]);
  });

  // AUTHENTICATED sits at the opposite end of the matrix from INTERNAL: reachable by every
  // role including one holding nothing. That is the honest answer, and the reason this form
  // must never be used as a way to quiet a 403 — it removes the route from ロール管理's reach.
  it("AUTHENTICATED demands no key and is reachable by every role", () => {
    expect(allows(AUTHENTICATED, [])).toBe(true);
    expect(allows(AUTHENTICATED, ["task:read"])).toBe(true);
  });

  it("internalWithKeys reports its keys to missingKeys but is reachable by no role", () => {
    const rule = internalWithKeys(["task:read", "task:write"]);
    // The key axis is answered normally (this is what the gate's 403 details come from)...
    expect(missingKeys(rule, ["task:read"])).toEqual(["task:write"]);
    expect(missingKeys(rule, ["task:read", "task:write"])).toEqual([]);
    // ...but reachability stays false even for a caller holding everything, exactly like
    // INTERNAL. Were this true, the role x endpoint matrices would start claiming an
    // unreachable internal endpoint as part of a role's surface.
    expect(allows(rule, ["task:read", "task:write"])).toBe(false);
    expect(allows(rule, [])).toBe(false);
  });

  it("internalWithKeys is a declaration, not a mutation of the keys it is given", () => {
    const keys = ["task:read"] as const;
    expect(internalWithKeys(keys).keys).toEqual(["task:read"]);
    // Nothing in the vocabulary lets an empty key list through: an internal route that needs
    // no key is plain INTERNAL. (`internalWithKeys([])` is a compile error, not a runtime one.)
    expect(requiredKeysOf(internalWithKeys(keys))).toEqual(["task:read"]);
    expect(requiredKeysOf(INTERNAL)).toBeUndefined();
    expect(requiredKeysOf(AUTHENTICATED)).toBeUndefined();
    expect(requiredKeysOf(PUBLIC)).toBeUndefined();
    expect(requiredKeysOf(["task:read"])).toEqual(["task:read"]);
  });
});
