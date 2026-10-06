// The tests that make the policy layer self-enforcing for mail-gateway — the largest table
// in the fleet (35 routes), so the four properties below are what stand between it and a
// silent hole:
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This turns "I added an endpoint and forgot the table
//     line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens a permission shows up as an added line in the diff of
//     this file, so a reviewer sees "maintainer can now issue email addresses" without
//     reading the table. Includes the explicit `mail:admin` boundary.
//  3. INTERNAL AT RUNTIME — the four internal-only routes end to end through the real app,
//     above all `POST /send`: a reachable-from-outside send endpoint is an open relay, and
//     that guard used to be one hand-written `if` inside the handler.
//  4. SCOPE REGRESSION — the layer the table deliberately does NOT cover. Holding
//     mail:read / mail:send is type-level permission; it must still not reach ANOTHER
//     account's message or scheduled row. Policy-gate's own header calls this the migration
//     hazard (an owner check silently becoming org-wide), so it is asserted here, next to
//     the table that now grants the key.
//
// 1-2 go through @dub/policy-gate's own `allows` / `protectableRouteKeys`, i.e. the exact
// comparison the gate runs in production — never a test-local re-reading of the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity, mail } from "@dub/types";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";
import { makeEnv, fakeIdentityFetcher } from "./helpers";

const app = createApp();

