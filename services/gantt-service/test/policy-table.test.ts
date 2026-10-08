// The tests that make the policy layer self-enforcing for gantt-service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file.
//  3. THE EXPLICIT EXCLUSION (§3(e) e-5) — the WebSocket entry bypasses Hono, so coverage
//     cannot see it. It is named in `NON_HONO_ROUTES` and pinned here, together with the
//     invariant that pays for excluding it: the ticket-issuing route carries the same rule as
//     the chart read, because that issuance is the socket's only authorization.
//
// 1 and 2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { POLICY_TABLE, NON_HONO_ROUTES } from "../src/policy-table";
import { fakeAuthClient, fakeUpstream, fakeViewRepo, fakeCache, fakeRealtime } from "./helpers";
import type { AppDeps } from "../src/ports";

const ENV = {} as Env;
const AUTHED = { "x-dub-request-id": "req_test", "x-dub-user-id": "user_a" };

function buildDeps(allow = true): AppDeps {
  const auth = fakeAuthClient({ allow });
  const rt = fakeRealtime();
  return {
    upstream: () => fakeUpstream({}),
    cache: () => fakeCache(),
    views: () => fakeViewRepo(),
    authClient: () => auth,
    realtime: () => rt,
  };
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(createApp(buildDeps()), POLICY_TABLE)).toEqual({
      ok: true,
      unlisted: [],
      orphaned: [],
    });
    expect(() => assertRouteCoverage(createApp(buildDeps()), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = createApp(buildDeps());
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/gantt/export", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /gantt/export"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/gantt\/export/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const res = await app.request("/gantt/export?eventId=event_1", { headers: AUTHED }, ENV);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// The gantt-relevant grants of each system role, per the identity migrations: 0002 (domain
// keys — all four roles hold event:read and task:write) and 0008 (per-app tier: all four hold
// app:gantt:view + :edit). The four roles are therefore indistinguishable here, so the rows
// that carry the information are the synthetic ones below them: each drops exactly one key to
// show which half of the rule that key guards.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:gantt:view", "app:gantt:edit", "event:read", "task:write"],
  maintainer: ["app:gantt:view", "app:gantt:edit", "event:read", "task:write"],
  organizer: ["app:gantt:view", "app:gantt:edit", "event:read", "task:write"],
  member: ["app:gantt:view", "app:gantt:edit", "event:read", "task:write"],
  // ガント = 無効 in ロール管理, legacy domain keys retained. Before this table the tier was
  // never consulted server-side; now it denies the whole app outright.
  "disabled-tier-with-legacy-keys": ["event:read", "task:write"],
  // ガント = 閲覧 holding a legacy task:write. May look, may not move a bar.
  "view-tier-with-legacy-write-key": ["app:gantt:view", "event:read", "task:write"],
  // ガント = 編集 but the role lost task:write: the fine-grained key still guards the write.
  "edit-tier-without-task-write": ["app:gantt:view", "app:gantt:edit", "event:read"],
  // No event:read at all. Reaches ONLY the task-scoped write at the TABLE layer — which is
  // exactly the two-layer split: `assertEventScope` is what then decides per event, and for a
  // caller with no event:read anywhere it denies every linked task (see app.test.ts).
  "no-event-read": ["app:gantt:view", "app:gantt:edit", "task:write"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive here: it answers the
 * reachability question for every rule form, so the INTERNAL route correctly lands in no
 * role's set while the PUBLIC one lands in all of them.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

// PUBLIC by decision (src/index.ts exempts it from the "host must be svc" guard).
const PUBLIC_ROUTES = ["GET /health"];
const READS = [
  "GET /gantt",
  "GET /gantt/dependencies",
  "GET /gantt/views",
  "GET /gantt/ws-ticket",
  "PUT /gantt/views",
];
const WRITE = ["PATCH /gantt/rows/:taskId"];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["POST /internal/events-async"];

const FULL = [...PUBLIC_ROUTES, ...READS, ...WRITE].sort();
const READ_ONLY = [...PUBLIC_ROUTES, ...READS].sort();
const WRITE_ONLY = [...PUBLIC_ROUTES, ...WRITE].sort();
const PUBLIC_ONLY = [...PUBLIC_ROUTES].sort();

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: FULL,
    organizer: FULL,
    member: FULL,
    "disabled-tier-with-legacy-keys": PUBLIC_ONLY,
    "view-tier-with-legacy-write-key": READ_ONLY,
    "edit-tier-without-task-write": READ_ONLY,
    "no-event-read": WRITE_ONLY,
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
    expect(everyRoute).toEqual(protectableRouteKeys(createApp(buildDeps())).sort());
  });

  it("a caller holding nothing reaches the PUBLIC probe and nothing else", () => {
    expect(allowedRoutes([])).toEqual(PUBLIC_ONLY);
  });

  it("no role, however privileged, reaches the INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });
});

// §3(e) e-5 — the one entry point of this Worker that is excluded from the table, written
// down rather than silently omitted.
describe("explicit exclusion: GET /ws/:eventId (DO-direct, outside Hono)", () => {
  it("is genuinely NOT a Hono route, which is why the gate cannot reach it", () => {
    const registered = protectableRouteKeys(createApp(buildDeps()));
    for (const route of NON_HONO_ROUTES) {
      expect(registered).not.toContain(route);
      // ...and therefore must not be in the table either: a key there would judge nothing
      // while reading, to a reviewer, as if the socket were gated by it.
      expect(Object.keys(POLICY_TABLE)).not.toContain(route);
    }
  });

  it("the price of the exclusion: ws-ticket issuance carries the chart-read rule", () => {
    // The GanttRoom DO verifies the HMAC ticket and the Origin but checks no permission, so
    // `GET /gantt/ws-ticket` is the ONLY authorization the socket gets. Loosening it below
    // the chart read would hand the live chart to callers who may not fetch it.
    expect(POLICY_TABLE["GET /gantt/ws-ticket"]).toEqual(POLICY_TABLE["GET /gantt"]);
  });
});

describe("the two key-free rules at runtime", () => {
  it("GET /health is PUBLIC: 200 with no session at all", async () => {
    const res = await createApp(buildDeps()).request("/health", {}, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "gantt-service" });
  });

  // INTERNAL, both directions. The marker is the whole door: it opens for a genuine s2s call
  // carrying NO session and no permission at all, and stays shut for an external caller
  // holding every key in ロール管理. That asymmetry is the axis `INTERNAL` encodes, so both
  // halves are asserted rather than just the refusal.
  const ENVELOPE = JSON.stringify({ id: "evt_x", name: "mail.sent", requestId: "req_test", payload: {} });

  it("the INTERNAL route accepts an s2s call carrying the marker and nothing else (202)", async () => {
    const res = await createApp(buildDeps(false)).request(
      "/internal/events-async",
      { method: "POST", headers: { "content-type": "application/json", "x-dub-internal": "1" }, body: ENVELOPE },
      ENV,
    );
    // buildDeps(false) = identity denies every key, and there is no x-dub-user-id either:
    // proof the marker alone is what opened it.
    expect(res.status).toBe(202);
  });

  it("an authenticated caller holding every key still cannot reach the INTERNAL route", async () => {
    const res = await createApp(buildDeps(true)).request(
      "/internal/events-async",
      { method: "POST", headers: { ...AUTHED, "content-type": "application/json" }, body: ENVELOPE },
      ENV,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "internal_only",
    );
  });
});
