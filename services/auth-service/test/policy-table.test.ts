// The tests that make the policy layer self-enforcing for auth-service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions, and here that has to hold in BOTH env configurations
//     (see "env-dependent registration" below). This is what turns "I added an endpoint and
//     forgot the table line" from a silent hole into a red build; one case proves it by
//     actually adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the route set an EXTERNAL caller can reach, frozen. For this
//     service the interesting assertion is the inverse of a normal one: the reachable set is
//     the same six PUBLIC routes for everybody, including a caller holding every permission
//     in the catalog, because nothing here is key-gated from outside.
//  3. THE internalWithKeys PAIR — the admin password routes, exercised end to end through the
//     real app for each half of the conjunction, so the two-condition guard those handlers
//     used to carry inline cannot be lost without a red test.
//
// Everything goes through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the
// exact comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PolicyTable, RouteRule } from "@dub/policy-gate";
import { identity } from "@dub/types";
import { buildApp } from "../src/app";
import { POLICY_TABLE, CONDITIONALLY_REGISTERED_ROUTES } from "../src/policy-table";
import { makeHarness, jsonInit, getInit, fakeUser } from "./helpers";

// ---------------------------------------------------------------------------
// env-dependent registration
//
// `POST /auth/demo-login` is registered only when DEMO_AUTOLOGIN=1 (staging), so coverage must
// be asserted against TWO apps rather than one. The table always lists the route — dropping it
// would leave the staging configuration, the only one where it is reachable, ungated — so the
// configuration WITHOUT the flag is compared against the table minus exactly those keys.
// Neither comparison is loosened: both still fail on an unlisted route or an orphaned entry.
// ---------------------------------------------------------------------------

/** Staging shape: every route registered, including the conditional one. */
function appWithDemoLogin(): ReturnType<typeof buildApp> {
  return buildApp(makeHarness({ ENVIRONMENT: "production", DEMO_AUTOLOGIN: "1" }).deps);
}

/** Production shape: DEMO_AUTOLOGIN unset, so demo-login is not registered at all. */
function appWithoutDemoLogin(): ReturnType<typeof buildApp> {
  return buildApp(makeHarness({ ENVIRONMENT: "production" }).deps);
}

