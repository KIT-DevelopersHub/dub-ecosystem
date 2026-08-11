// In-app feedback surface: authed submit -> append-only save + best-effort admin mail;
// admin list (notif:admin) + unread filter + mark-read; non-admin rejected.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { notification } from "@dub/types";
import { createApp } from "../src/app";
import { buildFeedbackEmail, buildFeedbackNotifyInput, notifyAdminsOfFeedbackInApp } from "../src/feedback";
import { buildIngestDeps } from "../src/deps";
import { unreadCount, listInbox } from "../src/repo";
import { makeTestEnv, fakeIdentity, ctx, type TestEnvHandle, type RecordingMail } from "./helpers";

// A fake identity binding that answers POST /authz/check with a fixed allow/deny —
// lets the real @dub/auth-client drive requirePermission("notif:admin") end to end.
function fakeAuthzIdentity(allow: boolean): Fetcher {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/authz/check")) {
        const payload = {
          decisions: [{ allowed: allow, evaluatedAt: new Date().toISOString(), ttlSeconds: 0 }],
        };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

function recordingMail(behavior: "ok" | "throw" = "ok"): RecordingMail {
  const calls: { req: unknown; idempotencyKey: string }[] = [];
  return {
    calls,
    async send(req, idempotencyKey) {
      calls.push({ req, idempotencyKey });
      if (behavior === "throw") throw new Error("mail send failed");
    },
  };
}

function jsonPost(body: unknown, userId = "usr_alice") {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-dub-user-id": userId },
    body: JSON.stringify(body),
  };
}

function reqOf(app: ReturnType<typeof createApp>, h: TestEnvHandle) {
  return (path: string, init: RequestInit) => app.request(path, init, h.env as unknown as Record<string, unknown>);
}

