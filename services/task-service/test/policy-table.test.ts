// The tests that make the policy layer self-enforcing for task-service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "一般メンバー can now archive" without reading the table.
//  3. THE SERVICE PRINCIPAL — the one seam this service adds to the gate (see
//     `taskPolicyGate` in src/app.ts). Locked down end to end: an allow-listed s2s caller
//     passes a keyed route with no user id (github-sync's GitHub import depends on it), and
//     a caller that is NOT allow-listed does not, marker or no marker.
//
// 1 and 2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity, task } from "@dub/types";
import { buildApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { makeHarness, userInit, serviceInit } from "./helpers";

function buildTestApp() {
  return buildApp(makeHarness().deps);
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildTestApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildTestApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildTestApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/tasks/:id/history", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /tasks/:id/history"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/tasks\/:id\/history/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.request("/tasks/task_1/history", userInit("GET"));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// The task-relevant grants of each system role, per the identity migrations that define
// them: 0002 (domain keys — note 一般メンバー gets task:read/write but NOT task:delete) and
// 0008 (per-app tier: all four roles hold app:tasks:view + :edit).
// The last two rows are not roles but the two legacy shapes the tier was added to fix.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:tasks:view", "app:tasks:edit", "task:read", "task:write", "task:delete"],
  maintainer: ["app:tasks:view", "app:tasks:edit", "task:read", "task:write", "task:delete"],
  organizer: ["app:tasks:view", "app:tasks:edit", "task:read", "task:write", "task:delete"],
  // 一般メンバー may create and edit tasks but not archive one (no task:delete in 0002).
  member: ["app:tasks:view", "app:tasks:edit", "task:read", "task:write"],
  // マイタスク = 無効 in ロール管理, but the role still carries the legacy task:* domain keys.
  // Before the gate this wrote through the API anyway; the tier now denies it outright.
  "disabled-tier-with-legacy-task-keys": ["task:read", "task:write", "task:delete"],
  // マイタスク = 閲覧 holding legacy write keys. Reads only — the tier is authoritative.
  "view-tier-with-legacy-write-keys": ["app:tasks:view", "task:read", "task:write", "task:delete"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so an INTERNAL route correctly lands in no
 * role's set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const READS = [
  "GET /tasks",
  "GET /tasks/:id",
  "GET /tasks/:id/attachments",
  "GET /tasks/dependencies",
];
const WRITES = [
  "DELETE /tasks/:id/attachments/:attachmentId",
  "PATCH /tasks/:id",
  "POST /tasks",
  "POST /tasks/:id/attachments",
  "PUT /tasks/:id/dependencies",
];
// Archiving is the one write behind the higher fine-grained key (task:delete).
const ARCHIVE = ["DELETE /tasks/:id"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /health", "POST /internal/events-async"];
// The whole external surface — what a caller can reach through api-gateway at most.
const FULL = [...READS, ...WRITES, ...ARCHIVE].sort();
const NO_ARCHIVE = [...READS, ...WRITES].sort();
const READ_ONLY = [...READS].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: FULL,
    organizer: FULL,
    member: NO_ARCHIVE,
    "disabled-tier-with-legacy-task-keys": NONE,
    "view-tier-with-legacy-write-keys": READ_ONLY,
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
    expect(everyRoute).toEqual(protectableRouteKeys(buildTestApp()).sort());
  });

  it("a caller holding nothing reaches nothing — there is no public route here", () => {
    expect(allowedRoutes([])).toEqual(NONE);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });
});

// The INTERNAL rules at runtime, end to end through the real app. GET /health was
// UNAUTHENTICATED before this migration (it sits outside the old /internal/* guard —
// inventory a-9); it is now closed to anything but a Service-Binding call.
describe("INTERNAL routes at runtime", () => {
  const S2S = { "x-dub-internal": "1" };

  it("GET /health answers a service-to-service probe carrying x-dub-internal", async () => {
    const res = await buildTestApp().request("/health", { headers: S2S });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "task-service" });
  });

  it("GET /health 403s without the marker, even for an authenticated caller", async () => {
    const res = await buildTestApp().request("/health", userInit("GET"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "internal_only",
    );
  });
});

// The service principal — the ONE thing `taskPolicyGate` adds to the plain gate, and the
// reason the table's keyed routes still work for github-sync, whose task writes carry no
// acting user at all (services/github-sync/src/engine/sync.ts `sysCtx`).
describe("service principal (allow-listed x-dub-caller)", () => {
  it("passes a keyed route with no x-dub-user-id, attributed as service:<caller>", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/tasks", serviceInit("POST", { eventId: "evt_1", title: "gh" }));
    expect(res.status).toBe(201);
    expect(h.events.byName("task.created")[0]!.actorId).toBe("service:github-sync");
  });

  it("still passes when identity grants the user NOTHING (the keys are not asked about)", async () => {
    const h = makeHarness();
    // Deny every key this route's rule names: an ordinary user would 403.
    for (const k of ["app:tasks:view", "app:tasks:edit", "task:write"] as const) h.authz.denied.add(k);
    const app = buildApp(h.deps);
    expect((await app.request("/tasks", serviceInit("POST", { eventId: "evt_1", title: "gh" }))).status).toBe(201);
    expect((await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "u" }))).status).toBe(403);
  });

  it("is the ALLOW-LIST that decides, not the marker: an unknown caller gets 401", async () => {
    const app = buildTestApp();
    const res = await app.request("/tasks", serviceInit("POST", { eventId: "evt_1", title: "x" }, "evil-service"));
    expect(res.status).toBe(401);
  });

  it("a propagated user id makes it that USER's request, keys and all", async () => {
    const h = makeHarness();
    h.authz.denied.add("task:write");
    const app = buildApp(h.deps);
    // Marker + allow-listed caller, but a user id is present -> user principal (principal.ts).
    const init = serviceInit("POST", { eventId: "evt_1", title: "x" });
    const headers = { ...(init.headers as Record<string, string>), "x-dub-user-id": "usr_alice" };
    const res = await app.request("/tasks", { ...init, headers });
    expect(res.status).toBe(403);
  });
});

// §3(d) residual that CANNOT live in the table: the required key depends on a query param.
describe("instance layer: includeArchived demands task:delete on top of the table's rule", () => {
  it("403s a reader who holds task:read but not task:delete", async () => {
    const h = makeHarness();
    h.authz.denied.add("task:delete");
    const res = await buildApp(h.deps).request("/tasks?eventId=evt_1&includeArchived=true", userInit("GET"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "missing_permission",
    );
  });

  it("allows it for a caller who holds task:delete", async () => {
    const res = await buildTestApp().request("/tasks?eventId=evt_1&includeArchived=true", userInit("GET"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as task.ListTasksResponse).items).toEqual([]);
  });
});