function headers(over: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-dub-request-id": "req_policy", ...over };
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(createApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(createApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const ungated = createApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule. A mail
    // route is the worst case for it — this one would dump a raw message body.
    ungated.get("/mail/messages/:id/raw", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(ungated, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /mail/messages/:id/raw"]);
    expect(() => assertRouteCoverage(ungated, POLICY_TABLE)).toThrow(/GET \/mail\/messages\/:id\/raw/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every permission.
    const { env } = makeEnv();
    const res = await ungated.fetch(
      new Request("https://svc/mail/messages/mailin_1/raw", { headers: headers({ "x-dub-user-id": "usr_admin" }) }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no policy rule/);
  });
});

// ───────────────────────── role x endpoint matrix ─────────────────────────
// Mail-relevant grants of each system role, per the identity migrations that define them:
//   0002 (domain keys: admin gets mail:send/read/admin, maintainer gets mail:send/read,
//         organizer and member get NO mail key at all),
//   0003 (admin additionally gets mail:read_all — oversight, which is a SCOPE widener and
//         deliberately appears nowhere in this table; see the scope block at the bottom),
//   0008 (per-app tier: admin/maintainer get app:mail:view + app:mail:edit, organizer and
//         member get neither).
// The last three rows are not roles but the shapes the table was written to fix.
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:mail:view", "app:mail:edit", "mail:read", "mail:read_all", "mail:send", "mail:admin"],
  maintainer: ["app:mail:view", "app:mail:edit", "mail:read", "mail:send"],
  organizer: [],
  member: [],
  // メール = 無効 in ロール管理, but the role still carries the legacy domain keys. Before the
  // gate this read and SENT mail through the API anyway; the tier now denies it outright.
  "disabled-tier-with-legacy-mail-keys": ["mail:read", "mail:send"],
  // メール = 閲覧 holding a legacy mail:send. Reads only — the tier is authoritative, so the
  // compose/schedule routes are closed even though the send key is present.
  "view-tier-with-legacy-send-key": ["app:mail:view", "mail:read", "mail:send"],
  // A roster administrator with the メール app switched off entirely. Still administers mail
  // INFRASTRUCTURE (mailboxes, Email Routing) and still cannot read one message — which is
  // precisely why the admin rules are the bare key and the user rules are appLevel(...).
  "mail-admin-without-app-tier": ["mail:admin"],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the
 * reachability question for every rule form, so the four INTERNAL routes correctly land in
 * no role's set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

// 閲覧 on メール + mail:read. The two POSTs are here on purpose: both only touch the
// reader's own view of mail they can already see (one message's read flag; their personal
// star/archive/trash flags).
const READS = [
  "GET /mail/flags",
  "GET /mail/messages",
  "GET /mail/messages/:id",
  "GET /mail/messages/:id/attachments/:attId",
  "GET /mail/scheduled",
  "GET /mail/scheduled/:id",
  "GET /mail/sent",
  "GET /mail/sent/:id",
  "GET /mail/sent/:id/attachments/:attId",
  "GET /mail/threads/:id",
  "POST /mail/flags/:threadId",
  "POST /mail/messages/:id/read",
];
// 編集 on メール + mail:send — everything that puts or queues a message on the wire.
const WRITES = [
  "DELETE /mail/scheduled/:id",
  "PATCH /mail/scheduled/:id",
  "POST /mail/outbox",
  "POST /mail/scheduled",
];
// The Cloudflare Email Routing proxy — address issuance and forwarding rules. The subset
// `mail:admin` guards that is reachable at a URL beginning /mail/admin/.
const EMAIL_ROUTING_ADMIN = [
  "DELETE /mail/admin/email-routing/addresses/:id",
  "DELETE /mail/admin/email-routing/issued-addresses/:id",
  "DELETE /mail/admin/email-routing/rules/:id",
  "GET /mail/admin/email-routing/addresses",
  "GET /mail/admin/email-routing/issued-addresses",
  "GET /mail/admin/email-routing/roster-addresses",
  "GET /mail/admin/email-routing/rules",
  "PATCH /mail/admin/email-routing/issued-addresses/:id",
  "PATCH /mail/admin/email-routing/rules/:id",
  "POST /mail/admin/email-routing/addresses",
  "POST /mail/admin/email-routing/issued-addresses",
  "POST /mail/admin/email-routing/rules",
];
// Everything `mail:admin` guards: the routing proxy plus the shared-mailbox definitions.
const ADMIN = [...EMAIL_ROUTING_ADMIN, "GET /mail/mailboxes", "POST /mail/mailboxes/:id"].sort();
// Not reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["GET /health/quota", "GET /internal/health/ready", "GET /internal/status", "POST /send"];
// The one PUBLIC route, hence in EVERY row below including the empty-key one. Stated rather
// than hidden: that is the fact a matrix is for.
const PUBLIC_ROUTES = ["GET /internal/health"];

const sorted = (...groups: string[][]): string[] => [...new Set(groups.flat())].sort();
const FULL = sorted(PUBLIC_ROUTES, READS, WRITES, ADMIN);
const USER_SURFACE = sorted(PUBLIC_ROUTES, READS, WRITES);
const READ_ONLY = sorted(PUBLIC_ROUTES, READS);
const ADMIN_ONLY = sorted(PUBLIC_ROUTES, ADMIN);
const PUBLIC_ONLY = sorted(PUBLIC_ROUTES);

describe("role x endpoint matrix (frozen)", () => {
  // Loosening a rule adds a route to one of these arrays — a visible diff in review.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: USER_SURFACE,
    organizer: PUBLIC_ONLY,
    member: PUBLIC_ONLY,
    "disabled-tier-with-legacy-mail-keys": PUBLIC_ONLY,
    "view-tier-with-legacy-send-key": READ_ONLY,
    "mail-admin-without-app-tier": ADMIN_ONLY,
  };

  it("matches the committed matrix for every role", () => {
    const actual = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([role, keys]) => [role, allowedRoutes(keys)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("the matrix covers the whole table (no route omitted from the snapshot)", () => {
    const everyRoute = sorted(PUBLIC_ROUTES, INTERNAL_ROUTES, READS, WRITES, ADMIN);
    expect(everyRoute).toEqual(Object.keys(POLICY_TABLE).sort());
    expect(everyRoute).toEqual(protectableRouteKeys(createApp()).sort());
    expect(everyRoute).toHaveLength(35);
  });

  // THE boundary this service's admin console depends on: mail administration (issuing
  // @developershub.jp addresses, rewriting forwarding rules — i.e. who receives the org's
  // mail) is reachable ONLY with mail:admin. maintainer is the row that matters: it holds
  // every other mail key and the full app tier, and still reaches none of it.
  it("no role lacking mail:admin reaches a single /mail/admin/* route", () => {
    for (const [role, keys] of Object.entries(ROLE_KEYS)) {
      if (keys.includes("mail:admin")) continue;
      const reachable = allowedRoutes(keys);
      for (const route of EMAIL_ROUTING_ADMIN) {
        expect(reachable, `${role} must not reach ${route}`).not.toContain(route);
      }
      // Same key, same conclusion for the shared-mailbox definitions.
      expect(reachable).not.toContain("GET /mail/mailboxes");
      expect(reachable).not.toContain("POST /mail/mailboxes/:id");
    }
    // ...and the holder does reach all of them, so the assertion above is not vacuous.
    expect(allowedRoutes(["mail:admin"])).toEqual(ADMIN_ONLY);
  });

  it("a caller holding nothing reaches only the one PUBLIC route", () => {
    expect(allowedRoutes([])).toEqual(PUBLIC_ONLY);
  });

  it("no role, however privileged, reaches an INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    const reachable = allowedRoutes(everyKey);
    for (const route of INTERNAL_ROUTES) expect(reachable).not.toContain(route);
  });

  // mail:read_all is oversight (read EVERY account's mail). It widens SCOPE inside handlers
  // and must never appear as an entry-layer requirement — a route demanding it would be
  // reachable only by admins, quietly breaking every other role's own inbox.
  it("mail:read_all is a scope key, not a table key — no rule demands it", () => {
    const rules = JSON.stringify(Object.values(POLICY_TABLE));
    expect(rules).not.toContain("mail:read_all");
  });
});

// ───────────────────── INTERNAL rules, end to end through the real app ─────────────────────
// api-gateway strips every inbound x-dub-*, so "without the marker" is exactly what an
// external request looks like no matter what it sends.
describe("internal-only routes (INTERNAL) at runtime", () => {
  const S2S = { "x-dub-internal": "1" };
  const reasonOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason ?? "";

  it.each([
    ["GET", "/internal/health/ready"],
    ["GET", "/internal/status"],
    ["GET", "/health/quota"],
  ])("%s %s answers a service-to-service call and 403s without the marker", async (method, path) => {
    const { env } = makeEnv();
    const ok = await app.fetch(new Request(`https://svc${path}`, { method, headers: headers(S2S) }), env);
    expect(ok.status).toBeLessThan(400);

    const denied = await app.fetch(new Request(`https://svc${path}`, { method, headers: headers() }), env);
    expect(denied.status).toBe(403);
    expect(await reasonOf(denied)).toBe("internal_only");
  });

  it("GET /internal/health is the one PUBLIC route: 200 with no headers at all", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/internal/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "mail-gateway" });
  });

  // THE open-relay guard. If this ever answers an external request, anyone on the internet
  // can send mail as @developershub.jp.
  describe("POST /send (open-relay guard)", () => {
    const body = JSON.stringify({ to: [{ email: "a@x.com" }], subject: "Hi", textBody: "Body" } satisfies mail.SendMailRequest);
    const send = (h: Record<string, string>, env: ReturnType<typeof makeEnv>["env"]) =>
      app.fetch(new Request("https://svc/send", { method: "POST", headers: headers(h), body }), env);

    it("accepts a system-origin internal call carrying the marker (202)", async () => {
      const { env } = makeEnv();
      const res = await send({ ...S2S, "x-dub-caller": "notification", "x-dub-idempotency-key": "pol-1" }, env);
      expect(res.status).toBe(202);
    });

    it("403s without the marker — an external caller cannot reach it", async () => {
      const { env } = makeEnv();
      const res = await send({ "x-dub-idempotency-key": "pol-2" }, env);
      expect(res.status).toBe(403);
      expect(await reasonOf(res)).toBe("internal_only");
    });

    it("403s without the marker even for a caller holding EVERY mail permission", async () => {
      // No permission key, however privileged, opens an internal door (rule.ts). An admin
      // session arriving through api-gateway is still an external request here.
      const { env } = makeEnv();
      const res = await send({ "x-dub-user-id": "usr_admin", "x-dub-idempotency-key": "pol-3" }, env);
      expect(res.status).toBe(403);
      expect(await reasonOf(res)).toBe("internal_only");
    });

    it("still enforces mail:send on the USER when an s2s call propagates one (layer 2)", async () => {
      // The conditional half of the old guard, kept in the handler because it depends on the
      // request (is a user id present?) and so cannot be a static rule. Without it, one
      // compromised s2s caller could send as any user. See policy-table.ts's note.
      const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
      const res = await send({ ...S2S, "x-dub-user-id": "usr_bob", "x-dub-idempotency-key": "pol-4" }, env);
      expect(res.status).toBe(403);
      expect(await reasonOf(res)).not.toBe("internal_only"); // the KEY check, not the marker
    });
  });
});

// The matrix above is computed from the rules; this is the same claim measured through the
// real app, so "the tier is authoritative" is a tested runtime fact and not just arithmetic
// over the table. It is THE behaviour change this migration makes: before it, a role whose
// メール app was 無効 or 閲覧 in ロール管理 still read and sent through the API as long as it
// carried the legacy mail:read / mail:send domain keys.
describe("the ロール管理 tier is enforced at runtime, not just in the table", () => {
  it("legacy domain keys without the app tier (メール = 無効) now 403 on read AND send", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["mail:read", "mail:send"]) });
    const read = await app.fetch(new Request("https://svc/mail/messages", { headers: headers({ "x-dub-user-id": "usr_legacy" }) }), env);
    expect(read.status).toBe(403);
    const send = await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: headers({ "x-dub-user-id": "usr_legacy" }),
        body: JSON.stringify({ to: [{ email: "a@x.com" }], subject: "Hi", textBody: "b" }),
      }),
      env,
    );
    expect(send.status).toBe(403);
  });

  it("メール = 閲覧 with a legacy mail:send reads (200) but cannot send (403)", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["app:mail:view", "mail:read", "mail:send"]) });
    const read = await app.fetch(new Request("https://svc/mail/messages", { headers: headers({ "x-dub-user-id": "usr_viewer" }) }), env);
    expect(read.status).toBe(200);
    const send = await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: headers({ "x-dub-user-id": "usr_viewer" }),
        body: JSON.stringify({ to: [{ email: "a@x.com" }], subject: "Hi", textBody: "b" }),
      }),
      env,
    );
    expect(send.status).toBe(403);
    // Specifically the missing 編集 tier key, not the domain key it does hold.
    const err = (await send.json()) as { error: { details?: { missing?: string[] } } };
    expect(err.error.details?.missing).toEqual(["app:mail:edit"]);
  });

  it("mail:admin alone administers Email Routing but reads no message", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["mail:admin"]) });
    const h = headers({ "x-dub-user-id": "usr_mailadmin" });
    // Past the gate; 503 because CF_EMAIL_ROUTING_TOKEN is unset in this env (the feature
    // fails loud) — the point is that it is NOT 403.
    const admin = await app.fetch(new Request("https://svc/mail/admin/email-routing/rules", { headers: h }), env);
    expect(admin.status).toBe(503);
    const mailboxes = await app.fetch(new Request("https://svc/mail/mailboxes", { headers: h }), env);
    expect(mailboxes.status).toBe(200);
    const inbox = await app.fetch(new Request("https://svc/mail/messages", { headers: h }), env);
    expect(inbox.status).toBe(403);
  });
});

