// The tests that make the policy layer self-enforcing for event-service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "member can now write" without reading the table.
//  3. HANDLER-SIDE EVENT SCOPE (policy-gate b-5 layer 2) — the half the table CANNOT express.
//     POLICY_TABLE asks only "does the caller hold `event:read` at all"; it cannot ask "…on
//     event X", because the event id lives in the request (gate.ts "RESOURCE SCOPE IS PART OF
//     THAT"). So for every route that takes an `:id`, a caller holding EVERY key must still be
//     refused an id outside its scope — and refused with 404, not with data. These cases fail
//     if `EventService.loadEvent` / `loadAction` ever stop asserting it, which is why they
//     live in the same file (and the same commit) as the table.
//
// 1 and 2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { makeDeps, call, fakeAuthz, FULL, VIEWER, EDITOR } from "./harness";
import type { ActionRow, EventRow } from "../src/types";

const ORG = "org_devhub";

function eventRow(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "event_in_scope",
    orgId: ORG,
    title: "Conf",
    description: null,
    phase: "planning",
    startsAt: null,
    endsAt: null,
    archivedAt: null,
    version: 1,
    createdBy: "user_seed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function actionRow(over: Partial<ActionRow> = {}): ActionRow {
  return {
    id: "action_in_scope",
    eventId: "event_in_scope",
    kind: "task_management",
    title: "Board",
    sortOrder: 1000,
    archivedAt: null,
    version: 1,
    createdBy: "user_seed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(createApp(makeDeps()), POLICY_TABLE)).toEqual({
      ok: true,
      unlisted: [],
      orphaned: [],
    });
    expect(() => assertRouteCoverage(createApp(makeDeps()), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = createApp(makeDeps());
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/events/:id/audit", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /events/:id/audit"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/events\/:id\/audit/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await call(app, "GET", "/events/event_in_scope/audit");
    expect(res.status).toBe(403);
    expect(res.json.error.message).toMatch(/no policy rule/);
  });

  // Hono records BOTH `app.all(path, h)` and `app.use(path, mw)` as method "ALL", and
  // policy-gate's `isMiddlewareMount` (packages/policy-gate/src/routes.ts) can only tell them
  // apart by the path being a wildcard. So method-ALL splits into two hazards, and this one
  // assertion freezes both:
  //
  //   app.all("/events/:id", h)   -> concrete path, classed as a MIDDLEWARE MOUNT by nobody:
  //                                  invisible to `protectableRouteKeys` AND to the gate, i.e.
  //                                  a live endpoint with no rule. Banned outright.
  //   app.use("/events", mw)      -> ALSO a concrete path, so it is NOT recognised as a mount
  //                                  and instead surfaces as an "endpoint with no rule" —
  //                                  coverage goes red listing a route nobody added. The fix is
  //                                  per-route middleware (`app.get("/events", mw, handler)`),
  //                                  never loosening `isMiddlewareMount` (that would let
  //                                  `app.all()` slip through the gate).
  //
  // This service's two mounts are wildcards, which is the only safe shape. Note `dubContext`
  // can sit at "*" here precisely because it is built with `allowGenerate: true` — it mints a
  // request id rather than 400ing the marker-only /health probe and the drain route.
  it("registers no concrete-path method-ALL entry (neither app.all() nor an exact-path use())", () => {
    const app = createApp(makeDeps());
    const allEntries = app.routes.filter((r) => r.method.toUpperCase() === "ALL");
    // Hono normalizes "*" to "/*". policyGate + dubContext, both catch-all.
    expect(allEntries.map((r) => r.path)).toEqual(["/*", "/*"]);
    expect(allEntries.every((r) => r.path === "*" || r.path.endsWith("/*"))).toBe(true);
    expect(protectableRouteKeys(app).filter((k) => k.startsWith("ALL "))).toEqual([]);
  });
});

