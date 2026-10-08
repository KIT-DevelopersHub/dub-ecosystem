// What makes the policy layer self-enforcing for this service. Four blocks:
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "member can now write the roster" without reading the table.
//  3. INTERNAL at runtime — the marker really is required (and nothing else substitutes).
//  4. AUTHENTICATED at runtime — a session is required, zero keys suffice, AND the route is
//     genuinely self-scoped (the client cannot name the subject), which is the only condition
//     under which this rule form is correct rather than merely permissive.
//
// 1 and 2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules;
// 3 and 4 drive the real app end to end.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { POLICY_TABLE } from "../src/policy-table";
import { createApp, makeDeps, fakeAuthz, call } from "./harness";

const buildApp = () => createApp(makeDeps());

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/members/people/:id/audit", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /members/people/:id/audit"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/members\/people\/:id\/audit/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await call(app, "GET", "/members/people/member_1/audit");
    expect(res.status).toBe(403);
    expect(res.json.error.message).toMatch(/no policy rule/);
  });
});

// The member-service-relevant keys of each system role, per the identity seed and migrations
// that define them. Derived facts, not guesses:
//   • `admin` = every catalog key (identity-roster/src/seed.ts SYSTEM_ROLES `ALL_KEYS()`),
//     so it holds both tiers of both apps plus identity:read / identity:admin.
//   • `maintainer` / `organizer` / `member` all hold `identity:read` and NOT `identity:admin`
//     (seed.ts MAINTAINER_KEYS and the two withAppAccess bundles). computeAppAccessKeys then
//     derives, via APP_ACCESS_RULES (seed.ts:31-32): 運営メンバー view (read=identity:read, no
//     edit because write=identity:admin is absent) and 参加届 view (openToAll). Identical key
//     sets for this service, so the three rows are deliberately identical.
// The last three rows are not roles but the shapes the table has to get right:
//   • the delegated 統括 role of #526 — per-app keys only, no identity:* domain key at all.
//   • a 参加届 reviewer without 名簿 access (both apps have their own row in ロール管理).
//   • the legacy "domain keys but the app is 無効" shape, which used to write through the API.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: [
    "identity:read",
    "identity:admin",
    "app:members:view",
    "app:members:edit",
    "app:participation:view",
    "app:participation:edit",
  ],
  maintainer: ["identity:read", "app:members:view", "app:participation:view"],
  organizer: ["identity:read", "app:members:view", "app:participation:view"],
  member: ["identity:read", "app:members:view", "app:participation:view"],
  "delegated-roster-editor": ["app:members:view", "app:members:edit"],
  "participation-reviewer": ["identity:read", "app:participation:view", "app:participation:edit"],
  "disabled-tiers-with-legacy-identity-keys": ["identity:read", "identity:admin"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so an INTERNAL route correctly lands in no
 * role's set — permission keys never open one to a request arriving through api-gateway —
 * while AUTHENTICATED correctly lands in every set, including the empty one.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

// 運営メンバー (名簿): 閲覧 reads, 編集 writes.
const ROSTER_READS = [
  "GET /members/overview",
  "GET /members/people/by-identity/:identityUserId",
  "GET /members/teams",
];
const ROSTER_WRITES = [
  "DELETE /members/people/:id",
  "DELETE /members/teams/:id",
  "PATCH /members/people/:id",
  "PATCH /members/teams/:id",
  "POST /members/people",
  "POST /members/people/:id/identity-link",
  "POST /members/teams",
];
// 参加届: 自分の届を出す (閲覧) / 他人の届を見る (閲覧 + identity:read) / 反映確定 (編集).
const PARTICIPATION_SUBMIT = ["POST /members/participation"];
const PARTICIPATION_ADMIN_READS = [
  "GET /members/participation",
  "GET /members/participation/:id/candidates",
];
const PARTICIPATION_RESOLVE = ["POST /members/participation/:id/resolve"];
// Self-scoped, no key — every signed-in caller, by design (チームメンション).
const SELF = ["GET /members/me/mention-teams"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = [
  "GET /health",
  "GET /members/internal/me/participation",
  "GET /members/internal/team-members",
  "POST /members/internal/me/participation",
  "POST /members/internal/participation",
];
// The whole external surface — what a caller can reach through api-gateway at most.
const FULL = [
  ...ROSTER_READS,
  ...ROSTER_WRITES,
  ...PARTICIPATION_SUBMIT,
  ...PARTICIPATION_ADMIN_READS,
  ...PARTICIPATION_RESOLVE,
  ...SELF,
].sort();

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    // 名簿は読めるが書けない / 参加届は出せて一覧も見られるが反映確定はできない。
    maintainer: [...ROSTER_READS, ...PARTICIPATION_SUBMIT, ...PARTICIPATION_ADMIN_READS, ...SELF].sort(),
    organizer: [...ROSTER_READS, ...PARTICIPATION_SUBMIT, ...PARTICIPATION_ADMIN_READS, ...SELF].sort(),
    member: [...ROSTER_READS, ...PARTICIPATION_SUBMIT, ...PARTICIPATION_ADMIN_READS, ...SELF].sort(),
    // #526: 名簿の委譲は identity:* を一切持たずに成立する。参加届 は別アプリなので届かない。
    "delegated-roster-editor": [...ROSTER_READS, ...ROSTER_WRITES, ...SELF].sort(),
    // 逆向きの非対称: 参加届の審査者は名簿 CRUD に届かない。
    "participation-reviewer": [
      ...PARTICIPATION_SUBMIT,
      ...PARTICIPATION_ADMIN_READS,
      ...PARTICIPATION_RESOLVE,
      ...SELF,
    ].sort(),
    // 両アプリ 無効 + レガシーなドメインキー: 表以前は identity:admin で書けていた形。
    "disabled-tiers-with-legacy-identity-keys": [...SELF].sort(),
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
    expect(everyRoute).toEqual(protectableRouteKeys(buildApp()).sort());
  });

  it("a caller holding nothing reaches only the self-scoped route (there is no PUBLIC one)", () => {
    expect(allowedRoutes([])).toEqual(SELF);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });

  it("the two apps do not leak into each other (no cross-app escalation)", () => {
    const roster = allowedRoutes(ROLE_KEYS["delegated-roster-editor"]!);
    for (const route of [...PARTICIPATION_SUBMIT, ...PARTICIPATION_ADMIN_READS, ...PARTICIPATION_RESOLVE]) {
      expect(roster).not.toContain(route);
    }
    const reviewer = allowedRoutes(ROLE_KEYS["participation-reviewer"]!);
    for (const route of [...ROSTER_READS, ...ROSTER_WRITES]) expect(reviewer).not.toContain(route);
  });
});

