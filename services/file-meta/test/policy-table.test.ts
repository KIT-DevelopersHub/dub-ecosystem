// The tests that make the policy layer self-enforcing for file-meta.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This turns "I added an endpoint and forgot the table line"
//     from a silent hole into a red build; the second case proves it by actually adding an
//     ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any future
//     table edit that loosens a permission shows up as an added line in the diff of this file,
//     so a reviewer sees "member can now upload" without reading the table.
//  3. The two INTERNAL routes end to end, since for file-meta this is a real change: both had
//     a weaker door before (health had NO check at all — inventory §3(a-9) — and
//     events-async a hand-rolled 404).
//
// 1 and 2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PermissionGranter, RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import {
  createMemoryBlobStore,
  createMemoryFileRepo,
  createSpyAudit,
  createSpyEmit,
  createStubGranter,
} from "./mem";

const ALL_KEYS: identity.PermissionKey[] = [
  "app:driveshare:view",
  "app:driveshare:edit",
  "file:read",
  "file:write",
  "file:admin",
];

function buildApp(authz: PermissionGranter = createStubGranter({ root: ALL_KEYS })) {
  return createApp({
    repo: createMemoryFileRepo(),
    blobs: createMemoryBlobStore(),
    emit: createSpyEmit().emit,
    audit: createSpyAudit().audit,
    authz,
    consume: async () => "ack",
  });
}

const AUTHED = { "x-dub-user-id": "root" };

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/files/meta/:id/history", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /files/meta/:id/history"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/files\/meta\/:id\/history/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.request("/files/meta/file_x/history", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// File-relevant grants of each system role, per the identity migrations that define them:
//   0002 (domain keys: maintainer gets file:read/write), 0005 (admin gets the file:* set),
//   0008 (per-app tier: admin/maintainer 編集, organizer/member 閲覧 on Drive共有).
// The last two rows are not roles but the two legacy shapes the table was written to fix.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:driveshare:view", "app:driveshare:edit", "file:read", "file:write", "file:admin"],
  maintainer: ["app:driveshare:view", "app:driveshare:edit", "file:read", "file:write"],
  organizer: ["app:driveshare:view"],
  member: ["app:driveshare:view"],
  // Drive共有 = 無効 in ロール管理, but the role still carries the legacy file keys. Before the
  // gate this uploaded and deleted through the API anyway; the tier now denies it outright.
  "disabled-tier-with-legacy-file-keys": ["file:read", "file:write", "file:admin"],
  // Drive共有 = 閲覧 holding a legacy file:write. Reads only — the tier is authoritative.
  "view-tier-with-legacy-write-key": ["app:driveshare:view", "file:read", "file:write"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the reachability
 * question for every rule form, so an INTERNAL route correctly lands in no role's set —
 * permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

const READS = ["GET /files/:id/download", "GET /files/meta/:id", "GET /files/search"];
const WRITES = [
  "DELETE /files/meta/:id",
  "DELETE /files/meta/:id/links",
  "PATCH /files/meta/:id",
  "POST /files",
  "POST /files/meta",
  "POST /files/meta/:id/links",
];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /internal/health", "POST /internal/events-async"];
// The whole external surface — what a caller can reach through api-gateway at most.
const FULL = [...READS, ...WRITES].sort();
const READ_ONLY = [...READS].sort();
const NONE: string[] = [];

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: FULL,
    // 閲覧 without file:read reaches nothing: both halves are required, by design.
    organizer: NONE,
    member: NONE,
    "disabled-tier-with-legacy-file-keys": NONE,
    "view-tier-with-legacy-write-key": READ_ONLY,
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

  it("a caller holding nothing reaches nothing — there is no public route here", () => {
    expect(allowedRoutes([])).toEqual(NONE);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });

  it("file:admin is an escalation the handlers check, never a key the table demands", () => {
    // If a rule ever demanded file:admin, a plain maintainer would lose a route it has today.
    expect(allowedRoutes(ROLE_KEYS.maintainer!)).toEqual(FULL);
  });
});

// The INTERNAL rule at runtime, end to end through the real app. Both routes gained a door
// here: /internal/health had none at all (§3(a-9)) and /internal/events-async had a
// hand-rolled 404. A Service-Binding caller passes; the same request without the marker —
// i.e. anything that could arrive from outside, since api-gateway strips every inbound
// x-dub-* — is refused.
describe("the two INTERNAL routes", () => {
  const S2S = { "x-dub-internal": "1" };

  it("GET /internal/health answers a service-to-service probe", async () => {
    const res = await buildApp().request("/internal/health", { headers: S2S });
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "ok", service: "file-meta" });
  });

  it("GET /internal/health 403s without the marker, even holding every file key", async () => {
    const res = await buildApp().request("/internal/health", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "internal_only",
    );
  });

  it("POST /internal/events-async 403s without the marker", async () => {
    const res = await buildApp().request("/internal/events-async", {
      method: "POST",
      headers: { ...AUTHED, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("POST /internal/events-async needs no permission key for a legitimate s2s drain", async () => {
    // A cron drain carries the marker and no user: INTERNAL (not internalWithKeys) is what
    // makes that a 202 instead of a 401 that would retry the producer's row forever.
    const app = buildApp(createStubGranter({}));
    const res = await app.request("/internal/events-async", {
      method: "POST",
      headers: { ...S2S, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(202);
  });
});
