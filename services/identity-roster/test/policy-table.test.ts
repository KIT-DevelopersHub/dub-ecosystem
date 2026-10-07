// The tests that make the policy layer self-enforcing for identity-roster — the service that
// IS the ecosystem's authorization decision point, which is what makes two of these blocks
// specific to it:
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions, so "I added an endpoint and forgot the table line" is a
//     red build instead of a silent hole. The second case proves it by adding an ungated
//     route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the reachable route set of every system role, frozen. Any
//     table edit that loosens a rule shows up as an added line in the diff of this file.
//  3. THE INTERNAL RULES AT RUNTIME — above all that `POST /authz/check` is unreachable from
//     outside: it is the evaluator every other service calls, and an external caller must
//     never be able to use it as a permission oracle.
//  4. THE IN-PROCESS GRANTER — that gating a request makes NO /authz/check subrequest. Wiring
//     the normal `sharedAuthzGranter` here would make this service call itself for every
//     gated request (unbounded recursion); this block is the regression test for that.
//  5. THE SELF EXCEPTION — the handler-layer half of `GET /identity/users/:id`: a caller with
//     no identity:read reads their OWN detail and nobody else's.
//
// Blocks 1-2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the
// exact comparison the gate runs in production — never a test-local re-reading of the rules.
import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { POLICY_TABLE } from "../src/policy-table";
import { createInProcessGranter } from "../src/in-process-granter";
import { IdentityService } from "../src/service";
import { makeHarness, asUser, internal, jsonBody, ORG_ID } from "./harness";

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", async () => {
    const h = await makeHarness();
    expect(checkRouteCoverage(h.app, POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(h.app, POLICY_TABLE)).not.toThrow();
  });

  it("lists all 24 endpoints of this service", async () => {
    const h = await makeHarness();
    expect(protectableRouteKeys(h.app)).toHaveLength(24);
    expect(Object.keys(POLICY_TABLE)).toHaveLength(24);
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const h = await makeHarness();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule. A roster
    // dump is the worst case for it to happen on.
    h.app.get("/identity/users/:id/audit", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(h.app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /identity/users/:id/audit"]);
    expect(() => assertRouteCoverage(h.app, POLICY_TABLE)).toThrow(/GET \/identity\/users\/:id\/audit/);

    // Fail-closed, not fail-open: unreachable even for the org's admin, who holds every key.
    const res = await h.app.request(`/identity/users/${h.memberId}/audit`, asUser(h.adminId));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// The identity-relevant keys of each system role, per src/seed.ts: admin holds the whole
// PERMISSION_CATALOG; maintainer / organizer / member hold identity:read and, because
// seed.ts's APP_ACCESS_RULES maps the 管理 app's read AND write to identity:admin, no
// app:admin:* key at all. The last three rows are not roles but the shapes this table had to
// get right (and that roles.test.ts exercises at runtime).
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["identity:read", "identity:admin", "app:admin:view", "app:admin:edit"],
  maintainer: ["identity:read"],
  organizer: ["identity:read"],
  member: ["identity:read"],
  // 管理 = 無効 in ロール管理 while the role still carries identity:admin: the tier denies
  // every write even though the legacy domain key is present (roles.test.ts "app_disabled").
  "admin-key-without-tier": ["identity:read", "identity:admin"],
  // 管理 = 閲覧 holding identity:admin. Reads only — 閲覧 means see-but-not-change on the
  // server too, not just a greyed button (roles.test.ts "read_only").
  "view-tier-admin": ["identity:read", "identity:admin", "app:admin:view"],
  // A provisioned user with no role at all (the state users.test.ts's user_bare is in).
  "no-roles": [],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may reach, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the
 * reachability question for every rule form, so the seven INTERNAL routes correctly land in
 * no role's set — no permission key opens an internal-only door to a request that arrived
 * through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

// Reachable with NO key at all, by explicit decision: the public health probe and the
// self-detail route (AUTHENTICATED — whose record it is decides, and that is the handler's
// job; see the self-exception block at the bottom).
const OPEN = ["GET /health", "GET /identity/users/:id"];
// identity:read — the shared cross-app roster read.
const READS = [
  "GET /identity/orgs",
  "GET /identity/permissions/catalog",
  "GET /identity/roles",
  "GET /identity/users",
  "GET /identity/users/:id/roles",
];
// appLevel("admin","edit","identity:admin") — every roster/RBAC write.
const WRITES = [
  "DELETE /identity/roles/:id",
  "DELETE /identity/users/:id/roles/:assignmentId",
  "PATCH /identity/roles/:id",
  "PATCH /identity/users/:id",
  "POST /identity/roles",
  "POST /identity/users/:id/offboard",
  "POST /identity/users/:id/roles",
  "POST /identity/users/invite",
  "POST /identity/users/sync-email-routing",
  "POST /identity/users/sync-email-routing/preview",
];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = [
  "GET /internal/users",
  "GET /internal/users/:id/permissions",
  "GET /users/:id",
  "POST /authz/check",
  "POST /internal/users/:id/profile",
  "POST /internal/users/lookup",
  "POST /users/provision",
];
const READ_ONLY = [...OPEN, ...READS].sort();
const FULL = [...OPEN, ...READS, ...WRITES].sort();

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: READ_ONLY,
    organizer: READ_ONLY,
    member: READ_ONLY,
    "admin-key-without-tier": READ_ONLY,
    "view-tier-admin": READ_ONLY,
    "no-roles": [...OPEN].sort(),
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", async () => {
    const h = await makeHarness();
    const everyRoute = [...OPEN, ...READS, ...WRITES, ...INTERNAL_ROUTES].sort();
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(h.app).sort());
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });

  // The single most dangerous line in the table: assigning a role is how every permission in
  // the system is granted. Checked at runtime, not just in the matrix, because this is the
  // one route whose loosening would be an immediate privilege-escalation path.
  it("the role-assignment route is unreachable for every role below 管理=編集 (runtime)", async () => {
    for (const role of ["member", "admin-key-without-tier", "view-tier-admin"] as const) {
      const h = await makeHarness();
      const caller = await userWithKeys(h, role, ROLE_KEYS[role]!);
      const res = await h.app.request(
        `/identity/users/${h.memberId}/roles`,
        jsonBody(asUser(caller), "POST", { roleId: h.adminRoleId }),
      );
      expect([role, res.status]).toEqual([role, 403]);
    }
  });
});

