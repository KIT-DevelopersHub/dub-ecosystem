// The tests that make the policy layer self-enforcing for the notification service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions, and that includes BOTH mounts: `mountNotif` registers
//     the whole notification surface twice (bare paths for internal Service-Binding
//     callers, "/notifications/*" for api-gateway's verbatim proxy), so 16 routes exist
//     twice over and a table that covered only one prefix would leave the other 16 denied.
//     The second case proves the mechanism by adding an ungated route and showing both the
//     test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens (or tightens) a permission shows up as a changed line
//     in the diff of this file, so a reviewer sees "member can now publish broadcasts"
//     without reading the table.
//  3. INTERNAL AT RUNTIME — the s2s-only routes end to end through the real app: with the
//     x-dub-internal marker they serve, without it they 403, even for a caller holding
//     every permission key.
//  4. SELF-SCOPE REGRESSION — the handler-side half of the two-layer design (gate.ts's
//     RESOURCE SCOPE note). The table can only say "this caller may use an inbox"; that
//     holding `notif:inbox:self` does not let them read or mutate SOMEONE ELSE's inbox is
//     enforced by the handlers scoping every query to `c.get("userId")`, and this is the
//     test that keeps it true.
//
// 1-2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { PermissionGranter, RouteRule } from "@dub/policy-gate";
import type { identity, notification } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { INITIAL_RELEASE_NOTES } from "../src/config";
import { listPreferenceOverrides } from "../src/repo";
import { makeTestEnv, fakeIdentity, type TestEnvHandle } from "./helpers";

type PermissionKey = identity.PermissionKey;

/** A granter that reports exactly `keys` as held, whatever is asked — the gate's port, so
 *  a test can state a caller's key set instead of mocking identity's wire protocol. */
function granterFor(keys: readonly PermissionKey[]): PermissionGranter {
  const held = new Set(keys);
  return async (_userId, _orgId, requested) => requested.filter((k) => held.has(k));
}

/** The real app, with the authorization decision point stated directly. `identity` is
 *  stubbed so the release seed / role fan-out paths never reach for a Fetcher. */
function buildApp(keys: readonly PermissionKey[] = []) {
  return createApp({ authz: granterFor(keys), identity: fakeIdentity({ allUsers: [] }) });
}