/** POLICY_TABLE minus the conditionally-registered keys. */
function tableWithoutConditional(): PolicyTable {
  const rest: Record<string, RouteRule> = { ...POLICY_TABLE };
  for (const key of CONDITIONALLY_REGISTERED_ROUTES) delete rest[key];
  return rest as PolicyTable;
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("matches exactly when every route is registered (DEMO_AUTOLOGIN=1)", () => {
    expect(checkRouteCoverage(appWithDemoLogin(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(appWithDemoLogin(), POLICY_TABLE)).not.toThrow();
  });

  it("matches exactly when the conditional route is absent (DEMO_AUTOLOGIN unset)", () => {
    const table = tableWithoutConditional();
    expect(checkRouteCoverage(appWithoutDemoLogin(), table)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(appWithoutDemoLogin(), table)).not.toThrow();
  });

  // The guard that keeps the two cases above honest. If a conditional key were renamed in the
  // table but not here, `tableWithoutConditional()` would delete nothing and the second case
  // would silently start asserting the wrong thing (or go red for the wrong reason).
  it("every conditionally-registered key is really in the table, and really conditional", () => {
    for (const key of CONDITIONALLY_REGISTERED_ROUTES) {
      expect(Object.keys(POLICY_TABLE)).toContain(key);
      expect(protectableRouteKeys(appWithDemoLogin())).toContain(key);
      expect(protectableRouteKeys(appWithoutDemoLogin())).not.toContain(key);
    }
  });

  // The route is listed rather than omitted, so it is gated where it exists — and absent
  // entirely where it does not (404, not an ungated 200).
  it("demo-login is gated in staging and nonexistent in production", async () => {
    expect(POLICY_TABLE["POST /auth/demo-login"]).toBe("public");
    const res = await appWithoutDemoLogin().request("/auth/demo-login", jsonInit({}));
    expect(res.status).toBe(404);
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = appWithDemoLogin();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/internal/admin/users/:userId/sessions", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /internal/admin/users/:userId/sessions"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/internal\/admin\/users\/:userId\/sessions/);

    // Fail-closed, not fail-open: unreachable even carrying the internal marker and an actor.
    const res = await app.request("/internal/admin/users/usr_x/sessions", getInit({ internal: true, actor: "usr_admin001" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// ---------------------------------------------------------------------------
// role x endpoint matrix
// ---------------------------------------------------------------------------

// The six routes the open internet may call, by decision (see policy-table.ts for why each
// one cannot require a session). Any rule change that adds a line here is a widening of the
// public surface of the login service and must be read as such in review.
const PUBLIC_ROUTES = [
  "POST /auth/demo-login",
  "POST /auth/logout",
  "POST /auth/password",
  "POST /auth/password/login",
  "POST /auth/refresh",
  "POST /auth/test-login",
].sort();

// Reachable by NO external caller, whatever they hold: four bare INTERNAL plus the two
// internalWithKeys routes (`allows` is false for both internal forms — a different axis).
const INTERNAL_ROUTES = [
  "GET /health",
  "POST /verify",
  "POST /mobile/exchange",
  "POST /internal/revoke-user",
  "POST /internal/admin/users/:userId/password",
  "GET /internal/admin/users/:userId/password",
].sort();

/** Every permission key in the catalog — the strongest caller that could ever exist. */
const EVERY_KEY: identity.PermissionKey[] = identity.PERMISSION_CATALOG.map((p) => p.key);

const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  // Holds the key the admin password routes demand — and still reaches nothing extra from
  // outside, because those routes are internal-only on the other axis.
  "identity-admin": ["identity:admin", "identity:read"],
  "ordinary-member": [],
  // Not a role: an unauthenticated request off the internet, which is what most of this
  // service's callers legitimately are.
  anonymous: [],
  "holds-every-permission-in-the-catalog": EVERY_KEY,
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the reachability
 * question for every rule form, so internal-only routes correctly land in no role's set.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

describe("role x endpoint matrix (frozen)", () => {
  // Every row is the same set, and that IS the finding: auth-service has no key-gated
  // external surface. Permissions buy a caller nothing here; the public routes are public to
  // everyone and the privileged ones are unreachable from outside by anyone.
  it("every caller reaches exactly the public login surface, and nothing else", () => {
    const actual = Object.fromEntries(Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]));
    expect(actual).toEqual({
      "identity-admin": PUBLIC_ROUTES,
      "ordinary-member": PUBLIC_ROUTES,
      anonymous: PUBLIC_ROUTES,
      "holds-every-permission-in-the-catalog": PUBLIC_ROUTES,
    });
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES].sort();
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(appWithDemoLogin()).sort());
  });

  it("no caller, however privileged, reaches an internal-only route from outside", () => {
    const reachable = allowedRoutes(EVERY_KEY);
    for (const route of INTERNAL_ROUTES) expect(reachable).not.toContain(route);
  });

  // Guards the PUBLIC/AUTHENTICATED distinction from drifting: if any of these six were
  // changed to AUTHENTICATED, login would 401 forever because api-gateway routes the `auth`
  // segment with auth="public" and so never supplies x-dub-user-id.
  it("the public login surface is reachable with no credentials at all", () => {
    expect(allowedRoutes([])).toEqual(PUBLIC_ROUTES);
  });
});

// ---------------------------------------------------------------------------
// the internalWithKeys pair, end to end through the real app
//
// `internalWithKeys(["identity:admin"])` is a CONJUNCTION, and these two routes are where the
// plaintext of a user's password is written and read. Before the migration each handler
// hand-rolled both halves; the point of these cases is that the table kept both.
// ---------------------------------------------------------------------------
describe("admin password routes (internalWithKeys)", () => {
  const ADMIN = "usr_admin001";
  const TARGET = "usr_target01";
  const TARGET_EMAIL = "target@developershub.jp";
  const PASSWORD = "issued-password";

  /** Harness where ADMIN holds identity:admin and TARGET is a real roster user. */
  function harness(): ReturnType<typeof makeHarness> {
    const h = makeHarness();
    h.identity.admins.add(ADMIN);
    h.identity.users.set(TARGET, fakeUser(TARGET_EMAIL, "Target", { id: TARGET }));
    return h;
  }

  async function errorOf(res: Response): Promise<{ code: string; details: { reason: string; required?: string[] } }> {
    return ((await res.json()) as { error: { code: string; details: { reason: string; required?: string[] } } }).error;
  }

  describe("POST (set a password)", () => {
    it("(a) 403 without the internal marker, even for the admin", async () => {
      const app = buildApp(harness().deps);
      const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: PASSWORD }, { actor: ADMIN }));
      expect(res.status).toBe(403);
      // The marker is checked FIRST, so the response reveals nothing about the key needed.
      expect((await errorOf(res)).details.reason).toBe("internal_only");
    });

    it("(b) 403 with the marker but without identity:admin", async () => {
      const h = harness();
      const app = buildApp(h.deps);
      const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: PASSWORD }, { internal: true, actor: "usr_random" }));
      expect(res.status).toBe(403);
      const err = await errorOf(res);
      expect(err.details.reason).toBe("missing_permission");
      expect(err.details.required).toEqual(["identity:admin"]);
      // Denied before the handler: no credential was written and nothing was audited.
      expect(await h.deps.passwords.get(TARGET_EMAIL)).toBeNull();
      expect(h.audit.records.some((r) => r.action === "auth.password.set")).toBe(false);
    });

    it("(c) 200 with both the marker and identity:admin, and the credential is written", async () => {
      const h = harness();
      const app = buildApp(h.deps);
      const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: PASSWORD }, { internal: true, actor: ADMIN }));
      expect(res.status).toBe(200);
      expect(await h.deps.passwords.get(TARGET_EMAIL)).not.toBeNull();
      // The gate's userId is what the handler attributes the write to.
      expect(h.audit.records.some((r) => r.action === "auth.password.set" && r.actorId === ADMIN && r.resourceId === TARGET)).toBe(true);
    });

    // A key rule needs an actor to attribute the permission to, so an s2s caller that forgot
    // to propagate one is 401 — never an anonymous allow on the strength of the marker alone.
    it("401 with the marker but no acting user at all", async () => {
      const app = buildApp(harness().deps);
      const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: PASSWORD }, { internal: true }));
      expect(res.status).toBe(401);
    });
  });

  describe("GET (view the plaintext)", () => {
    /** Issue a password as the admin first, so an encrypted copy exists to decrypt. */
    async function withIssuedPassword(): Promise<ReturnType<typeof makeHarness>> {
      const h = harness();
      const app = buildApp(h.deps);
      const set = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: "viewable-secret" }, { internal: true, actor: ADMIN }));
      expect(set.status).toBe(200);
      return h;
    }

    it("(a) 403 without the internal marker, even for the admin", async () => {
      const h = await withIssuedPassword();
      const res = await buildApp(h.deps).request(`/internal/admin/users/${TARGET}/password`, getInit({ actor: ADMIN }));
      expect(res.status).toBe(403);
      expect((await errorOf(res)).details.reason).toBe("internal_only");
      expect(h.audit.records.some((r) => r.action === "auth.password.viewed")).toBe(false);
    });

    it("(b) 403 with the marker but without identity:admin, and no view is audited", async () => {
      const h = await withIssuedPassword();
      const res = await buildApp(h.deps).request(`/internal/admin/users/${TARGET}/password`, getInit({ internal: true, actor: "usr_random" }));
      expect(res.status).toBe(403);
      const err = await errorOf(res);
      expect(err.details.reason).toBe("missing_permission");
      expect(err.details.required).toEqual(["identity:admin"]);
      expect(h.audit.records.some((r) => r.action === "auth.password.viewed")).toBe(false);
    });

    it("(c) 200 with both, returning the decrypted password and auditing the read", async () => {
      const h = await withIssuedPassword();
      const res = await buildApp(h.deps).request(`/internal/admin/users/${TARGET}/password`, getInit({ internal: true, actor: ADMIN }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { userId: string; email: string; password: string };
      expect(body).toMatchObject({ userId: TARGET, email: TARGET_EMAIL, password: "viewable-secret" });
      expect(h.audit.records.some((r) => r.action === "auth.password.viewed" && r.actorId === ADMIN && r.resourceId === TARGET)).toBe(true);
    });

    it("401 with the marker but no acting user at all", async () => {
      const h = await withIssuedPassword();
      const res = await buildApp(h.deps).request(`/internal/admin/users/${TARGET}/password`, getInit({ internal: true }));
      expect(res.status).toBe(401);
    });
  });
});

// The bare INTERNAL routes at runtime through the real app: a Service-Binding call carrying
// the marker passes; the same request without it — i.e. anything that could arrive from
// outside, since api-gateway strips every inbound x-dub-* — is refused. /verify is the one
// that matters most: the gateway calls it on EVERY authenticated request, with no actor.
describe("bare INTERNAL routes", () => {
  it("/verify answers a service-to-service call that propagates no acting user", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_v", "web");
    const res = await buildApp(h.deps).request("/verify", jsonInit({ token: created.token }, { internal: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, userId: "usr_v" });
  });

  it("/health answers the app-health-monitor probe (which always sends the marker)", async () => {
    const res = await buildApp(makeHarness().deps).request("/health", getInit({ internal: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "auth-service" });
  });

  it("/health is refused without the marker (it is not a public endpoint)", async () => {
    const res = await buildApp(makeHarness().deps).request("/health", getInit({}));
    expect(res.status).toBe(403);
  });
});