/** A user holding exactly `keys` through a fresh non-system role. */
async function userWithKeys(
  h: Awaited<ReturnType<typeof makeHarness>>,
  name: string,
  keys: identity.PermissionKey[],
): Promise<string> {
  const now = h.deps.now();
  await h.repo.createRole({ id: `role_${name}`, orgId: ORG_ID, name, isSystem: false, permissions: keys, createdAt: now, updatedAt: now });
  const userId = `user_${name}`;
  await h.repo.createUser({
    id: userId, orgId: ORG_ID, email: `${name}@devhub.jp`, displayName: name, furigana: null,
    githubLogin: null, avatarUrl: null, status: "active", source: "manual", createdAt: now, updatedAt: now,
  });
  await h.repo.createAssignment({ id: `ra_${name}`, userId, roleId: `role_${name}`, orgId: ORG_ID, resourceType: null, resourceId: null, grantedBy: h.adminId, grantedAt: now });
  return userId;
}

// The INTERNAL rule at runtime, end to end through the real app. POST /authz/check is the one
// that matters most: it is the evaluator @dub/policy-gate's granter calls over SVC_IDENTITY
// from every other service, so it must answer a Service-Binding call and refuse everything
// else — api-gateway strips every inbound x-dub-*, so "no marker" is what an external request
// looks like no matter what it sends.
describe("INTERNAL routes at runtime", () => {
  const checkBody = (userId: string) => ({ subjectUserId: userId, orgId: ORG_ID, checks: [{ permission: "identity:read" }] });

  it("POST /authz/check answers a service-to-service call carrying x-dub-internal", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/authz/check", jsonBody(internal(), "POST", checkBody(h.memberId)));
    expect(res.status).toBe(200);
    expect((await res.json()) as identity.AuthzCheckResponse).toMatchObject({ decisions: [{ allowed: true }] });
  });

  it("POST /authz/check is unreachable from outside — 403 even for the org admin", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/authz/check", jsonBody(asUser(h.adminId), "POST", checkBody(h.memberId)));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("internal_only");
  });

  it("every other INTERNAL route 403s without the marker and is served with it", async () => {
    const h = await makeHarness();
    const withMarker = await h.app.request(`/internal/users/${h.memberId}/permissions`, internal());
    expect(withMarker.status).toBe(200);

    // The whole internal surface, with the most privileged possible external caller.
    const routes: [string, string][] = [
      ["POST", "/users/provision"],
      ["GET", `/users/${h.memberId}`],
      ["POST", `/internal/users/${h.memberId}/profile`],
      ["GET", "/internal/users"],
      ["POST", "/internal/users/lookup"],
      ["GET", `/internal/users/${h.memberId}/permissions`],
    ];
    for (const [method, path] of routes) {
      const init = method === "GET" ? asUser(h.adminId) : jsonBody(asUser(h.adminId), method, {});
      const res = await h.app.request(path, init);
      // 403 before any validation of the body — the marker check is the first thing that runs.
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });
});