// The イベント-relevant grants of each system role, read off the identity migrations that
// define them — `infra/d1/migrations/identity/`, which is the only source of truth here:
//   0002_system_roles.sql  domain keys. admin, maintainer AND organizer each get the full
//                          event:read + event:write + event:admin set (lines 19/32/46);
//                          member gets event:read alone (line 54). Nothing later revokes
//                          event:admin from anyone — `grep event:admin infra/d1/migrations`
//                          returns exactly those three grants.
//   0008_per_app_access.sql per-app tier. admin/maintainer/organizer get
//                          app:events:view + app:events:edit (17/32/46), member view only (59).
// So organizer is key-for-key identical to admin on this service. That is pre-existing
// behaviour, not something this table introduces: the old middleware also asked only for
// `event:admin`, which organizer holds, so organizers could always archive an event.
// The last three rows are not system roles but the key shapes worth freezing separately.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: [...FULL],
  maintainer: [...FULL],
  organizer: [...FULL],
  member: [...VIEWER],
  // A CUSTOM role at イベント=編集 that was never given the destructive key. Not a seeded
  // role, but the shape that makes `DELETE /events/:id`'s event:admin rule observable: it is
  // the only row in this matrix that distinguishes write from archive, so without it a future
  // edit downgrading that rule to event:write would change no expectation here.
  "edit-tier-without-event-admin": [...EDITOR],
  // イベント = 無効 in ロール管理, but the role still carries the legacy domain keys. Before
  // the gate this wrote through the API anyway; the tier now denies it outright.
  "disabled-tier-with-legacy-event-keys": ["event:read", "event:write", "event:admin"],
  // イベント = 閲覧 holding a legacy event:write. Reads only — the tier is authoritative.
  "view-tier-with-legacy-write-key": ["app:events:view", "event:read", "event:write"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so an internal-only route correctly lands in no
 * role's set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const READS = [
  "GET /actions/:id",
  "GET /events",
  "GET /events/:id",
  "GET /events/:id/actions",
  "GET /events/:id/details",
  "GET /events/:id/page-layout",
  "GET /events/:id/participants",
  "GET /events/:id/section-layout",
];
// event:write writes — everything an 編集 role can do short of archiving an event.
const WRITES = [
  "DELETE /actions/:id",
  "PATCH /actions/:id",
  "PATCH /events/:id",
  "POST /events",
  "POST /events/:id/actions",
  "PUT /events/:id/details",
  "PUT /events/:id/page-layout",
  "PUT /events/:id/section-layout",
];
// The one route demanding event:admin.
const ADMIN_ONLY = ["DELETE /events/:id"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /health"];

const FULL_SURFACE = [...READS, ...WRITES, ...ADMIN_ONLY].sort();
const READ_WRITE = [...READS, ...WRITES].sort();
const READ_ONLY = [...READS].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL_SURFACE,
    maintainer: FULL_SURFACE,
    // Identical to admin, and deliberately asserted as such: organizer holds event:admin per
    // 0002, so archiving an event IS open to organizers. See ROLE_KEYS above.
    organizer: FULL_SURFACE,
    member: READ_ONLY,
    // No event:admin => archiving an event is the one thing this role cannot do.
    "edit-tier-without-event-admin": READ_WRITE,
    "disabled-tier-with-legacy-event-keys": NONE,
    "view-tier-with-legacy-write-key": READ_ONLY,
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = [...INTERNAL_ROUTES, ...FULL_SURFACE].sort();
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(createApp(makeDeps())).sort());
  });

  it("a caller holding nothing reaches nothing — there is no public route here", () => {
    expect(allowedRoutes([])).toEqual(NONE);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });
});