// The non-key rule forms at runtime, end to end through the real app.
describe("INTERNAL and AUTHENTICATED at runtime", () => {
  it("the liveness probe passes with the marker and 403s without it", async () => {
    const app = buildApp();
    const probe = await call(app, "GET", "/health", { userId: null, internal: true });
    expect(probe.status).toBe(200);
    const outside = await call(app, "GET", "/health", { userId: null });
    expect(outside.status).toBe(403);
    expect(outside.json.error.details.reason).toBe("internal_only");
  });

  it("an authenticated caller holding NOTHING still reads their own mention teams", async () => {
    // AUTHENTICATED: authn only, zero identity subrequests. The granter is never consulted.
    const app = createApp(makeDeps({ authz: async () => [] }));
    const res = await call(app, "GET", "/members/me/mention-teams", { userId: "usr_plain" });
    expect(res.status).toBe(200);
    expect(res.json.myTeamIds).toEqual([]);
  });

  it("...but an UNauthenticated one does not (AUTHENTICATED is not PUBLIC)", async () => {
    const res = await call(buildApp(), "GET", "/members/me/mention-teams", { userId: null });
    expect(res.status).toBe(401);
  });

  // The precondition that makes AUTHENTICATED legitimate here rather than merely permissive
  // (rule.ts: "the client cannot name the subject"). If a key-less caller could name someone
  // else, this route would need keys — so pin that it cannot, not just that it is open.
  it("the self-scoped route cannot be pointed at another user (the subject is the session)", async () => {
    const deps = makeDeps();
    const seeder = createApp(deps);
    const hq = await call(seeder, "POST", "/members/teams", { body: { name: "統括チーム" } });
    const corp = await call(seeder, "POST", "/members/teams", { body: { name: "法人チーム" } });
    const link = async (name: string, teamId: string, identityUserId: string) => {
      const m = await call(seeder, "POST", "/members/people", { body: { name, status: "added", teamIds: [teamId] } });
      await call(seeder, "POST", `/members/people/${m.json.id}/identity-link`, {
        body: { identityUserId, version: m.json.version },
      });
    };
    await link("自分", hq.json.id, "usr_self");
    await link("他人", corp.json.id, "usr_other");

    // Same repo, but a caller holding no key at all — the AUTHENTICATED shape.
    const app = createApp({ ...deps, authz: fakeAuthz(new Set<identity.PermissionKey>()) });
    // Every way a client could try to name a subject: path has no segment to use, so these
    // are the query/body shapes rule.ts calls out. All are ignored by the handler.
    for (const q of ["", "?userId=usr_other", "?identityUserId=usr_other", "?teamIds=" + corp.json.id]) {
      const res = await call(app, "GET", `/members/me/mention-teams${q}`, { userId: "usr_self" });
      expect(res.status).toBe(200);
      expect(res.json.myTeamIds).toEqual([hq.json.id]); // 自分の所属だけ。他人の所属は漏れない
    }
    // ...and the response carries no roster row of anyone — only team metadata.
    const res = await call(app, "GET", "/members/me/mention-teams", { userId: "usr_self" });
    expect(Object.keys(res.json).sort()).toEqual(["myTeamIds", "teams"]);
    expect(JSON.stringify(res.json)).not.toContain("他人");
  });
});
