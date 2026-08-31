import { describe, it, expect } from "vitest";
import type { DbClient } from "@dub/db";
import { createApp } from "../src/app";
import { parseNotifyRequest } from "../src/validation";
import { ingest, type IngestDeps } from "../src/ingest";
import { consumeEventQueue } from "../src/queue";
import { mappingToIngest } from "../src/queue";
import { EVENT_MAPPINGS } from "../src/mapping";
import { resolveEnabled, defaultEnabled } from "../src/preferences";
import { makeRecipientResolver } from "../src/recipients";
import { resolveAuditQueue } from "../src/outbox";
import {
  makeInAppAdapter,
  makeEmailAdapter,
  makeChatAdapter,
  makePushAdapter,
  type AdapterRegistry,
} from "../src/adapters";
import { unreadCount, upsertPreference, listPreferenceOverrides } from "../src/repo";
import type { ChannelAdapter, DeliveryJob, IngestInput, NotifyRecipients } from "../src/types";
import {
  makeTestEnv,
  ctx,
  fakeIdentity,
  fakeEvent,
  fakeMail,
  fakeChat,
  fakePush,
  fakeBatch,
  envelope,
  type TestEnvHandle,
  type RecordingMail,
  type RecordingChat,
  type RecordingPush,
} from "./helpers";

// ---- core deps builder (bypasses Fetcher; injects fake ports) ----
function coreDeps(
  h: TestEnvHandle,
  opts: {
    identity?: ReturnType<typeof fakeIdentity>;
    event?: ReturnType<typeof fakeEvent>;
    mail?: RecordingMail;
    chat?: RecordingChat;
    push?: RecordingPush;
    adapters?: AdapterRegistry;
    maxAttempts?: number;
  } = {},
): IngestDeps {
  const c = ctx();
  const identity = opts.identity ?? fakeIdentity({});
  const event = opts.event ?? fakeEvent({});
  const resolver = makeRecipientResolver({ identity, event });
  const adapters: AdapterRegistry =
    opts.adapters ?? {
      in_app: makeInAppAdapter(h.db),
      email: makeEmailAdapter({ ...(opts.mail ? { mail: opts.mail } : {}), identity, ctx: c }),
      chat: makeChatAdapter({ ...(opts.chat ? { chat: opts.chat } : {}), ctx: c }),
      push: makePushAdapter({ ...(opts.push ? { push: opts.push } : {}), ctx: c }),
    };
  return {
    db: h.db,
    resolver,
    adapters,
    auditEnv: resolveAuditQueue(h.env),
    orgId: "org_devhub",
    ctx: c,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  };
}

function baseInput(over: Partial<IngestInput> & Pick<IngestInput, "type" | "recipients">): IngestInput {
  return {
    title: "Title",
    body: "Body",
    priority: "normal",
    source: "api",
    actorId: null,
    requestId: "req_test",
    ...over,
  } as IngestInput;
}

async function deliveries(db: DbClient, notificationId: string) {
  return db.all<{ channel: string; status: string; attempts: number }>(
    `SELECT channel, status, attempts FROM notif_deliveries WHERE notification_id = ? ORDER BY channel`,
    notificationId,
  );
}

// ---------------------------------------------------------------------------