describe("authn (the gate's 401, replacing requireAuth)", () => {
  it("every keyed route 401s without x-dub-user-id", async () => {
    const app = createApp(makeDeps());
    for (const [method, path] of [
      ["GET", "/events"],
      ["POST", "/events"],
      ["GET", "/events/event_in_scope"],
      ["PATCH", "/events/event_in_scope"],
      ["DELETE", "/events/event_in_scope"],
      ["GET", "/actions/action_in_scope"],
    ] as const) {
      const res = await call(app, method, path, { userId: null, body: method === "GET" ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("the x-dub-internal marker is not a substitute for a key on a keyed route", async () => {
    // The gate never lets the marker stand in for a permission (rule.ts): an s2s caller
    // propagating a user with no keys is still refused.
    const app = createApp(makeDeps({ ...fakeAuthz([]) }));
    const res = await call(app, "GET", "/events", { internal: true });
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe("missing_permission");
  });
});

// The INTERNAL rule at runtime, end to end through the real app. The matrix above proves
// `allows` is false for every key set; this proves the gate actually enforces the OTHER axis,
// which no key set can answer: a Service-Binding probe passes, and the identical request
// without the marker — i.e. anything that could arrive from outside, since api-gateway strips
// every inbound x-dub-* — is refused. This is the only route in the table whose rule is not a
// key rule, so it is the only one whose enforcement the matrix cannot cover.
describe("GET /health (INTERNAL) at runtime", () => {
  it("answers a service-to-service probe carrying x-dub-internal", async () => {
    // Exactly how app-health-monitor probes it: SVC_EVENT binding, full x-dub-* set, no user.
    const res = await call(createApp(makeDeps()), "GET", "/health", { userId: null, internal: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok", service: "event-service" });
  });

  it("403s without the marker, even for an authenticated caller holding every permission", async () => {
    const res = await call(createApp(makeDeps()), "GET", "/health");
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe("internal_only");
  });
});

describe("ロール管理 tier is now enforced (the behaviour change this table introduces)", () => {
  // Before the table, event-service asked only for the fine-grained event:* key, so a role
  // whose イベント app was set to 無効 could still drive the whole API.
  const legacyOnly = () => createApp(makeDeps({ ...fakeAuthz(["event:read", "event:write", "event:admin"]) }));

  it("a legacy key set without app:events:view is denied even on reads", async () => {
    const res = await call(legacyOnly(), "GET", "/events");
    expect(res.status).toBe(403);
    expect(res.json.error.details.missing).toContain("app:events:view");
  });

  it("閲覧 + a legacy event:write cannot write (the tier wins)", async () => {
    const deps = makeDeps({ ...fakeAuthz(["app:events:view", "event:read", "event:write"]) });
    const app = createApp(deps);
    deps.repo.seedEvent(eventRow());
    expect((await call(app, "GET", "/events/event_in_scope")).status).toBe(200);
    const res = await call(app, "PUT", "/events/event_in_scope/details", { body: { version: 0, data: {} } });
    expect(res.status).toBe(403);
    expect(res.json.error.details.missing).toContain("app:events:edit");
  });
});

// ───────────────────────── 3. handler-side event scope (b-5 layer 2) ─────────────────────────
//
// Every case below sends a caller holding EVERY key, so the table (layer 1) passes and the
// ONLY thing that can refuse the request is the instance-level assertion in the handler. The
// id used is an event in a DIFFERENT org — the one shape a caller can name that it has no
// business reaching — and the expected answer is an existence-hiding 404, never the row.
describe("handler-side event scope: a cross-event id is refused, not served", () => {
  function depsWithForeignRows() {
    const deps = makeDeps(); // FULL keys: layer 1 cannot be what denies anything here
    deps.repo.seedEvent(eventRow({ id: "event_in_scope" }));
    deps.repo.seedEvent(eventRow({ id: "event_foreign", orgId: "org_other" }));
    // An action that really exists, under an event the caller cannot reach.
    deps.repo.seedAction(actionRow({ id: "action_foreign", eventId: "event_foreign" }));
    deps.repo.seedAction(actionRow({ id: "action_in_scope", eventId: "event_in_scope" }));
    return deps;
  }

  // The 12 routes whose old guard passed `{ resourceType: "event", resourceId: :id }`.
  const EVENT_SCOPED: ReadonlyArray<readonly [string, (id: string) => string, unknown]> = [
    ["GET", (id) => `/events/${id}`, undefined],
    ["PATCH", (id) => `/events/${id}`, { version: 1, title: "hijacked" }],
    ["DELETE", (id) => `/events/${id}`, undefined],
    ["GET", (id) => `/events/${id}/participants`, undefined],
    ["GET", (id) => `/events/${id}/details`, undefined],
    ["PUT", (id) => `/events/${id}/details`, { version: 0, data: { memo: "hijacked" } }],
    ["GET", (id) => `/events/${id}/section-layout`, undefined],
    ["PUT", (id) => `/events/${id}/section-layout`, { version: 0, data: { order: [], hidden: [] } }],
    ["GET", (id) => `/events/${id}/page-layout`, undefined],
    ["PUT", (id) => `/events/${id}/page-layout`, { version: 0, data: { version: 1, blocks: [], updatedAt: "x" } }],
    ["GET", (id) => `/events/${id}/actions`, undefined],
    ["POST", (id) => `/events/${id}/actions`, { kind: "task_management", title: "hijacked" }],
  ];

  it("refuses all 12 event-scoped routes an out-of-scope event id (404, no data)", async () => {
    for (const [method, path, body] of EVENT_SCOPED) {
      const deps = depsWithForeignRows();
      const app = createApp(deps);
      const res = await call(app, method, path("event_foreign"), { ...(body !== undefined ? { body } : {}) });
      expect(res.status, `${method} ${path("event_foreign")}`).toBe(404);
      expect(res.json.error.code).toBe("NOT_FOUND");
    }
  });

  it("serves the SAME routes for an in-scope event id (so the 404s above are the scope check, not a broken route)", async () => {
    for (const [method, path, body] of EVENT_SCOPED) {
      const deps = depsWithForeignRows();
      const app = createApp(deps);
      const res = await call(app, method, path("event_in_scope"), { ...(body !== undefined ? { body } : {}) });
      expect([200, 201, 204], `${method} ${path("event_in_scope")} -> ${res.status}`).toContain(res.status);
    }
  });

  it("an out-of-scope event id is not even distinguishable from a missing one", async () => {
    const app = createApp(depsWithForeignRows());
    const foreign = await call(app, "GET", "/events/event_foreign");
    const missing = await call(app, "GET", "/events/event_nonexistent");
    expect(foreign.status).toBe(missing.status);
    expect(foreign.json.error.code).toBe(missing.json.error.code);
  });

  it("writes to an out-of-scope event leave no trace (the 404 precedes every mutation)", async () => {
    const deps = depsWithForeignRows();
    const app = createApp(deps);
    await call(app, "PUT", "/events/event_foreign/details", { body: { version: 0, data: { memo: "hijacked" } } });
    await call(app, "POST", "/events/event_foreign/actions", { body: { kind: "k", title: "hijacked" } });
    expect(await deps.repo.getEventDetails("event_foreign")).toBeNull();
    expect(deps.publisher.events).toEqual([]);
    expect(deps.audit.records).toEqual([]);
  });

  // /actions/:id never names an event, so the containment check is the one that resolves the
  // action's PARENT event — the gap docs/policy-coverage-inventory.md 2.5 flags as スコープ無し.
  const ACTION_SCOPED: ReadonlyArray<readonly [string, unknown]> = [
    ["GET", undefined],
    ["PATCH", { version: 1, title: "hijacked" }],
    ["DELETE", undefined],
  ];

  it("refuses an action id whose parent event is out of scope (404, no data)", async () => {
    for (const [method, body] of ACTION_SCOPED) {
      const deps = depsWithForeignRows();
      const app = createApp(deps);
      const res = await call(app, method, "/actions/action_foreign", { ...(body !== undefined ? { body } : {}) });
      expect(res.status, `${method} /actions/action_foreign`).toBe(404);
      expect(res.json.error.code).toBe("NOT_FOUND");
    }
  });

  it("serves the same action routes when the parent event IS in scope", async () => {
    for (const [method, body] of ACTION_SCOPED) {
      const deps = depsWithForeignRows();
      const app = createApp(deps);
      const res = await call(app, method, "/actions/action_in_scope", { ...(body !== undefined ? { body } : {}) });
      expect([200, 204], `${method} /actions/action_in_scope -> ${res.status}`).toContain(res.status);
    }
  });

  it("listing an event's actions never leaks another event's rows", async () => {
    const deps = depsWithForeignRows();
    const res = await call(createApp(deps), "GET", "/events/event_in_scope/actions");
    expect(res.status).toBe(200);
    expect((res.json.items as { id: string }[]).map((a) => a.id)).toEqual(["action_in_scope"]);
  });
});

// The second half of layer 2: a demand the table cannot carry because only the request BODY
// reveals it, asked WITH the event scope attached. `scopedTo` models an event:admin grant
// limited to one event, which is exactly what an identity resource-scoped assignment is.
describe("handler-side event scope: the body-dependent event:admin demand", () => {
  function depsWithAdminOn(eventIds: readonly string[]) {
    const deps = makeDeps({ ...fakeAuthz(FULL, { scopedTo: eventIds }) });
    deps.repo.seedEvent(eventRow({ id: "event_a", phase: "preparing" }));
    deps.repo.seedEvent(eventRow({ id: "event_b", phase: "preparing" }));
    return deps;
  }

  it("allows a backward transition on the event the admin grant covers", async () => {
    const app = createApp(depsWithAdminOn(["event_a"]));
    const res = await call(app, "PATCH", "/events/event_a", { body: { version: 1, phase: "planning" } });
    expect(res.status).toBe(200);
    expect(res.json.phase).toBe("planning");
  });

  it("refuses the same transition on a DIFFERENT event (403), though the keys are identical", async () => {
    const app = createApp(depsWithAdminOn(["event_a"]));
    const res = await call(app, "PATCH", "/events/event_b", { body: { version: 1, phase: "planning" } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");
  });

  it("a forward transition on that other event is still fine (event:write suffices)", async () => {
    const app = createApp(depsWithAdminOn(["event_a"]));
    const res = await call(app, "PATCH", "/events/event_b", { body: { version: 1, phase: "open" } });
    expect(res.status).toBe(200);
  });

  it("an 編集 role without event:admin cannot archive an event (table) nor roll a phase back (handler)", async () => {
    const deps = makeDeps({ ...fakeAuthz(EDITOR) });
    deps.repo.seedEvent(eventRow({ id: "event_a", phase: "preparing" }));
    const app = createApp(deps);
    expect((await call(app, "DELETE", "/events/event_a")).status).toBe(403);
    expect((await call(app, "PATCH", "/events/event_a", { body: { version: 1, phase: "planning" } })).status).toBe(403);
  });
});
