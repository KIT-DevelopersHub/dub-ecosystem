// The tests that make the policy layer self-enforcing for chat-service.
//
//  1. ROUTE COVERAGE — the router's endpoint set and POLICY_TABLE's key set must match
//     exactly, in both directions. This is what turns "I added an endpoint and forgot the
//     table line" from a silent hole into a red build; the second case proves it by actually
//     adding an ungated route and showing both the test AND the runtime deny fire.
//  2. ROLE x ENDPOINT MATRIX — the allowed route set of every system role, frozen. Any
//     future table edit that loosens (or tightens) a permission shows up as a changed line
//     in the diff of this file, so a reviewer sees it without reading the table.
//  3. INTERNAL AT RUNTIME — POST /internal/system-messages end to end: a Service-Binding
//     call carrying x-dub-internal passes, the same call without it is refused.
//  4. VISIBILITY REGRESSION — the block that matters most for THIS service. Every read rule
//     in the table is `appLevel("chat", "view")`, a key every member role holds, so the
//     table alone does NOT decide who may read a channel: `loadReadable` / `ensureCanWrite`
//     in ChatService do, and they stayed there on purpose. These cases assert that a caller
//     who holds the key but is not a member of a PRIVATE channel still reaches nothing —
//     i.e. that the migration did not turn "チャット = 閲覧" into "read every private
//     channel in the org". If someone later "simplifies" the handler checks away because
//     "the gate handles authz now", this block is what goes red.
//
// 1, 2 and 4's table half go through @dub/policy-gate's own `allows` / `protectableRouteKeys`,
// i.e. the exact comparison the gate runs in production — never a test-local re-reading of
// the rules.
import { describe, it, expect } from "vitest";
import { allows, assertRouteCoverage, checkRouteCoverage, protectableRouteKeys } from "@dub/policy-gate";
import type { RouteRule } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { makeDeps, call, createApp, fakeAuthz } from "./harness";
import { POLICY_TABLE } from "../src/policy-table";

const TIER_VIEW: identity.PermissionKey[] = ["app:chat:view"];
const TIER_EDIT: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit"];

function buildApp(keys?: identity.PermissionKey[]) {
  return createApp(keys ? makeDeps({ authz: fakeAuthz(new Set(keys)) }) : makeDeps());
}

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(buildApp(), POLICY_TABLE)).toEqual({ ok: true, unlisted: [], orphaned: [] });
    expect(() => assertRouteCoverage(buildApp(), POLICY_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = buildApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/chat/channels/:id/audit", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, POLICY_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /chat/channels/:id/audit"]);
    expect(() => assertRouteCoverage(app, POLICY_TABLE)).toThrow(/GET \/chat\/channels\/:id\/audit/);

    // Fail-closed, not fail-open: unreachable even for a caller holding every chat permission.
    const res = await call(app, "GET", "/chat/channels/chan_1/audit");
    expect(res.status).toBe(403);
    expect(res.json.error.message).toMatch(/no policy rule/);
  });
});

// The chat-relevant keys of each system role, per the identity migrations that define them:
//   0002 (詳細 keys: admin/maintainer get chat:create + chat:moderate, organizer and member
//   get chat:create only) and 0008 (per-app tier: admin/maintainer チャット = 編集,
//   organizer/member チャット = 閲覧).
const ROLE_KEYS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:chat:view", "app:chat:edit", "chat:create", "chat:moderate"],
  maintainer: ["app:chat:view", "app:chat:edit", "chat:create", "chat:moderate"],
  organizer: ["app:chat:view", "chat:create"],
  member: ["app:chat:view", "chat:create"],
  // チャット = 無効 in ロール管理 while still carrying the legacy 詳細 keys. Before the gate
  // the 詳細 key alone let this role create channels and post; the tier now denies it.
  "disabled-tier-with-legacy-chat-keys": ["chat:create", "chat:moderate"],
  // The signed-in caller of a role with no chat access at all.
  nothing: [],
};

/**
 * The route keys an EXTERNAL caller holding `keys` may call, computed by the gate's own rule
 * comparison. `allows` (not `missingKeys`) is the right primitive: it answers the
 * reachability question for every rule form, so the INTERNAL route correctly lands in no
 * role's set — permission keys never open one to a request arriving through api-gateway.
 */
function allowedRoutes(keys: identity.PermissionKey[]): string[] {
  return Object.entries(POLICY_TABLE)
    .filter(([, rule]) => allows(rule as RouteRule, keys))
    .map(([route]) => route)
    .sort();
}

// PUBLIC, so it is in EVERY row below, including `nothing` — the honest answer to "which
// roles can reach this", which a matrix test should show rather than hide.
const PUBLIC_ROUTES = ["GET /health"];
// Reachable by ANY role: INTERNAL is a different axis from permissions entirely.
const INTERNAL_ROUTES = ["POST /internal/system-messages"];