// ───────────────────── scope regression (the layer NOT in the table) ─────────────────────
// policy-gate's gate.ts: "every route whose old guard passed a resourceId needs a
// handler-side assertion in the same commit as its table entry". mail-gateway's old guards
// did not pass a resourceId, but `scopeOf` / `ownerOf` / the owner+status match played the
// same role, and the risk is identical — the table now says "usr_bob holds mail:read and
// mail:send", so these are the tests proving that is not the whole answer.
describe("scope regression: a key holder still cannot touch another account's mail", () => {
  // メール閲覧 + 編集 + mail:read + mail:send, and deliberately NOT mail:read_all: every
  // caller below sails through the gate on every route it tries. What stops them is the
  // handler.
  const scopedEnv = () =>
    makeEnv({
      SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["app:mail:view", "app:mail:edit", "mail:read", "mail:send"]),
    });
  const asUser = (userId: string, over: Record<string, string> = {}) => headers({ "x-dub-user-id": userId, ...over });

  const seedOwned = (raw: ReturnType<typeof makeEnv>["raw"], id: string, ownerUserId: string, threadId: string) => {
    raw
      .prepare(
        `INSERT INTO mail_inbound
           (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
            auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id)
         VALUES (?, ?, ?, 'info', ?, ?, 'Hi', 'snip', NULL, NULL, ?, ?, 'secret body', NULL, NULL, ?)`,
      )
      .run(
        id,
        `<${id}@x>`,
        threadId,
        JSON.stringify({ email: "sender@x.com" }),
        JSON.stringify([{ email: "info@developershub.jp" }]),
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
        ownerUserId,
      );
  };

  it("mail:read does not open another account's message, thread or read flag", async () => {
    const { env, raw } = scopedEnv();
    seedOwned(raw, "in_alice", "usr_alice", "thr_alice");

    // The gate said yes (usr_bob holds メール閲覧 + mail:read); the owner filter says no.
    // 404 rather than 403 so the response does not even confirm the message exists.
    for (const path of ["/mail/messages/in_alice", "/mail/threads/thr_alice"]) {
      const res = await app.fetch(new Request(`https://svc${path}`, { headers: asUser("usr_bob") }), env);
      expect(res.status).toBe(404);
    }
    const mark = await app.fetch(
      new Request("https://svc/mail/messages/in_alice/read", { method: "POST", headers: asUser("usr_bob") }),
      env,
    );
    expect(mark.status).toBe(404);

    // Not vacuous: the owner reads the same message fine with the same key set.
    const owned = await app.fetch(new Request("https://svc/mail/messages/in_alice", { headers: asUser("usr_alice") }), env);
    expect(owned.status).toBe(200);
    expect((await owned.json() as mail.MailMessageDetail).textBody).toBe("secret body");

    // ...and it never appeared in bob's list either (the list-shaped half of the same rule).
    const list = await app.fetch(new Request("https://svc/mail/messages", { headers: asUser("usr_bob") }), env);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("mail:send does not open another account's scheduled send (read, edit or cancel)", async () => {
    const { env } = scopedEnv();
    // Alice parks a scheduled send.
    const created = await app.fetch(
      new Request("https://svc/mail/scheduled", {
        method: "POST",
        headers: asUser("usr_alice"),
        body: JSON.stringify({ to: [{ email: "x@x.com" }], subject: "Alice-only", textBody: "body", scheduledAt: "2099-01-01T00:00:00.000Z" }),
      }),
      env,
    );
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as mail.ScheduleMailResponse;

    // Bob holds mail:send — the gate lets him in on all three routes. The owner match does not.
    const detail = await app.fetch(new Request(`https://svc/mail/scheduled/${id}`, { headers: asUser("usr_bob") }), env);
    expect(detail.status).toBe(404);
    const patched = await app.fetch(
      new Request(`https://svc/mail/scheduled/${id}`, { method: "PATCH", headers: asUser("usr_bob"), body: JSON.stringify({ subject: "hijacked" }) }),
      env,
    );
    expect(patched.status).toBe(404);
    const canceled = await app.fetch(
      new Request(`https://svc/mail/scheduled/${id}`, { method: "DELETE", headers: asUser("usr_bob") }),
      env,
    );
    expect(canceled.status).toBe(404);

    // Alice's row is untouched and still hers: the subject never became "hijacked", and it
    // is still cancelable (i.e. bob's DELETE did not flip its status either).
    const mine = await app.fetch(new Request(`https://svc/mail/scheduled/${id}`, { headers: asUser("usr_alice") }), env);
    expect(mine.status).toBe(200);
    const row = (await mine.json()) as mail.ScheduledSendDetail;
    expect(row.subject).toBe("Alice-only");
    expect(row.status).toBe("scheduled");
    expect(((await (await app.fetch(new Request("https://svc/mail/scheduled", { headers: asUser("usr_bob") }), env)).json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("personal thread flags stay personal — mail:read never reaches another account's row", async () => {
    const { env } = scopedEnv();
    await app.fetch(
      new Request("https://svc/mail/flags/thr_shared", { method: "POST", headers: asUser("usr_alice"), body: JSON.stringify({ starred: true }) }),
      env,
    );
    // `ownerOf` (not `scopeOf`): flags are per-user even for an oversight holder, so bob
    // sees none of alice's and his own upsert cannot overwrite hers.
    const bob = await app.fetch(new Request("https://svc/mail/flags", { headers: asUser("usr_bob") }), env);
    expect(await bob.json()).toEqual({ items: [] });

    await app.fetch(
      new Request("https://svc/mail/flags/thr_shared", { method: "POST", headers: asUser("usr_bob"), body: JSON.stringify({ trashed: true }) }),
      env,
    );
    const alice = await app.fetch(new Request("https://svc/mail/flags", { headers: asUser("usr_alice") }), env);
    expect(await alice.json()).toEqual({
      items: [{ threadId: "thr_shared", starred: true, archived: false, trashed: false, purged: false }],
    });
  });
});