const reqOf = (app: ReturnType<typeof createApp>, h: TestEnvHandle) => (path: string, init: RequestInit = {}) =>
  app.request(path, init, h.env as unknown as Record<string, unknown>);

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  // The service-specific trap: `mountNotif` runs twice, so every notification route exists
  // under BOTH prefixes and the table must carry both. If someone "tidies up" the table by
  // deleting the bare-path block, this is the test that notices.
  it("covers BOTH mounts — the bare paths and the /notifications gateway segment", () => {
    const registered = protectableRouteKeys(buildApp());
    const bare = registered.filter((k) => !k.includes(" /notifications/") && !k.includes(" /internal/") && !k.includes(" /feedback"));
    const segment = registered.filter((k) => k.includes(" /notifications/"));
    // 16 notification routes per mount (notify, release, 5 manage, 6 inbox, 2 preferences),
    // minus /internal/seed-releases which the filters above exclude from `bare`.
    expect(bare.length).toBeGreaterThan(0);
    expect(segment).toHaveLength(16);
    for (const key of registered) expect(Object.keys(POLICY_TABLE)).toContain(key);
    // Every bare notification route has a /notifications twin carrying the SAME rule.
    for (const [route, rule] of Object.entries(POLICY_TABLE)) {
      if (route.includes(" /notifications/")) {
        const [method, path] = route.split(" ") as [string, string];
        const twin = `${method} ${path.replace("/notifications", "")}`;
        expect(POLICY_TABLE[twin as keyof typeof POLICY_TABLE]).toEqual(rule);
      }
    }
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp(["app:notifications:view", "notif:inbox:self", "notif:admin"]);
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/notifications/inbox/export", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /notifications/inbox/export"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/notifications\/inbox\/export/);

    // Fail-closed, not fail-open: unreachable even for a caller holding the inbox keys.
    const h = makeTestEnv();
    const res = await reqOf(app, h)("/notifications/inbox/export", { headers: { "x-dub-user-id": "u1" } });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// The notification-relevant grants of each system role, per the identity migrations that
// define them: 0002 (notif:send / notif:admin), 0004 (notif:inbox:self / notif:prefs:self
// for EVERY role), 0006 (notif:broadcast_publish for admin + maintainer), 0008 (per-app
// tier: admin 閲覧+編集, maintainer/organizer/member 閲覧 only).
//
// NOTE the asymmetry this freezes, and it is a real one: `app:notifications:edit` is seeded
// to role_sys_admin ALONE, so every 編集-tier rule in the table (POST /release, the
// manage publish/unpublish mutations, PATCH /feedback/:id/read, PATCH /preferences) is
// admin-only today even where the role still carries the matching fine-grained key —
// maintainer holds notif:broadcast_publish but no 編集, so it can LIST the manage screen
// and not publish from it. That is the ロール管理 tier being authoritative server-side
// (the point of pairing appLevel with the domain key); changing it is a ロール管理 /
// migration decision, visible here rather than hidden in a handler.
const ROLE_KEYS: Record<string, PermissionKey[]> = {
  admin: [
    "app:notifications:view",
    "app:notifications:edit",
    "notif:send",
    "notif:admin",
    "notif:broadcast_publish",
    "notif:inbox:self",
    "notif:prefs:self",
  ],
  maintainer: [
    "app:notifications:view",
    "notif:send",
    "notif:admin",
    "notif:broadcast_publish",
    "notif:inbox:self",
    "notif:prefs:self",
  ],
  organizer: ["app:notifications:view", "notif:send", "notif:inbox:self", "notif:prefs:self"],
  member: ["app:notifications:view", "notif:inbox:self", "notif:prefs:self"],
  // 通知 = 無効 in ロール管理 while the role still carries the legacy domain keys. Before the
  // gate this reached the whole surface; the tier now denies everything but the probe.
  "disabled-tier-with-legacy-notif-keys": [
    "notif:admin",
    "notif:broadcast_publish",
    "notif:inbox:self",
    "notif:prefs:self",
  ],
  anonymous: [],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own
 * rule comparison. `allows` (not `missingKeys`) is the right primitive: it answers the
 * reachability question for every rule form, so the five INTERNAL routes land in no role's
 * set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

/** Both mounts of a notification path — the pair the table always carries together. */
const both = (method: string, path: string): string[] => [`${method} ${path}`, `${method} /notifications${path}`];

// Reachable by the open internet, deliberately (index.ts serves it off the Service Binding).
const PROBE = ["GET /internal/health"];
// 閲覧 on 通知, no fine-grained key: the widget files feedback AS the caller.
const FEEDBACK_SUBMIT = ["POST /feedback"];
// 閲覧 on 通知 + notif:inbox:self / notif:prefs:self (read side).
const SELF_READ = [
  ...both("GET", "/inbox"),
  ...both("GET", "/inbox/ws-ticket"),
  ...both("GET", "/inbox/unread-count"),
  ...both("PATCH", "/inbox/:id/read"),
  ...both("PATCH", "/inbox/:id/unread"),
  ...both("POST", "/inbox/read-all"),
  ...both("GET", "/preferences"),
];
// 編集 on 通知 + notif:prefs:self.
const SELF_WRITE = [...both("PATCH", "/preferences")];
// notif:admin surfaces.
const ADMIN_READ = ["GET /feedback"];
const ADMIN_WRITE = ["PATCH /feedback/:id/read", ...both("POST", "/release")];
// notif:broadcast_publish surfaces.
const MANAGE_READ = [...both("GET", "/manage")];
const MANAGE_WRITE = [
  ...both("POST", "/manage/:id/publish"),
  ...both("POST", "/manage/publish-batch"),
  ...both("POST", "/manage/:id/unpublish"),
  ...both("POST", "/manage/unpublish-batch"),
];
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = [
  "POST /internal/events-async",
  ...both("POST", "/notify"),
  ...both("POST", "/internal/seed-releases"),
];

const sorted = (...groups: string[][]) => [...new Set(groups.flat())].sort();

describe("role x endpoint matrix (frozen)", () => {
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    // Every external route — admin is the only role holding 編集 on 通知.
    admin: sorted(PROBE, FEEDBACK_SUBMIT, SELF_READ, SELF_WRITE, ADMIN_READ, ADMIN_WRITE, MANAGE_READ, MANAGE_WRITE),
    // 閲覧 only: lists the manage screen and reads feedback, publishes neither.
    maintainer: sorted(PROBE, FEEDBACK_SUBMIT, SELF_READ, ADMIN_READ, MANAGE_READ),
    organizer: sorted(PROBE, FEEDBACK_SUBMIT, SELF_READ),
    member: sorted(PROBE, FEEDBACK_SUBMIT, SELF_READ),
    // The tier is authoritative: legacy domain keys without 閲覧 reach nothing but the probe.
    "disabled-tier-with-legacy-notif-keys": sorted(PROBE),
    // A caller holding nothing still reaches the PUBLIC probe, and only that.
    anonymous: sorted(PROBE),
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]));
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = sorted(
      PROBE,
      FEEDBACK_SUBMIT,
      SELF_READ,
      SELF_WRITE,
      ADMIN_READ,
      ADMIN_WRITE,
      MANAGE_READ,
      MANAGE_WRITE,
      INTERNAL_ROUTES,
    );
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(buildApp()).sort());
    // 16 routes per mount x 2, plus the probe, the event landing route and 3 feedback routes.
    expect(everyRoute).toHaveLength(37);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    const reachable = allowedRoutes(everyKey);
    for (const route of INTERNAL_ROUTES) expect(reachable).not.toContain(route);
  });
});