// チャット = 閲覧. Note POST /chat/channels/:id/read is here: it writes only the CALLER's own
// read state, so a 閲覧 role must be able to clear its own unread badge.
const READS = [
  "GET /chat/channels",
  "GET /chat/channels/:id",
  "GET /chat/channels/:id/members",
  "GET /chat/channels/:id/pins",
  "GET /chat/channels/:id/ws-ticket",
  "GET /chat/messages",
  "GET /chat/search",
  "GET /chat/settings/deletion-policy",
  "GET /chat/unfurl",
  "GET /chat/unread",
  "POST /chat/channels/:id/read",
];
// チャット = 編集, no 詳細 key.
const WRITES = [
  "DELETE /chat/channels/:id/members/:userId",
  "DELETE /chat/messages/:id",
  "PATCH /chat/channels/:id",
  "PATCH /chat/messages/:id",
  "POST /chat/channels/:id/members",
  "POST /chat/channels/:id/pins",
  "POST /chat/messages",
  "POST /chat/messages/:id/reactions",
];
// 編集 + a 詳細 key.
const CREATE = ["POST /chat/channels"]; // + chat:create
const MODERATE = ["PATCH /chat/settings/deletion-policy"]; // + chat:moderate

const READ_ONLY = [...PUBLIC_ROUTES, ...READS].sort();
const FULL = [...PUBLIC_ROUTES, ...READS, ...WRITES, ...CREATE, ...MODERATE].sort();

describe("role x endpoint matrix (frozen)", () => {
  // Changing a rule changes one of these arrays — a visible diff in review.
  //
  // READ THIS ROW BEFORE EDITING THE TABLE: `member` / `organizer` hold チャット = 閲覧, so
  // under POLICY_TABLE they can READ chat but cannot post, react, pin or create a channel —
  // and holding the legacy `chat:create` 詳細 key does not change that, because the rule is
  // `appLevel("chat", "edit", "chat:create")` (conjunctive). That is strictly tighter than
  // the pre-gate code, where posting needed only `requireAuth` and creating needed only
  // `chat:create`. It follows docs/policy-coverage-inventory.md 2.11 as written; if ordinary
  // members are meant to post, the fix is ロール管理 (give the role チャット = 編集, which is
  // what the tier is for), NOT a looser rule here.
  const EXPECTED: Record<keyof typeof ROLE_KEYS, string[]> = {
    admin: FULL,
    maintainer: FULL,
    organizer: READ_ONLY,
    member: READ_ONLY,
    "disabled-tier-with-legacy-chat-keys": PUBLIC_ROUTES,
    nothing: PUBLIC_ROUTES,
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

  it("no role, however privileged, reaches the INTERNAL route from outside", () => {
    const everyKey = [...new Set(Object.values(ROLE_KEYS).flat())];
    for (const route of INTERNAL_ROUTES) expect(allowedRoutes(everyKey)).not.toContain(route);
  });

  it("a 閲覧 caller is refused every write at runtime, naming the missing tier key", async () => {
    const app = buildApp(TIER_VIEW);
    const posted = await call(app, "POST", "/chat/messages", { body: { channelId: "chan_any", body: "hi" } });
    expect(posted.status).toBe(403);
    expect(posted.json.error.details.missing).toEqual(["app:chat:edit"]);
  });
});

// The INTERNAL rule at runtime, end to end through the real app.
describe("POST /internal/system-messages (INTERNAL)", () => {
  const topic = { type: "topic", visibility: "public", name: "General" } as const;

  it("accepts a service-to-service call carrying x-dub-internal", async () => {
    const app = buildApp();
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "POST", "/internal/system-messages", {
      internal: true,
      body: { channelId: c.json.id, body: "maintenance at 5pm" },
    });
    expect(res.status).toBe(201);
    expect(res.json.kind).toBe("system");
  });

  it("403s without the marker, even for a caller holding every chat permission", async () => {
    const app = buildApp();
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "POST", "/internal/system-messages", { body: { channelId: c.json.id, body: "sys" } });
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe("internal_only");
  });
});

