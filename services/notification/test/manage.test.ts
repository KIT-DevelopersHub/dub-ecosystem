// Notification management: audience separation (members never see audience='admin'),
// publish-to-members broadcast (single broadcast, per-user read state, idempotent), the
// admin list + published-badge detection, and the notif:broadcast_publish HTTP gate.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import { buildIngestDeps } from "../src/deps";
import {
  insertNotification,
  insertInbox,
  listInbox,
  unreadCount,
  listAdminNotifications,
} from "../src/repo";
import {
  publishBroadcastFromNotification,
  buildBroadcastInput,
} from "../src/broadcast";
import { makeTestEnv, ctx, fakeIdentity, type TestEnvHandle } from "./helpers";
import type { IngestInput } from "../src/types";
import type { notification } from "@dub/types";

function adminInput(over: Partial<IngestInput> = {}): IngestInput {
  return {
    type: "feedback",
    recipients: { userIds: [] },
    title: "新しいフィードバック: 検索が遅い",
    body: "検索ページが重いです",
    priority: "normal",
    audience: "admin",
    source: "api",
    actorId: "usr_alice",
    requestId: "req_test",
    ...over,
  };
}

// authz identity: allow a check only when its subjectUserId is an admin. Drives the real
// @dub/auth-client both for the manage gate (notif:broadcast_publish) and the inbox
// admin-viewer flag (notif:admin) end to end.
function authzIdentityForAdmins(adminUserIds: string[]): Fetcher {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/authz/check")) {
        const body = (await req.json().catch(() => ({}))) as {
          subjectUserId?: string;
          checks?: unknown[];
        };
        const allowed = !!body.subjectUserId && adminUserIds.includes(body.subjectUserId);
        const decisions = (body.checks ?? [{}]).map(() => ({
          allowed,
          evaluatedAt: new Date().toISOString(),
          ttlSeconds: 0,
        }));
        return new Response(JSON.stringify({ decisions }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

function reqOf(app: ReturnType<typeof createApp>, h: TestEnvHandle) {
  return (path: string, init: RequestInit) => app.request(path, init, h.env as unknown as Record<string, unknown>);
}

describe("audience separation (repo)", () => {
  it("a member never sees an audience='admin' row; an admin does", async () => {
    const h = makeTestEnv();
    const id = await insertNotification(h.db, adminInput());
    // Force an inbox row onto a member (should still be hidden by the audience filter).
    await insertInbox(h.db, id, "usr_member");
    await insertInbox(h.db, id, "usr_admin");

    // Member view (includeAdminAudience=false, the default): filtered out.
    const memberInbox = await listInbox(h.db, "usr_member", { limit: 10 });
    expect(memberInbox.items).toHaveLength(0);
    expect(await unreadCount(h.db, "usr_member")).toBe(0);

    // Admin view: visible.
    const adminInbox = await listInbox(h.db, "usr_admin", { limit: 10 }, true);
    expect(adminInbox.items).toHaveLength(1);
    expect(adminInbox.items[0]!.audience).toBe("admin");
    expect(await unreadCount(h.db, "usr_admin", true)).toBe(1);
  });

  it("a member keeps their own direct (audience='members') notification", async () => {
    const h = makeTestEnv();
    const id = await insertNotification(h.db, adminInput({ type: "task.assigned", audience: "members" }));
    await insertInbox(h.db, id, "usr_member");
    const inbox = await listInbox(h.db, "usr_member", { limit: 10 });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.audience).toBe("members");
  });

  it("defaults an unspecified audience to 'members'", async () => {
    const h = makeTestEnv();
    const noAud = adminInput({ type: "task.created" });
    delete (noAud as { audience?: string }).audience;
    const id = await insertNotification(h.db, noAud);
    await insertInbox(h.db, id, "usr_member");
    const inbox = await listInbox(h.db, "usr_member", { limit: 10 });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.audience).toBe("members");
  });
});

describe("buildBroadcastInput", () => {
  it("targets all users, in_app, type=system.announcement, audience=members, linked dedup key", () => {
    const input = buildBroadcastInput({ id: "ntfn_src", title: "T", body: "B" }, "req_1", "usr_admin");
    expect(input.type).toBe("system.announcement");
    expect(input.recipients).toEqual({ all: true });
    expect(input.audience).toBe("members");
    expect(input.channels).toEqual(["in_app"]);
    expect(input.dedupKey).toBe("broadcast:from:ntfn_src");
    expect(input.meta).toEqual({ sourceNotificationId: "ntfn_src" });
  });
});

describe("publishBroadcastFromNotification", () => {
  function depsFor(h: TestEnvHandle, allUsers: string[]) {
    return buildIngestDeps(h.env, ctx("req_pub"), { identity: fakeIdentity({ allUsers }) });
  }

  it("fans a single members broadcast out to every active user (each keeps own read state)", async () => {
    const h = makeTestEnv();
    const srcId = await insertNotification(h.db, adminInput());
    const res = await publishBroadcastFromNotification(depsFor(h, ["u1", "u2"]), ctx("req_pub"), srcId, "usr_admin");
    expect(res.deduplicated).toBe(false);
    expect(res.publishedBroadcastId).toBe(res.notificationId);

    // Every member sees it (members audience passes the member filter); read state is
    // per-user (marking u1 read leaves u2 unread).
    expect(await unreadCount(h.db, "u1")).toBe(1);
    expect(await unreadCount(h.db, "u2")).toBe(1);
    const u1 = await listInbox(h.db, "u1", { limit: 10 });
    expect(u1.items[0]!.type).toBe("system.announcement");
    expect(u1.items[0]!.audience).toBe("members");
  });

  it("is idempotent — re-publishing the same source creates no second broadcast", async () => {
    const h = makeTestEnv();
    const srcId = await insertNotification(h.db, adminInput());
    const first = await publishBroadcastFromNotification(depsFor(h, ["u1"]), ctx(), srcId, "usr_admin");
    const second = await publishBroadcastFromNotification(depsFor(h, ["u1"]), ctx(), srcId, "usr_admin");
    expect(second.deduplicated).toBe(true);
    expect(second.notificationId).toBe(first.notificationId);
    expect(await unreadCount(h.db, "u1")).toBe(1); // still one row
  });

  it("refuses to publish a non-admin-audience notification (409)", async () => {
    const h = makeTestEnv();
    const srcId = await insertNotification(h.db, adminInput({ audience: "members" }));
    await expect(publishBroadcastFromNotification(depsFor(h, ["u1"]), ctx(), srcId, "usr_admin")).rejects.toMatchObject({
      code: "NOTIF_NOT_ADMIN_AUDIENCE",
    });
  });

  it("404s an unknown source id", async () => {
    const h = makeTestEnv();
    await expect(publishBroadcastFromNotification(depsFor(h, ["u1"]), ctx(), "ntfn_missing", null)).rejects.toMatchObject({
      code: "NOTIF_NOTIFICATION_NOT_FOUND",
    });
  });
});

describe("listAdminNotifications (published badge)", () => {
  it("lists audience='admin' items; publishedBroadcastId flips null -> broadcast id after publish", async () => {
    const h = makeTestEnv();
    const srcId = await insertNotification(h.db, adminInput());
    // a members notification is NOT on the admin list
    await insertNotification(h.db, adminInput({ type: "release", audience: "members" }));

    const before = await listAdminNotifications(h.db, { limit: 10 });
    expect(before.items).toHaveLength(1);
    expect(before.items[0]!.id).toBe(srcId);
    expect(before.items[0]!.publishedBroadcastId).toBeNull();

    const deps = buildIngestDeps(h.env, ctx(), { identity: fakeIdentity({ allUsers: ["u1"] }) });
    const pub = await publishBroadcastFromNotification(deps, ctx(), srcId, "usr_admin");

    const after = await listAdminNotifications(h.db, { limit: 10 });
    expect(after.items[0]!.publishedBroadcastId).toBe(pub.notificationId);
  });
});

describe("HTTP — Notification management gate + end-to-end publish", () => {
  it("GET /manage without notif:broadcast_publish -> 403", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: authzIdentityForAdmins([]) });
    const app = createApp();
    const res = await reqOf(app, h)("/manage", { headers: { "x-dub-user-id": "usr_member" } });
    expect(res.status).toBe(403);
  });

  it("admin publishes; member then sees the broadcast (and not before)", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: authzIdentityForAdmins(["usr_admin"]) });
    const app = createApp({ identity: fakeIdentity({ allUsers: ["usr_admin", "usr_member"] }) });
    const req = reqOf(app, h);

    // Seed an admin notification (as the deploy/feedback pipelines would) + admin inbox row.
    const srcId = await insertNotification(h.db, adminInput());
    await insertInbox(h.db, srcId, "usr_admin");

    // Before publish: member sees nothing; admin sees the admin notification.
    const memberBefore = (await (await req("/inbox", { headers: { "x-dub-user-id": "usr_member" } })).json()) as notification.ListInboxResponse;
    expect(memberBefore.items).toHaveLength(0);

    // GET /manage (admin) lists it, unpublished.
    const manage = (await (await req("/manage", { headers: { "x-dub-user-id": "usr_admin" } })).json()) as notification.ListAdminNotificationsResponse;
    expect(manage.items).toHaveLength(1);
    expect(manage.items[0]!.publishedBroadcastId).toBeNull();

    // Publish to members.
    const pubRes = await req(`/manage/${srcId}/publish`, { method: "POST", headers: { "x-dub-user-id": "usr_admin" } });
    expect(pubRes.status).toBe(202);
    const pub = (await pubRes.json()) as notification.PublishBroadcastResponse;
    expect(pub.publishedBroadcastId).toBe(pub.notificationId);

    // After publish: member now sees the broadcast (backfilled on read), audience=members.
    const memberAfter = (await (await req("/inbox", { headers: { "x-dub-user-id": "usr_member" } })).json()) as notification.ListInboxResponse;
    expect(memberAfter.items).toHaveLength(1);
    expect(memberAfter.items[0]!.type).toBe("system.announcement");
    expect(memberAfter.items[0]!.audience).toBe("members");

    // Admin sees BOTH the original admin notification and the broadcast.
    const adminAfter = (await (await req("/inbox", { headers: { "x-dub-user-id": "usr_admin" } })).json()) as notification.ListInboxResponse;
    const types = adminAfter.items.map((i) => i.type).sort();
    expect(types).toEqual(["feedback", "system.announcement"]);

    // The manage list now shows it as published.
    const manage2 = (await (await req("/manage", { headers: { "x-dub-user-id": "usr_admin" } })).json()) as notification.ListAdminNotificationsResponse;
    expect(manage2.items[0]!.publishedBroadcastId).toBe(pub.notificationId);
  });
});