// The INTERNAL rules at runtime, end to end through the real app: a Service-Binding call
// (freeq-drain / a deploy hook sends exactly this marker) passes; the same request without
// it is refused — and api-gateway strips every inbound x-dub-*, so "without it" is
// everything that could arrive from outside.
describe("INTERNAL routes at runtime", () => {
  const S2S = { "x-dub-internal": "1" };
  // A caller holding literally every notification key, to prove permissions are a separate
  // axis: they do not open an internal door.
  const EVERY_KEY = [...new Set(Object.values(ROLE_KEYS).flat())];

  it("POST /internal/seed-releases serves a call carrying x-dub-internal", async () => {
    const h = makeTestEnv();
    const res = await reqOf(buildApp(EVERY_KEY), h)("/internal/seed-releases", { method: "POST", headers: S2S });
    expect(res.status).toBe(202);
    expect((await res.json()) as { total: number }).toMatchObject({ total: INITIAL_RELEASE_NOTES.length });
  });

  it("403s (internal_only) without the marker, even holding every permission key", async () => {
    const h = makeTestEnv();
    const res = await reqOf(buildApp(EVERY_KEY), h)("/internal/seed-releases", {
      method: "POST",
      headers: { "x-dub-user-id": "usr_admin" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "internal_only",
    );
  });

  it("the same holds for POST /notify on BOTH mounts", async () => {
    const h = makeTestEnv();
    const req = reqOf(buildApp(EVERY_KEY), h);
    const body = JSON.stringify({ type: "system.announcement", recipientIds: ["u1"], title: "t", body: "b", channels: ["in_app"] });
    const json = { "content-type": "application/json" };

    for (const path of ["/notify", "/notifications/notify"]) {
      const ok = await req(path, { method: "POST", headers: { ...json, ...S2S }, body });
      expect(ok.status).toBe(202);
      const denied = await req(path, { method: "POST", headers: { ...json, "x-dub-user-id": "usr_admin" }, body });
      expect(denied.status).toBe(403);
    }
  });
});

// The handler-side layer the table deliberately cannot express. `notif:inbox:self` is a
// TYPE-level key — "may use an inbox" — held by every system role; whose inbox is decided
// by the handler scoping every query to the authenticated user. If that scoping ever
// regressed into an org-wide read, the table would still look correct, so this is the only
// guard. (See docs/policy-coverage-inventory.md b-5.)
describe("self-scope regression (inbox belongs to the caller, not to the key holder)", () => {
  const SELF_KEYS: PermissionKey[] = ["app:notifications:view", "notif:inbox:self", "notif:prefs:self"];
  const internalPost = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json", "x-dub-internal": "1" },
    body: JSON.stringify(body),
  });

  // `task.assigned`, NOT a broadcast type: system.announcement / release are forced into
  // every user's inbox on read by design (backfillBroadcastInbox, late-join safety), so
  // they cannot show whether per-user scoping works.
  async function seedInboxFor(userId: string) {
    const h = makeTestEnv();
    const req = reqOf(buildApp(SELF_KEYS), h);
    const posted = await req(
      "/notify",
      internalPost({ type: "task.assigned", recipientIds: [userId], title: "u1 only", body: "b", channels: ["in_app"] }),
    );
    expect(posted.status).toBe(202);
    const page = (await (await req("/inbox", { headers: { "x-dub-user-id": userId } })).json()) as notification.ListInboxResponse;
    expect(page.items).toHaveLength(1);
    return { req, itemId: page.items[0]!.id };
  }

  it("a caller holding notif:inbox:self sees ONLY its own items on both mounts", async () => {
    const { req } = await seedInboxFor("u1");
    for (const path of ["/inbox", "/notifications/inbox"]) {
      const res = await req(path, { headers: { "x-dub-user-id": "u2" } });
      expect(res.status).toBe(200); // the KEY check passes — u2 may use an inbox
      expect(((await res.json()) as notification.ListInboxResponse).items).toHaveLength(0); // just not u1's
    }
    const count = await req("/inbox/unread-count", { headers: { "x-dub-user-id": "u2" } });
    expect((await count.json()) as { count: number }).toEqual({ count: 0 });
  });

  it("cannot mark ANOTHER user's inbox item read / unread (404, not 200) on either mount", async () => {
    const { req, itemId } = await seedInboxFor("u1");
    for (const prefix of ["", "/notifications"]) {
      for (const action of ["read", "unread"]) {
        const res = await req(`${prefix}/inbox/${itemId}/${action}`, {
          method: "PATCH",
          headers: { "x-dub-user-id": "u2" },
        });
        expect(res.status).toBe(404);
      }
    }
    // u1's row is untouched: still exactly one unread item for the owner.
    const owner = await req("/inbox/unread-count", { headers: { "x-dub-user-id": "u1" } });
    expect((await owner.json()) as { count: number }).toEqual({ count: 1 });
  });

  it("read-all only clears the caller's own items", async () => {
    const { req } = await seedInboxFor("u1");
    const res = await req("/inbox/read-all", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dub-user-id": "u2" },
      body: "{}",
    });
    expect((await res.json()) as { updated: number }).toEqual({ updated: 0 });
    const owner = await req("/inbox/unread-count", { headers: { "x-dub-user-id": "u1" } });
    expect((await owner.json()) as { count: number }).toEqual({ count: 1 });
  });

  it("preferences are keyed on the authenticated user, not on a client-supplied id", async () => {
    const h = makeTestEnv();
    const req = reqOf(buildApp([...SELF_KEYS, "app:notifications:edit"]), h);
    const patch = await req("/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-dub-user-id": "u1" },
      // A hostile body naming someone else: the handler ignores it entirely.
      body: JSON.stringify({ userId: "u2", entries: [{ type: "task.assigned", channels: ["in_app"] }] }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { userId: string }).userId).toBe("u1");

    const other = await req("/preferences", { headers: { "x-dub-user-id": "u2" } });
    expect(((await other.json()) as { userId: string }).userId).toBe("u2");
    // The stored rows prove it: the override landed on u1 and u2 has none at all.
    expect((await listPreferenceOverrides(h.db, "u1")).length).toBeGreaterThan(0);
    expect(await listPreferenceOverrides(h.db, "u2")).toEqual([]);
  });
});