// ── THE regression block for this service (see the file header) ──
//
// The caller below holds the key the table demands on every one of these routes. Everything
// that stops them is the handler layer the migration deliberately did not touch. Each case
// is 404 rather than 403 because `loadReadable` hides a private channel's very existence.
describe("channel visibility is NOT delegated to the table (handler-layer regression)", () => {
  /**
   * `owner` (full chat keys) seeds a channel + message; `caller` serves the SAME repo but
   * grants only `callerKeys`, so the restricted caller's requests pass the table's rule and
   * then meet the handler layer — which is what these cases are about. Seeding has to go
   * through a full-keyed app because creating a channel needs 編集 + chat:create.
   */
  async function seed(callerKeys: identity.PermissionKey[], visibility: "private" | "public" = "private") {
    const deps = makeDeps();
    const owner = createApp(deps);
    const c = await call(owner, "POST", "/chat/channels", {
      userId: "user_owner",
      body: { type: "topic", visibility, name: "Secret" },
    });
    expect(c.status).toBe(201);
    const m = await call(owner, "POST", "/chat/messages", {
      userId: "user_owner",
      body: { channelId: c.json.id, body: "classified" },
    });
    expect(m.status).toBe(201);
    const caller = createApp(makeDeps({ repo: deps.repo, authz: fakeAuthz(new Set(callerKeys)) }));
    return { owner, caller, channelId: c.json.id as string, messageId: m.json.id as string };
  }

  it("an `app:chat:view` holder who is not a member reaches NOTHING of a private channel", async () => {
    const { caller, channelId, messageId } = await seed(TIER_VIEW);

    for (const path of [
      `/chat/channels/${channelId}`,
      `/chat/channels/${channelId}/members`,
      `/chat/channels/${channelId}/pins`,
      `/chat/channels/${channelId}/ws-ticket`,
    ]) {
      const res = await call(caller, "GET", path, { userId: "user_stranger" });
      expect(res.status, `GET ${path}`).toBe(404);
    }

    const messages = await call(caller, "GET", "/chat/messages", {
      userId: "user_stranger",
      query: { channelId },
    });
    expect(messages.status).toBe(404);

    const read = await call(caller, "POST", `/chat/channels/${channelId}/read`, {
      userId: "user_stranger",
      body: { lastReadMessageId: messageId },
    });
    expect(read.status).toBe(404);

    // Absent from the stranger's channel list too (listChannels is membership-scoped in the
    // repo — again not something the table could express).
    const mine = await call(caller, "GET", "/chat/channels", { userId: "user_stranger" });
    expect(mine.status).toBe(200);
    expect(mine.json.items).toEqual([]);

    // Search is userId-scoped in the repo: the private body must not surface.
    const found = await call(caller, "GET", "/chat/search", { userId: "user_stranger", query: { q: "classified" } });
    expect(found.status).toBe(200);
    expect(found.json).toEqual([]);
  });

  it("an `app:chat:edit` holder who is not a member cannot post, react or pin in a private channel", async () => {
    const { owner, caller, channelId, messageId } = await seed(TIER_EDIT);

    const posted = await call(caller, "POST", "/chat/messages", {
      userId: "user_stranger",
      body: { channelId, body: "intrusion" },
    });
    expect(posted.status).toBe(404);

    const pinned = await call(caller, "POST", `/chat/channels/${channelId}/pins`, {
      userId: "user_stranger",
      body: { messageId },
    });
    expect(pinned.status).toBe(404);

    const reacted = await call(caller, "POST", `/chat/messages/${messageId}/reactions`, {
      userId: "user_stranger",
      body: { emoji: "+1" },
    });
    expect(reacted.status).toBe(404);

    // Nothing was written: the owner still sees exactly their own message.
    const own = await call(owner, "GET", "/chat/messages", { userId: "user_owner", query: { channelId } });
    expect(own.status).toBe(200);
    expect(own.json.items.map((x: { body: string }) => x.body)).toEqual(["classified"]);
  });

  it("`app:chat:edit` is not channel-admin authority: a plain member cannot rename the channel or add members", async () => {
    const { owner, caller, channelId } = await seed(TIER_EDIT);
    // user_plain IS a member (role "member"), so loadReadable passes — only isChannelAdmin
    // stands between them and the channel's settings / roster.
    const added = await call(owner, "POST", `/chat/channels/${channelId}/members`, {
      userId: "user_owner",
      body: { userId: "user_plain" },
    });
    expect(added.status).toBe(204);

    const renamed = await call(caller, "PATCH", `/chat/channels/${channelId}`, {
      userId: "user_plain",
      body: { version: 1, name: "Hijacked" },
    });
    expect(renamed.status).toBe(403);

    const invited = await call(caller, "POST", `/chat/channels/${channelId}/members`, {
      userId: "user_plain",
      body: { userId: "user_outsider" },
    });
    expect(invited.status).toBe(403);
  });

  it("an `app:chat:edit` holder cannot edit or delete someone else's message", async () => {
    // A PUBLIC channel, so loadReadable/ensureCanWrite let the stranger in (Slack-style
    // auto-join) and the only thing left is the author / moderator check in the handler.
    const { caller, messageId } = await seed(TIER_EDIT, "public");

    const edited = await call(caller, "PATCH", `/chat/messages/${messageId}`, {
      userId: "user_stranger",
      body: { version: 1, body: "tampered" },
    });
    expect(edited.status).toBe(403);

    // The caller holds no chat:moderate, so they are not a moderator either.
    const deleted = await call(caller, "DELETE", `/chat/messages/${messageId}`, { userId: "user_stranger" });
    expect(deleted.status).toBe(403);
  });
});