describe("in-app feedback", () => {
  it("POST /feedback: authed user -> 201, persists append-only, best-effort mail attempted", async () => {
    const h = makeTestEnv();
    const mail = recordingMail("ok");
    const app = createApp({ mail });
    const req = reqOf(app, h);

    const res = await req(
      "/feedback",
      jsonPost({ message: "この画面のボタンが押せない", category: "bug", page: { url: "https://app/x", name: "イベント詳細" } }),
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as notification.CreateFeedbackResponse;
    expect(out.accepted).toBe(true);
    expect(out.id).toMatch(/^nfb_/);

    // persisted
    const row = await h.db.first<{ user_id: string; category: string; message: string; page_url: string; page_name: string; read_at: string | null }>(
      `SELECT user_id, category, message, page_url, page_name, read_at FROM notif_feedback WHERE id = ?`,
      out.id,
    );
    expect(row).toMatchObject({
      user_id: "usr_alice",
      category: "bug",
      message: "この画面のボタンが押せない",
      page_url: "https://app/x",
      page_name: "イベント詳細",
      read_at: null,
    });

    // best-effort mail attempted with the feedback-scoped idempotency key
    expect(mail.calls).toHaveLength(1);
    expect(mail.calls[0]!.idempotencyKey).toBe(`feedback:${out.id}`);
  });

  it("POST /feedback: mail failure is swallowed — the feedback still saves (201)", async () => {
    const h = makeTestEnv();
    const app = createApp({ mail: recordingMail("throw") });
    const req = reqOf(app, h);

    const res = await req("/feedback", jsonPost({ message: "落ちる" }));
    expect(res.status).toBe(201);
    const out = (await res.json()) as notification.CreateFeedbackResponse;
    const row = await h.db.first<{ id: string }>(`SELECT id FROM notif_feedback WHERE id = ?`, out.id);
    expect(row?.id).toBe(out.id);
  });

  it("POST /feedback: missing x-dub-user-id -> 401", async () => {
    const h = makeTestEnv();
    const app = createApp({ mail: recordingMail() });
    const res = await app.request(
      "/feedback",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) },
      h.env as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(401);
  });

  it("POST /feedback: empty message -> 400 NOTIF_VALIDATION_FAILED", async () => {
    const h = makeTestEnv();
    const app = createApp({ mail: recordingMail() });
    const req = reqOf(app, h);
    const res = await req("/feedback", jsonPost({ message: "   " }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOTIF_VALIDATION_FAILED");
  });

  it("POST /feedback: bad category -> 400", async () => {
    const h = makeTestEnv();
    const app = createApp({ mail: recordingMail() });
    const req = reqOf(app, h);
    const res = await req("/feedback", jsonPost({ message: "x", category: "spam" }));
    expect(res.status).toBe(400);
  });

  it("GET /feedback: admin (notif:admin) lists newest-first; unreadOnly filters read items", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: fakeAuthzIdentity(true) });
    const app = createApp({ mail: recordingMail() });
    const req = reqOf(app, h);

    await req("/feedback", jsonPost({ message: "first" }, "usr_a"));
    const second = await req("/feedback", jsonPost({ message: "second" }, "usr_b"));
    const secondId = ((await second.json()) as notification.CreateFeedbackResponse).id;

    const listRes = await req("/feedback", { method: "GET", headers: { "x-dub-user-id": "usr_admin" } });
    expect(listRes.status).toBe(200);
    const page = (await listRes.json()) as notification.ListFeedbackResponse;
    expect(page.items.map((i) => i.message)).toEqual(["second", "first"]);

    // mark the newest read, then unreadOnly should drop it
    const readRes = await req(`/feedback/${secondId}/read`, { method: "PATCH", headers: { "x-dub-user-id": "usr_admin" } });
    expect(readRes.status).toBe(200);

    const unread = await req("/feedback?unreadOnly=true", { method: "GET", headers: { "x-dub-user-id": "usr_admin" } });
    const unreadPage = (await unread.json()) as notification.ListFeedbackResponse;
    expect(unreadPage.items.map((i) => i.message)).toEqual(["first"]);
  });

  it("GET /feedback: non-admin (notif:admin denied) -> 403", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: fakeAuthzIdentity(false) });
    const app = createApp({ mail: recordingMail() });
    const req = reqOf(app, h);
    const res = await req("/feedback", { method: "GET", headers: { "x-dub-user-id": "usr_nobody" } });
    expect(res.status).toBe(403);
  });

  it("PATCH /feedback/:id/read: unknown id -> 404 NOTIF_FEEDBACK_NOT_FOUND", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: fakeAuthzIdentity(true) });
    const app = createApp({ mail: recordingMail() });
    const req = reqOf(app, h);
    const res = await req("/feedback/nfb_missing/read", { method: "PATCH", headers: { "x-dub-user-id": "usr_admin" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOTIF_FEEDBACK_NOT_FOUND");
  });

  it("buildFeedbackEmail: subject carries the excerpt + admin recipient", () => {
    const email = buildFeedbackEmail({
      id: "nfb_1",
      userId: "usr_a",
      category: "idea",
      message: "検索を速くしてほしい",
      pageUrl: "https://app/s",
      pageName: "検索",
      readAt: null,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    expect(email.to[0]!.email).toBe("admin@developershub.jp");
    expect(email.subject).toContain("フィードバック:");
    expect(email.textBody).toContain("検索を速くしてほしい");
  });
});

// Role IDs mirror the identity-roster system-role seed (config.FEEDBACK_NOTIFY_ROLE_IDS).
const ADMIN_ROLE = "role_sys_admin";
const MAINTAINER_ROLE = "role_sys_maintainer";
const MEMBER_ROLE = "role_sys_member";

describe("feedback -> in-app admin notifications", () => {
  it("POST /feedback: creates one inbox notification per admin + maintainer (member excluded)", async () => {
    const identity = fakeIdentity({
      byRole: {
        [ADMIN_ROLE]: ["usr_admin1", "usr_admin2"],
        [MAINTAINER_ROLE]: ["usr_maint1"],
        [MEMBER_ROLE]: ["usr_member1"],
      },
    });
    const h = makeTestEnv();
    const app = createApp({ mail: recordingMail(), identity });
    const req = reqOf(app, h);

    const res = await req(
      "/feedback",
      jsonPost({ message: "検索が遅い", category: "idea", page: { url: "https://app/s", name: "検索" } }, "usr_alice"),
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as notification.CreateFeedbackResponse;

    // one unread inbox item for each admin + maintainer user
    expect(await unreadCount(h.db, "usr_admin1")).toBe(1);
    expect(await unreadCount(h.db, "usr_admin2")).toBe(1);
    expect(await unreadCount(h.db, "usr_maint1")).toBe(1);
    // member role is never queried -> no notification; the submitter gets none either
    expect(await unreadCount(h.db, "usr_member1")).toBe(0);
    expect(await unreadCount(h.db, "usr_alice")).toBe(0);

    // only the admin + maintainer roles were expanded
    expect(identity.roleCalls.sort()).toEqual([ADMIN_ROLE, MAINTAINER_ROLE].sort());

    // the inbox item is typed + deep-links back to the feedback record
    const inbox = await listInbox(h.db, "usr_admin1", { limit: 10 });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ type: "feedback", resourceType: "feedback", resourceId: out.id });
    expect(inbox.items[0]!.title).toContain("検索が遅い");
  });

  it("identity failure is swallowed — feedback still saves (201), no inbox rows", async () => {
    // No identity override -> the SVC_IDENTITY inert fetcher throws on role expansion.
    const h = makeTestEnv();
    const app = createApp({ mail: recordingMail() });
    const req = reqOf(app, h);
    const res = await req("/feedback", jsonPost({ message: "落ちた" }, "usr_bob"));
    expect(res.status).toBe(201);
    const out = (await res.json()) as notification.CreateFeedbackResponse;
    const row = await h.db.first<{ id: string }>(`SELECT id FROM notif_feedback WHERE id = ?`, out.id);
    expect(row?.id).toBe(out.id);
  });

  it("notifyAdminsOfFeedbackInApp is idempotent — re-running does not duplicate inbox rows", async () => {
    const identity = fakeIdentity({ byRole: { [ADMIN_ROLE]: ["usr_admin1"], [MAINTAINER_ROLE]: ["usr_maint1"] } });
    const h = makeTestEnv();
    const deps = buildIngestDeps(h.env, ctx("req_idem"), { identity });
    const item: notification.FeedbackItem = {
      id: "nfb_dupe",
      userId: "usr_alice",
      category: "bug",
      message: "二重にならないこと",
      pageUrl: null,
      pageName: "設定",
      readAt: null,
      createdAt: "2026-08-11T00:00:00.000Z",
    };

    const first = await notifyAdminsOfFeedbackInApp(deps, ctx("req_idem"), item);
    const second = await notifyAdminsOfFeedbackInApp(deps, ctx("req_idem"), item);
    expect(first).toBe(true);
    expect(second).toBe(true);

    // dedupKey (feedback:<id>) makes the second ingest a no-op -> still one row each
    expect(await unreadCount(h.db, "usr_admin1")).toBe(1);
    expect(await unreadCount(h.db, "usr_maint1")).toBe(1);
  });

  it("buildFeedbackNotifyInput: in_app only, role-targeted, feedback-scoped dedupKey", () => {
    const input = buildFeedbackNotifyInput(
      {
        id: "nfb_9",
        userId: "usr_a",
        category: "question",
        message: "使い方が分からない",
        pageUrl: "https://app/x",
        pageName: "ホーム",
        readAt: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
      "req_1",
    );
    expect(input.channels).toEqual(["in_app"]);
    expect(input.recipients.roles).toEqual([ADMIN_ROLE, MAINTAINER_ROLE]);
    expect(input.recipients.userIds).toBeUndefined();
    expect(input.dedupKey).toBe("feedback:nfb_9");
    expect(input.resourceType).toBe("feedback");
    expect(input.resourceId).toBe("nfb_9");
    expect(input.actorId).toBe("usr_a");
  });
});