// ── the in-process granter: identity-roster must never gate itself over the wire ──
describe("in-process PermissionGranter (no /authz/check subrequest)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gates a key-checked read and a key-checked write with ZERO fetch calls", async () => {
    const h = await makeHarness();
    // Any wire granter would reach the binding through fetch (Service Binding .fetch or the
    // global). identity-roster's Env (src/env.ts) has no identity binding at all, so a global
    // fetch spy at 0 is the complete statement here: nothing left this isolate.
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const read = await h.app.request("/identity/users", asUser(h.memberId)); // ["identity:read"]
    expect(read.status).toBe(200);
    const write = await h.app.request(
      "/identity/roles",
      jsonBody(asUser(h.adminId), "POST", { name: "gated", permissions: ["task:read"] }),
    ); // appLevel("admin","edit","identity:admin") — a 2+1 key rule
    expect(write.status).toBe(201);
    const denied = await h.app.request(
      "/identity/roles",
      jsonBody(asUser(h.memberId), "POST", { name: "nope", permissions: ["task:read"] }),
    );
    expect(denied.status).toBe(403); // the deny path must not go on the wire either

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("decides from the repo rows in-process (one lookup per request, any rule size)", async () => {
    const h = await makeHarness();
    const assignments = vi.spyOn(h.repo, "listAssignmentsByUser");

    // A 3-key rule (app:admin:view + app:admin:edit + identity:admin).
    const res = await h.app.request(
      "/identity/users/invite",
      jsonBody(asUser(h.adminId), "POST", { email: "granter@devhub.jp", displayName: "G" }),
    );
    expect(res.status).toBe(201);
    // The gate's decision cost exactly ONE assignment lookup (the invite handler itself then
    // does its own work) — proof the adapter loads the effective set once and intersects,
    // rather than asking per key.
    expect(assignments.mock.calls.filter((c) => c[0] === h.adminId)).toHaveLength(1);
  });

  it("satisfies the PermissionGranter contract: held subset, caller's order, [] for no keys", async () => {
    const h = await makeHarness();
    const granted = createInProcessGranter(new IdentityService(h.deps));

    expect(await granted(h.adminId, ORG_ID, ["identity:read", "identity:admin"])).toEqual([
      "identity:read",
      "identity:admin",
    ]);
    // member holds identity:read but not identity:admin — the subset, not an all-or-nothing.
    expect(await granted(h.memberId, ORG_ID, ["identity:admin", "identity:read"])).toEqual(["identity:read"]);
    expect(await granted(h.memberId, ORG_ID, [])).toEqual([]);
    // An unknown user holds nothing (fail closed), and a disabled one loses everything.
    expect(await granted("user_ghost", ORG_ID, ["identity:read"])).toEqual([]);
    await h.repo.updateUser(h.memberId, { status: "disabled" }, h.deps.now());
    expect(await granted(h.memberId, ORG_ID, ["identity:read"])).toEqual([]);
  });

  it("no source file wires the wire granter (createAuthzGranter / sharedAuthzGranter)", () => {
    // A static guard, because the failure mode is not a red test but an unbounded recursion
    // in production: this service serving /authz/check would call /authz/check to authorize
    // the call. Keep the decision in-process — see src/in-process-granter.ts.
    const dir = new URL("../src/", import.meta.url);
    // Only what is IMPORTED counts (the names appear in prose in the two files that explain
    // why they are not used, so a bare substring search would always be red).
    const imported = (src: string): string[] =>
      [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@dub\/policy-gate"/g)]
        .flatMap((m) => m[1]!.split(","))
        .map((s) => s.trim());
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) =>
        imported(readFileSync(new URL(f, dir), "utf8")).some((n) =>
          ["createAuthzGranter", "sharedAuthzGranter"].includes(n),
        ),
      );
    expect(offenders).toEqual([]);
  });
});

// ── the handler-layer half of GET /identity/users/:id ──
// The table rule is AUTHENTICATED because self-read must work without identity:read; the key
// check for everyone ELSE lives in the handler, where the subject is known. Both halves are
// pinned here: delete either and this block goes red.
describe("self exception (GET /identity/users/:id)", () => {
  it("a caller with no identity:read reads their own detail but nobody else's", async () => {
    const h = await makeHarness();
    await h.repo.createUser({
      id: "user_bare", orgId: ORG_ID, email: "bare@devhub.jp", displayName: "Bare", furigana: null,
      githubLogin: null, avatarUrl: null, status: "active", source: "manual", createdAt: "t", updatedAt: "t",
    });

    const self = await h.app.request("/identity/users/user_bare", asUser("user_bare"));
    expect(self.status).toBe(200);
    expect(((await self.json()) as identity.IdentityUser).id).toBe("user_bare");

    const other = await h.app.request(`/identity/users/${h.adminId}`, asUser("user_bare"));
    expect(other.status).toBe(403);
    expect(await other.text()).toMatch(/identity:read/);
  });

  it("a caller holding identity:read reads anyone, and no session reads nothing (401)", async () => {
    const h = await makeHarness();
    expect((await h.app.request(`/identity/users/${h.adminId}`, asUser(h.memberId))).status).toBe(200);
    const anon = await h.app.request(`/identity/users/${h.adminId}`);
    expect(anon.status).toBe(401); // AUTHENTICATED still demands a session
  });
});
