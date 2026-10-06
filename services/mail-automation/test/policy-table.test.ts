// The three tests that make the policy layer self-enforcing for mail-automation.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — frozen. Unusually for this repo, every expected set is EMPTY:
//     all 14 routes are internal-only, so no role reaches a single one of them from outside.
//     The matrix is still the artifact that matters — the day someone relaxes a rule to a
//     bare `["mail:read"]` (or adds a PUBLIC/AUTHENTICATED route), a route appears in one of
//     these arrays and the diff shows "mail-automation is now externally reachable".
//  3. internalWithKeys AT RUNTIME, on both axes — the marker does not substitute for the
//     key, and the key does not substitute for the marker. Each half is denied on its own
//     and only the conjunction passes, end to end through the real app.
//
// Everything goes through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the
// exact comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PermissionGranter, RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { granter, makeDeps } from "./fakes";

function buildApp(authz: PermissionGranter = granter("all")) {
  return createApp({ pipeline: makeDeps().deps, authz });
}

// A full internal request: the marker (s2s), the propagated acting user, a request id.
const S2S = {
  "x-dub-request-id": "req_policy_1",
  "x-dub-user-id": "user_admin",
  "x-dub-internal": "1",
  "content-type": "application/json",
};
// The same request as it could arrive from outside: api-gateway strips every inbound x-dub-*
// and re-adds only the verified user id, so this is the most an external caller can present.
const EXTERNAL = {
  "x-dub-request-id": "req_policy_1",
  "x-dub-user-id": "user_admin",
  "content-type": "application/json",
};

async function denyReason(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { details?: { reason?: string } } };
  return body.error.details?.reason ?? "";
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule. A
    // mail-automation one would be worse than most — it would read the decision log of every
    // inbound message with no key check at all.
    app.get("/decisions/:id/raw", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /decisions/:id/raw"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/decisions\/:id\/raw/);

    // Fail-closed, not fail-open: unreachable even for an internal caller holding everything.
    const res = await app.request("/decisions/dec_1/raw", { headers: S2S });
    expect(res.status).toBe(403);
    expect(await denyReason(res)).toBe("no_policy_rule");
  });
});

// Mail-relevant grants of each system role, per the identity migrations that define them:
//   0002 (domain keys: admin gets mail:send/read/admin, maintainer mail:send/read, and
//   organizer/member get no mail key at all), 0003 (admin also gets mail:read_all),
//   0008 (per-app tier: admin/maintainer hold app:mail:view/edit).
// The app-tier keys are listed deliberately even though no rule here uses them: the matrix
// has to show that holding the メール app at 編集 still reaches nothing from outside.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:mail:view", "app:mail:edit", "mail:send", "mail:read", "mail:admin", "mail:read_all"],
  maintainer: ["app:mail:view", "app:mail:edit", "mail:send", "mail:read"],
  organizer: [],
  member: [],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the
 * reachability question for every rule form, so `INTERNAL` and `internalWithKeys` routes
 * correctly land in no role's set — a permission key never opens an internal-only door to a
 * request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

// The 13 routes that demand the marker AND a key, by key.
const READ_ROUTES = [
  "GET /decisions",
  "GET /rules",
  "GET /rules/:id",
  "GET /settings",
  "GET /templates",
  "POST /dry-run",
];
const ADMIN_ROUTES = [
  "DELETE /rules/:id",
  "PATCH /rules/:id",
  "PATCH /settings",
  "PATCH /templates/:id",
  "POST /process",
  "POST /rules",
  "POST /templates",
];
// The one bare-INTERNAL route: a drained freeq envelope, no acting user to hold a key.
const INTERNAL_ROUTES = ["POST /internal/events-async"];
const EVERY_ROUTE = [...INTERNAL_ROUTES, ...READ_ROUTES, ...ADMIN_ROUTES].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Every row is NONE, and that is the assertion: mail-automation has no external surface.
  // A rule written as a bare key list (or PUBLIC/AUTHENTICATED) would add a route to a row
  // here, which is the diff a reviewer must see.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: NONE,
    maintainer: NONE,
    organizer: NONE,
    member: NONE,
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("no role reaches ANY route from outside — the whole service is internal-only", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    expect(allowedRoutes(everyKey)).toEqual(NONE);
    for (const route of EVERY_ROUTE) expect(allowedRoutes(everyKey)).not.toContain(route);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    expect(EVERY_ROUTE).toHaveLength(14);
    expect(INTERNAL_ROUTES).toHaveLength(1);
    expect([...READ_ROUTES, ...ADMIN_ROUTES]).toHaveLength(13);
    expect(EVERY_ROUTE).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(EVERY_ROUTE).toEqual(protectableRouteKeys(buildApp()).sort());
  });

  it("a caller holding nothing reaches nothing — there is no public route here", () => {
    expect(allowedRoutes([])).toEqual(NONE);
  });
});