describe("ingest — recipients & dedup", () => {
  it("#1/#5 direct recipients deliver in_app -> inbox + unread-count", async () => {
    const h = makeTestEnv();
    const res = await ingest(coreDeps(h), baseInput({ type: "system.announcement", recipients: { userIds: ["u1"] }, channels: ["in_app"] }));
    expect(res.deduplicated).toBe(false);
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "in_app", status: "sent", attempts: 1 }]);
    expect(await unreadCount(h.db, "u1")).toBe(1);
  });

  it("#2 roles + eventId expansion is unioned & de-duplicated", async () => {
    const h = makeTestEnv();
    const identity = fakeIdentity({ byRole: { admin: ["u1", "u2"] } });
    const event = fakeEvent({ ev1: ["u2", "u3"] });
    const recipients: NotifyRecipients = { roles: ["admin"], eventId: "ev1" };
    const res = await ingest(coreDeps(h, { identity, event }), baseInput({ type: "system.announcement", recipients, channels: ["in_app"] }));
    const rows = await h.db.all<{ user_id: string }>(
      `SELECT user_id FROM notif_deliveries WHERE notification_id = ? AND channel = 'in_app' ORDER BY user_id`,
      res.notificationId,
    );
    expect(rows.map((r) => r.user_id)).toEqual(["u1", "u2", "u3"]);
  });

  it("#3 empty recipients -> notification persisted, zero deliveries, no error", async () => {
    const h = makeTestEnv();
    const res = await ingest(coreDeps(h), baseInput({ type: "system.announcement", recipients: { userIds: [] } }));
    expect((await deliveries(h.db, res.notificationId)).length).toBe(0);
    const n = await h.db.first<{ id: string }>(`SELECT id FROM notif_notifications WHERE id = ?`, res.notificationId);
    expect(n).not.toBeNull();
  });

  it("#4 dedupKey re-ingest returns deduplicated:true with no double delivery", async () => {
    const h = makeTestEnv();
    const input = baseInput({ type: "system.announcement", recipients: { userIds: ["u1"] }, channels: ["in_app"], dedupKey: "k:1" });
    const first = await ingest(coreDeps(h), input);
    const second = await ingest(coreDeps(h), input);
    expect(second.deduplicated).toBe(true);
    expect(second.notificationId).toBe(first.notificationId);
    const count = await h.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM notif_notifications`);
    expect(count?.c).toBe(1);
    expect(await unreadCount(h.db, "u1")).toBe(1);
  });

  it("#16 correlation id (requestId) is persisted on the notification row", async () => {
    const h = makeTestEnv();
    const deps = coreDeps(h);
    const res = await ingest(deps, baseInput({ type: "system.announcement", recipients: { userIds: ["u1"] }, channels: ["in_app"], requestId: "req_corr_9" }));
    const row = await h.db.first<{ request_id: string }>(`SELECT request_id FROM notif_notifications WHERE id = ?`, res.notificationId);
    expect(row?.request_id).toBe("req_corr_9");
  });
});

describe("preferences", () => {
  it("#7 longest-match resolution: exact > prefix > * with override priority", () => {
    const now = new Date().toISOString();
    const overrides = [
      { user_id: "u1", type: "*", channel: "in_app" as const, enabled: 0, updated_at: now },
      { user_id: "u1", type: "task.", channel: "in_app" as const, enabled: 1, updated_at: now },
      { user_id: "u1", type: "task.assigned", channel: "in_app" as const, enabled: 0, updated_at: now },
    ];
    expect(resolveEnabled(overrides, "task.assigned", "in_app", "normal")).toBe(false); // exact wins
    expect(resolveEnabled(overrides, "task.created", "in_app", "normal")).toBe(true); // prefix wins
    expect(resolveEnabled(overrides, "event.created", "in_app", "normal")).toBe(false); // "*" wins
  });

  it("defaults: in_app on (chat.* off), email urgent-only, chat off, push on", () => {
    expect(defaultEnabled("task.created", "in_app", "normal")).toBe(true);
    expect(defaultEnabled("chat.message.created", "in_app", "normal")).toBe(false);
    expect(defaultEnabled("x.y", "email", "normal")).toBe(false);
    expect(defaultEnabled("x.y", "email", "urgent")).toBe(true);
    expect(defaultEnabled("x.y", "chat", "urgent")).toBe(false);
    expect(defaultEnabled("x.y", "push", "normal")).toBe(true);
  });

  it("#6 email override off -> email skipped, in_app still delivered", async () => {
    const h = makeTestEnv();
    await upsertPreference(h.db, "u1", "*", "email", false);
    const res = await ingest(
      coreDeps(h, { mail: fakeMail() }),
      baseInput({ type: "task.due_soon", recipients: { userIds: ["u1"] }, priority: "urgent", channels: ["in_app", "email"] }),
    );
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([
      { channel: "email", status: "skipped", attempts: 0 },
      { channel: "in_app", status: "sent", attempts: 1 },
    ]);
  });
});

describe("email adapter (stub swap)", () => {
  it("#14 calls mail port with idempotencyKey {nid}:{uid}:email and resolved address", async () => {
    const h = makeTestEnv();
    const identity = fakeIdentity({ emails: { u1: "u1@example.test" } });
    const mail = fakeMail();
    const res = await ingest(
      coreDeps(h, { identity, mail }),
      baseInput({ type: "task.due_soon", recipients: { userIds: ["u1"] }, priority: "urgent", channels: ["email"], title: "Due", body: "soon" }),
    );
    expect(mail.calls).toHaveLength(1);
    expect(mail.calls[0]!.idempotencyKey).toBe(`${res.notificationId}:u1:email`);
    expect(mail.calls[0]!.req).toMatchObject({ to: [{ email: "u1@example.test" }], subject: "Due", textBody: "soon" });
  });

  it("email channel with no wired mail port is skipped (P0 default)", async () => {
    const h = makeTestEnv();
    const res = await ingest(coreDeps(h), baseInput({ type: "x.y", recipients: { userIds: ["u1"] }, priority: "urgent", channels: ["email"] }));
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "email", status: "skipped", attempts: 0 }]);
  });
});

describe("chat adapter (stub swap)", () => {
  it("#14 wired chat port receives postSystemMessage {userId,title,body}; delivery sent", async () => {
    const h = makeTestEnv();
    await upsertPreference(h.db, "u1", "*", "chat", true); // chat default is off
    const chat = fakeChat();
    const res = await ingest(
      coreDeps(h, { chat }),
      baseInput({ type: "x.y", recipients: { userIds: ["u1"] }, channels: ["chat"], title: "Hey", body: "look" }),
    );
    expect(chat.calls).toEqual([{ userId: "u1", title: "Hey", body: "look" }]);
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "chat", status: "sent", attempts: 1 }]);
  });

  it("chat channel with no wired chat port is skipped (P0 default)", async () => {
    const h = makeTestEnv();
    await upsertPreference(h.db, "u1", "*", "chat", true);
    const res = await ingest(coreDeps(h), baseInput({ type: "x.y", recipients: { userIds: ["u1"] }, channels: ["chat"] }));
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "chat", status: "skipped", attempts: 0 }]);
  });
});

describe("push adapter (stub swap)", () => {
  it("#14 wired push port receives dispatch {userId,type,title,body}; delivery sent", async () => {
    const h = makeTestEnv();
    const push = fakePush(); // push default is on
    const res = await ingest(
      coreDeps(h, { push }),
      baseInput({ type: "task.assigned", recipients: { userIds: ["u1"] }, channels: ["push"], title: "Assigned", body: "to you" }),
    );
    expect(push.calls).toEqual([{ userId: "u1", type: "task.assigned", title: "Assigned", body: "to you" }]);
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "push", status: "sent", attempts: 1 }]);
  });

  it("push channel with no wired push port is skipped (P0 default)", async () => {
    const h = makeTestEnv();
    const res = await ingest(coreDeps(h), baseInput({ type: "x.y", recipients: { userIds: ["u1"] }, channels: ["push"] }));
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "push", status: "skipped", attempts: 0 }]);
  });
});

describe("delivery runner failure", () => {
  it("#13 adapter throws -> retried to the cap, failed, one delivery-failed audit", async () => {
    const h = makeTestEnv();
    const failing: ChannelAdapter = {
      channel: "in_app",
      async deliver(_job: DeliveryJob) {
        throw new Error("boom");
      },
    };
    const adapters: AdapterRegistry = {
      in_app: failing,
      email: makeEmailAdapter({ identity: fakeIdentity({}), ctx: ctx() }),
      chat: makeChatAdapter({ ctx: ctx() }),
      push: makePushAdapter({ ctx: ctx() }),
    };
    const res = await ingest(
      coreDeps(h, { adapters, maxAttempts: 3 }),
      baseInput({ type: "system.announcement", recipients: { userIds: ["u1"] }, channels: ["in_app"] }),
    );
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "in_app", status: "failed", attempts: 3 }]);
    expect(h.audit.sends).toHaveLength(1);
    expect(h.audit.sends[0]!.payload.action).toBe("notif.delivery.failed");
    expect(h.audit.sends[0]!.payload.result).toBe("failure");
  });

  it("#13 real-wired chat port that throws is retried to the cap, failed + one audit", async () => {
    // Proves the failure lane through a REAL adapter (not a hand-rolled one): a throwing
    // downstream port propagates through makeChatAdapter into runDelivery's retry/audit.
    const h = makeTestEnv();
    await upsertPreference(h.db, "u1", "*", "chat", true); // chat default is off
    const chat = fakeChat("throw");
    const res = await ingest(
      coreDeps(h, { chat, maxAttempts: 3 }),
      baseInput({ type: "x.y", recipients: { userIds: ["u1"] }, channels: ["chat"], title: "Hey", body: "look" }),
    );
    expect(chat.calls).toHaveLength(3); // one call per attempt up to the cap
    const rows = await deliveries(h.db, res.notificationId);
    expect(rows).toEqual([{ channel: "chat", status: "failed", attempts: 3 }]);
    expect(h.audit.sends).toHaveLength(1);
    expect(h.audit.sends[0]!.payload.action).toBe("notif.delivery.failed");
    expect(h.audit.sends[0]!.payload.result).toBe("failure");
  });
});

describe("lane-A mapping", () => {
  it("#10 task.assigned maps to correct type/recipient/content", () => {
    const rule = EVENT_MAPPINGS["task.assigned"]!;
    const env = envelope("task.assigned", { taskId: "task_1", eventId: "ev_1", assigneeId: "u9" });
    const input = mappingToIngest(rule, env);
    expect(input.type).toBe("task.assigned");
    expect(input.recipients).toEqual({ userIds: ["u9"] });
    expect(input.resourceId).toBe("task_1");
    expect(input.channels).toEqual(["in_app", "email"]);
  });

  it("task.archived uses the renamed event name (no task.deleted)", () => {
    expect(EVENT_MAPPINGS["task.archived"]).toBeDefined();
    expect((EVENT_MAPPINGS as Record<string, unknown>)["task.deleted"]).toBeUndefined();
  });

  it("public.inquiry.received propagates name/email/message into content body", () => {
    const rule = EVENT_MAPPINGS["public.inquiry.received"]!;
    const env = envelope("public.inquiry.received", { kind: "sponsor", name: "Bob", email: "bob@example.com", message: "We would like to sponsor." });
    const input = mappingToIngest(rule, env);
    expect(input.type).toBe("public.inquiry.received");
    expect(input.title).toBe("New inquiry: sponsor");
    expect(input.body).toContain("Bob");
    expect(input.body).toContain("bob@example.com");
    expect(input.body).toContain("We would like to sponsor.");
    expect(input.resourceType).toBe("inquiry");
  });
});

describe("queue consumer (lanes A/B + idempotency)", () => {
  it("#11 notification.requested is equivalent to lane C direct ingest", async () => {
    const h = makeTestEnv();
    const env = envelope("notification.requested", { type: "system.announcement", recipientIds: ["u1", "u2"], title: "Hi", body: "yo" }, { requestId: "req_evt_x" });
    const { batch, messages } = fakeBatch([env]);
    await consumeEventQueue(batch, h.env);
    expect(messages[0]!.acked).toBe(true);
    expect(await unreadCount(h.db, "u1")).toBe(1);
    expect(await unreadCount(h.db, "u2")).toBe(1);
  });

  it("#12 same envelope.id redelivery is deduplicated (no double inbox)", async () => {
    const h = makeTestEnv();
    const env = envelope("notification.requested", { type: "system.announcement", recipientIds: ["u1"], title: "Hi", body: "yo" }, { id: "evt_fixed_1" });
    await consumeEventQueue(fakeBatch([env]).batch, h.env);
    await consumeEventQueue(fakeBatch([env]).batch, h.env);
    expect(await unreadCount(h.db, "u1")).toBe(1);
  });

  it("#16 queue path propagates envelope.requestId to the notification row", async () => {
    const h = makeTestEnv();
    const env = envelope("notification.requested", { type: "system.announcement", recipientIds: ["u1"], title: "Hi", body: "yo" }, { requestId: "req_from_env" });
    await consumeEventQueue(fakeBatch([env]).batch, h.env);
    const row = await h.db.first<{ request_id: string }>(`SELECT request_id FROM notif_notifications LIMIT 1`);
    expect(row?.request_id).toBe("req_from_env");
  });
});

// ---------------------------------------------------------------------------

describe("parseNotifyRequest — recipientRoles", () => {
  const base = { type: "usage.threshold_breached", title: "t", body: "b" };

  it("accepts recipientRoles and keeps recipientIds (union)", () => {
    const out = parseNotifyRequest({ ...base, recipientIds: ["u1"], recipientRoles: ["role_sys_admin"] });
    expect(out.recipientIds).toEqual(["u1"]);
    expect(out.recipientRoles).toEqual(["role_sys_admin"]);
  });

  it("allows empty recipientIds when recipientRoles is non-empty", () => {
    const out = parseNotifyRequest({ ...base, recipientIds: [], recipientRoles: ["role_sys_admin"] });
    expect(out.recipientIds).toEqual([]);
    expect(out.recipientRoles).toEqual(["role_sys_admin"]);
  });

  it("omits recipientRoles from output when absent", () => {
    const out = parseNotifyRequest({ ...base, recipientIds: ["u1"] });
    expect(out.recipientRoles).toBeUndefined();
  });

  it("rejects when both recipientIds and recipientRoles are empty", () => {
    expect(() => parseNotifyRequest({ ...base, recipientIds: [], recipientRoles: [] })).toThrow();
    expect(() => parseNotifyRequest({ ...base, recipientIds: [] })).toThrow();
  });

  it("rejects a non-string-array recipientRoles", () => {
    expect(() => parseNotifyRequest({ ...base, recipientIds: ["u1"], recipientRoles: [1, 2] })).toThrow();
  });
});

describe("HTTP app", () => {
  const app = createApp();

  function req(path: string, init: RequestInit, env: TestEnvHandle) {
    return app.request(path, init, env.env as unknown as Record<string, unknown>);
  }
  const internalPost = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json", "x-dub-internal": "1" },
    body: JSON.stringify(body),
  });

  it("#1 POST /notify -> 202 then GET /inbox + unread-count reflect it", async () => {
    const h = makeTestEnv();
    const res = await req("/notify", internalPost({ type: "system.announcement", recipientIds: ["u1"], title: "Hi", body: "there", channels: ["in_app"] }), h);
    expect(res.status).toBe(202);
    const posted = (await res.json()) as { notificationId: string; deduplicated: boolean };
    expect(posted.deduplicated).toBe(false);

    const inbox = await req("/inbox", { headers: { "x-dub-user-id": "u1" } }, h);
    expect(inbox.status).toBe(200);
    const page = (await inbox.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page.items).toHaveLength(1);

    const uc = await req("/inbox/unread-count", { headers: { "x-dub-user-id": "u1" } }, h);
    expect((await uc.json()) as { count: number }).toEqual({ count: 1 });
  });

  it("GET /inbox resolves a row's actorId to the actor's display name (actorName enrichment)", async () => {
    // Dedicated app with an identity port that resolves display names; the notify's
    // x-dub-user-id becomes the stored actorId, and the inbox read enriches it.
    const identity = fakeIdentity({ displayNames: { usr_alice: "山田 花子" } });
    const enrichApp = createApp({ identity });
    const h = makeTestEnv();
    const notifyRes = await enrichApp.request(
      "/notify",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-dub-internal": "1", "x-dub-user-id": "usr_alice" },
        body: JSON.stringify({ type: "feedback", recipientIds: ["u1"], title: "新しいフィードバック", body: "検索が遅い", channels: ["in_app"] }),
      },
      h.env as unknown as Record<string, unknown>,
    );
    expect(notifyRes.status).toBe(202);

    const inbox = await enrichApp.request("/inbox", { headers: { "x-dub-user-id": "u1" } }, h.env as unknown as Record<string, unknown>);
    const page = (await inbox.json()) as { items: { actorId: string | null; actorName: string | null }[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.actorId).toBe("usr_alice");
    expect(page.items[0]!.actorName).toBe("山田 花子");
    expect(identity.nameCalls).toContain("usr_alice");
  });

  it("GET /inbox keeps actorName null when identity cannot resolve the actor (UI falls back to id)", async () => {
    const identity = fakeIdentity({ displayNames: {} }); // no name for the actor
    const enrichApp = createApp({ identity });
    const h = makeTestEnv();
    await enrichApp.request(
      "/notify",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-dub-internal": "1", "x-dub-user-id": "usr_ghost" },
        body: JSON.stringify({ type: "feedback", recipientIds: ["u1"], title: "fb", body: "x", channels: ["in_app"] }),
      },
      h.env as unknown as Record<string, unknown>,
    );
    const inbox = await enrichApp.request("/inbox", { headers: { "x-dub-user-id": "u1" } }, h.env as unknown as Record<string, unknown>);
    const page = (await inbox.json()) as { items: { actorId: string | null; actorName: string | null }[] };
    expect(page.items[0]!.actorId).toBe("usr_ghost");
    expect(page.items[0]!.actorName).toBeNull();
  });

  // A fake SVC_IDENTITY that answers GET /internal/users?roleKey= with fixed members,
  // so the /notify role fan-out expands to real inbox rows end-to-end.
  function roleIdentity(byRole: Record<string, string[]>) {
    return {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/internal/users")) {
          const roleKey = url.searchParams.get("roleKey") ?? "";
          const items = (byRole[roleKey] ?? []).map((id) => ({ id }));
          return new Response(JSON.stringify({ items, nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    } as unknown as import("@cloudflare/workers-types").Fetcher;
  }

  it("POST /notify with recipientRoles fans out to role members' inboxes (union with ids)", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: roleIdentity({ role_sys_admin: ["u_admin"], role_sys_maintainer: ["u_maint"] }) });
    const res = await req(
      "/notify",
      internalPost({ type: "usage.threshold_breached", recipientIds: ["u_direct"], recipientRoles: ["role_sys_admin", "role_sys_maintainer"], title: "枠超過", body: "warn", channels: ["in_app"] }),
      h,
    );
    expect(res.status).toBe(202);
    expect(await unreadCount(h.db, "u_admin")).toBe(1);
    expect(await unreadCount(h.db, "u_maint")).toBe(1);
    expect(await unreadCount(h.db, "u_direct")).toBe(1); // ids union with roles
  });

  it("POST /notify with only recipientRoles (empty ids) still delivers", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: roleIdentity({ role_sys_admin: ["u_admin"] }) });
    const res = await req(
      "/notify",
      internalPost({ type: "usage.threshold_breached", recipientIds: [], recipientRoles: ["role_sys_admin"], title: "枠超過", body: "warn", channels: ["in_app"] }),
      h,
    );
    expect(res.status).toBe(202);
    expect(await unreadCount(h.db, "u_admin")).toBe(1);
  });

  it("POST /notify with empty ids AND no roles -> 400 NOTIF_VALIDATION_FAILED", async () => {
    const h = makeTestEnv();
    const res = await req("/notify", internalPost({ type: "x.y", recipientIds: [], title: "t", body: "b" }), h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOTIF_VALIDATION_FAILED");
  });

  it("GAP-2: routes are also served under the '/notifications' gateway segment", async () => {
    // The api-gateway forwards its "/notifications/*" segment verbatim (transparent proxy,
    // no strip), so the real service must answer that prefix — not only bare "/inbox".
    // Regression guard for the prod 通知ダイアログ "Couldn't load" (external
    // /api/v1/notifications/inbox 404'd because the service only mounted at /inbox).
    const h = makeTestEnv();
    const res = await req("/notifications/notify", internalPost({ type: "system.announcement", recipientIds: ["u1"], title: "Hi", body: "there", channels: ["in_app"] }), h);
    expect(res.status).toBe(202);

    const inbox = await req("/notifications/inbox", { headers: { "x-dub-user-id": "u1" } }, h);
    expect(inbox.status).toBe(200);
    const page = (await inbox.json()) as { items: { id: string }[] };
    expect(page.items).toHaveLength(1);

    const uc = await req("/notifications/inbox/unread-count", { headers: { "x-dub-user-id": "u1" } }, h);
    expect((await uc.json()) as { count: number }).toEqual({ count: 1 });

    const prefs = await req("/notifications/preferences", { headers: { "x-dub-user-id": "u1" } }, h);
    expect(prefs.status).toBe(200);
  });

  it("#15 POST /notify without x-dub-internal -> 403 FORBIDDEN", async () => {
    const h = makeTestEnv();
    const res = await req("/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "x.y", recipientIds: ["u1"], title: "Hi", body: "b" }),
    }, h);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("validation: bad payload -> 400 NOTIF_VALIDATION_FAILED", async () => {
    const h = makeTestEnv();
    const res = await req("/notify", internalPost({ type: "", recipientIds: "nope", title: "", body: 1 }), h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOTIF_VALIDATION_FAILED");
  });

  it("#8 read / read-all / re-read are idempotent", async () => {
    const h = makeTestEnv();
    await req("/notify", internalPost({ type: "system.announcement", recipientIds: ["u1"], title: "a", body: "b", channels: ["in_app"] }), h);
    await req("/notify", internalPost({ type: "system.announcement", recipientIds: ["u1"], title: "c", body: "d", channels: ["in_app"] }), h);
    const page = (await (await req("/inbox", { headers: { "x-dub-user-id": "u1" } }, h)).json()) as { items: { id: string }[] };
    const firstId = page.items[0]!.id;

    const r1 = await req(`/inbox/${firstId}/read`, { method: "PATCH", headers: { "x-dub-user-id": "u1" } }, h);
    expect(r1.status).toBe(200);
    expect(await unreadCount(h.db, "u1")).toBe(1);
    // re-read same item: still 200, count unchanged
    await req(`/inbox/${firstId}/read`, { method: "PATCH", headers: { "x-dub-user-id": "u1" } }, h);
    expect(await unreadCount(h.db, "u1")).toBe(1);

    const ra = await req("/inbox/read-all", { method: "POST", headers: { "content-type": "application/json", "x-dub-user-id": "u1" }, body: "{}" }, h);
    expect(((await ra.json()) as { updated: number }).updated).toBe(1);
    expect(await unreadCount(h.db, "u1")).toBe(0);
  });

  it("PATCH /inbox/:id/unread restores a read row to unread (idempotent; unread-count reflects it)", async () => {
    const h = makeTestEnv();
    await req("/notify", internalPost({ type: "system.announcement", recipientIds: ["u1"], title: "a", body: "b", channels: ["in_app"] }), h);
    const page = (await (await req("/inbox", { headers: { "x-dub-user-id": "u1" } }, h)).json()) as { items: { id: string }[] };
    const id = page.items[0]!.id;

    await req(`/inbox/${id}/read`, { method: "PATCH", headers: { "x-dub-user-id": "u1" } }, h);
    expect(await unreadCount(h.db, "u1")).toBe(0);

    const un = await req(`/inbox/${id}/unread`, { method: "PATCH", headers: { "x-dub-user-id": "u1" } }, h);
    expect(un.status).toBe(200);
    expect(await unreadCount(h.db, "u1")).toBe(1);
    // idempotent: re-marking unread keeps it unread
    await req(`/inbox/${id}/unread`, { method: "PATCH", headers: { "x-dub-user-id": "u1" } }, h);
    expect(await unreadCount(h.db, "u1")).toBe(1);

    // another user cannot flip someone else's row -> 404
    const forbidden = await req(`/inbox/${id}/unread`, { method: "PATCH", headers: { "x-dub-user-id": "u2" } }, h);
    expect(forbidden.status).toBe(404);
  });

  it("#9 reading another user's inbox item -> 404 NOTIF_INBOX_ITEM_NOT_FOUND", async () => {
    const h = makeTestEnv();
    await req("/notify", internalPost({ type: "system.announcement", recipientIds: ["u1"], title: "a", body: "b", channels: ["in_app"] }), h);
    const page = (await (await req("/inbox", { headers: { "x-dub-user-id": "u1" } }, h)).json()) as { items: { id: string }[] };
    const id = page.items[0]!.id;
    const res = await req(`/inbox/${id}/read`, { method: "PATCH", headers: { "x-dub-user-id": "u2" } }, h);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOTIF_INBOX_ITEM_NOT_FOUND");
  });

  it("preferences: PATCH stores overrides & GET returns merged view", async () => {
    const h = makeTestEnv();
    const patch = await req("/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-dub-user-id": "u1" },
      body: JSON.stringify({ entries: [{ type: "task.assigned", channels: ["in_app"] }] }),
    }, h);
    expect(patch.status).toBe(200);
    // in_app default is on, so { task.assigned: [in_app] } equals default for in_app;
    // push default on but omitted -> override push=off is stored.
    const overrides = await listPreferenceOverrides(h.db, "u1");
    const pushOff = overrides.find((o) => o.type === "task.assigned" && o.channel === "push");
    expect(pushOff?.enabled).toBe(0);

    const get = await req("/preferences", { headers: { "x-dub-user-id": "u1" } }, h);
    const body = (await get.json()) as { userId: string; entries: { type: string; channels: string[] }[] };
    expect(body.userId).toBe("u1");
    const entry = body.entries.find((e) => e.type === "task.assigned");
    expect(entry?.channels).toContain("in_app");
    expect(entry?.channels).not.toContain("push");
  });

  it("preferences: invalid type pattern -> 400 NOTIF_UNKNOWN_TYPE_PATTERN", async () => {
    const h = makeTestEnv();
    const res = await req("/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-dub-user-id": "u1" },
      body: JSON.stringify({ entries: [{ type: "TASK..bad*", channels: ["in_app"] }] }),
    }, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOTIF_UNKNOWN_TYPE_PATTERN");
  });

  it("unauthenticated inbox access -> 401", async () => {
    const h = makeTestEnv();
    const res = await req("/inbox", { headers: {} }, h);
    expect(res.status).toBe(401);
  });
});