// The conjunction, measured on both axes through the real app. GET /settings stands in for
// the 13: it is `internalWithKeys(["mail:read"])`, the cheapest read, and its 200 body is
// the kill-switch state so a pass is unambiguous.
describe("internalWithKeys at runtime (GET /settings = marker AND mail:read)", () => {
  it("(a) marker + key => 200", async () => {
    const res = await buildApp(granter(["mail:read"])).request("/settings", { headers: S2S });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ automationEnabled: false });
  });

  it("(b) marker + NO key => 403 missing_permission (the marker buys no permission)", async () => {
    const res = await buildApp(granter("none")).request("/settings", { headers: S2S });
    expect(res.status).toBe(403);
    expect(await denyReason(res)).toBe("missing_permission");
  });

  it("(c) NO marker + key => 403 internal_only (a permission opens no internal door)", async () => {
    // The caller holds mail:read AND mail:admin — every key this service knows — and is
    // still refused, because it did not arrive over a Service Binding.
    const res = await buildApp(granter(["mail:read", "mail:admin"])).request("/settings", { headers: EXTERNAL });
    expect(res.status).toBe(403);
    expect(await denyReason(res)).toBe("internal_only");
  });

  it("the marker check runs FIRST, so an external caller cannot probe which key is needed", async () => {
    // Same external request against an admin-key route: the refusal is identical to (c), so
    // the response leaks nothing about mail:admin. Not a permission oracle.
    const res = await buildApp(granter("none")).request("/settings", { method: "PATCH", headers: EXTERNAL, body: "{}" });
    expect(res.status).toBe(403);
    expect(await denyReason(res)).toBe("internal_only");
  });

  it("a keyed route needs an ACTOR: an s2s call that propagated no user id is 401", async () => {
    const { "x-dub-user-id": _dropped, ...noUser } = S2S;
    const res = await buildApp(granter("all")).request("/settings", { headers: noUser });
    expect(res.status).toBe(401);
  });

  it("the admin half is really a different key: mail:read alone cannot PATCH /settings", async () => {
    // A maintainer (mail:read, no mail:admin) over a binding — reads yes, kill switch no.
    const app = buildApp(granter(["mail:read"]));
    expect((await app.request("/settings", { headers: S2S })).status).toBe(200);
    const res = await app.request("/settings", { method: "PATCH", headers: S2S, body: JSON.stringify({ automationEnabled: true }) });
    expect(res.status).toBe(403);
    expect(await denyReason(res)).toBe("missing_permission");
  });
});

// The one bare-INTERNAL route. It must accept a freeq delivery that carries NO acting user
// and NO request id (that is all makeDeliver sends), and refuse anything without the marker.
describe("POST /internal/events-async (bare INTERNAL)", () => {
  const ENVELOPE = JSON.stringify({ name: "task.created", version: 1, id: "evt_pg_1", occurredAt: "2026-08-09T10:00:00.000Z", requestId: "req_1", actorId: null, payload: {} });

  it("accepts a drain delivery with only content-type + x-dub-internal", async () => {
    const res = await buildApp(granter("none")).request("/internal/events-async", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dub-internal": "1" },
      body: ENVELOPE,
    });
    // 200 "unknown" = the envelope reached the handler (this service does not subscribe to
    // task.created, which is the ack-worthy outcome). Not 400: that would mean dubContext
    // demanded x-dub-request-id, which the drain never sends — auto-reply would silently die.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unknown" });
  });

  it("403s internal_only without the marker, even holding every mail key", async () => {
    const res = await buildApp(granter("all")).request("/internal/events-async", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ENVELOPE,
    });
    expect(res.status).toBe(403);
    expect(await denyReason(res)).toBe("internal_only");
  });
});
