// In-app feedback surface: authed submit -> append-only save + best-effort admin mail;
// admin list (notif:admin) + unread filter + mark-read; non-admin rejected.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { notification } from "@dub/types";
import { createApp } from "../src/app";
import { buildFeedbackEmail, buildFeedbackNotifyInput, notifyAdminsOfFeedbackInApp } from "../src/feedback";
import { buildIngestDeps } from "../src/deps";
import { unreadCount, listInbox } from "../src/repo";
import {
  makeTestEnv,
  fakeIdentity,
  ctx,
  fakeAuthzFetcher,
  NOTIF_ADMIN_KEYS,
  NOTIF_MEMBER_KEYS,
  type TestEnvHandle,
  type RecordingMail,
} from "./helpers";

// A fake identity binding: `true` = the caller holds the whole 通知 key set (an admin),
// `false` = only what an ordinary member holds, so notif:admin is missing. Lets the real
// /authz/check contract drive the policy gate's notif:admin rule end to end.
function fakeAuthzIdentity(allow: boolean): Fetcher {
  return fakeAuthzFetcher(() => (allow ? NOTIF_ADMIN_KEYS : NOTIF_MEMBER_KEYS));
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
      `SELECT user_id, category, kind, message, page_url, page_name, read_at FROM notif_feedback WHERE id = ?`,
      out.id,
    );
    expect(row).toMatchObject({
      user_id: "usr_alice",
      category: "bug",
      kind: "feedback",
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

  it("POST /feedback: omitted kind defaults to 'feedback'; an inquiry kind is stored as sent", async () => {
    const h = makeTestEnv();
    const app = createApp({ mail: recordingMail("ok") });
    const req = reqOf(app, h);

    const plain = (await (await req("/feedback", jsonPost({ message: "旧ウィジェット互換" }))).json()) as notification.CreateFeedbackResponse;
    const card = await req("/feedback", jsonPost({ message: "希望枚数: 100枚", kind: "business_card" }));
    expect(card.status).toBe(201);
    const cardOut = (await card.json()) as notification.CreateFeedbackResponse;

    const kindOf = async (id: string) =>
      (await h.db.first<{ kind: string; category: string }>(`SELECT kind, category FROM notif_feedback WHERE id = ?`, id))!;
    expect(await kindOf(plain.id)).toEqual({ kind: "feedback", category: "other" });
    expect(await kindOf(cardOut.id)).toEqual({ kind: "business_card", category: "other" });
  });

  it("POST /feedback: unknown kind -> 400 invalid_enum", async () => {
    const h = makeTestEnv();
    const req = reqOf(createApp({ mail: recordingMail("ok") }), h);
    const res = await req("/feedback", jsonPost({ message: "x", kind: "spam" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { field: string; reason: string }[] } };
    expect(body.error.details).toContainEqual(expect.objectContaining({ field: "kind", reason: "invalid_enum" }));
  });

  it("buildFeedbackEmail / buildFeedbackNotifyInput: an inquiry is labelled by its kind (no feedback カテゴリ line)", () => {
    const item: notification.FeedbackItem = {
      id: "nfb_2",
      userId: "usr_a",
      category: "other",
      kind: "interview",
      message: "希望日時の候補: 11/10 午後",
      pageUrl: null,
      pageName: null,
      readAt: null,
      createdAt: "2026-11-04T00:00:00.000Z",
    };
    const email = buildFeedbackEmail(item);
    expect(email.subject).toBe("問い合わせ（面談を希望）: 希望日時の候補: 11/10 午後");
    expect(email.textBody).toContain("種別: 面談を希望");
    expect(email.textBody).not.toContain("カテゴリ:");
    const input = buildFeedbackNotifyInput(item, "req_k");
    expect(input.title).toBe("新しい問い合わせ（面談を希望）: 希望日時の候補: 11/10 午後");
    expect(input.body).toContain("種別: 面談を希望");
  });

  it("permission_request: accepted by POST /feedback and labelled 権限の申請 (not 問い合わせ（…）)", async () => {
    const h = makeTestEnv();
    const req = reqOf(createApp({ mail: recordingMail("ok") }), h);
    const res = await req("/feedback", jsonPost({ message: "アプリ: 名簿\n希望: 編集", kind: "permission_request" }));
    expect(res.status).toBe(201);
    const item: notification.FeedbackItem = {
      id: "nfb_3",
      userId: "usr_a",
      category: "other",
      kind: "permission_request",
      message: "アプリ: 名簿",
      pageUrl: null,
      pageName: null,
      readAt: null,
      createdAt: "2026-11-09T00:00:00.000Z",
    };
    expect(buildFeedbackEmail(item).subject).toBe("権限の申請: アプリ: 名簿");
    const input = buildFeedbackNotifyInput(item, "req_p");
    expect(input.title).toBe("新しい権限の申請: アプリ: 名簿");
    expect(input.recipients).toEqual({ audiences: ["admin"] });
  });

  it("buildFeedbackEmail: subject carries the excerpt + admin recipient", () => {
    const email = buildFeedbackEmail({
      id: "nfb_1",
      userId: "usr_a",
      category: "idea",
      kind: "feedback",
      message: "検索を速くしてほしい",
      pageUrl: "https://app/s",
      pageName: "検索",
      readAt: null,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    expect(email.to[0]!.email).toBe("admin@developershub.jp");
    expect(email.subject).toContain("フィードバック:");
    expect(email.textBody).toContain("種別: フィードバック");
    expect(email.textBody).toContain("カテゴリ: idea");
    expect(email.textBody).toContain("検索を速くしてほしい");
  });
});

// Feedback goes to the 「管理者向け通知を受け取る」 holders (ロール管理), not a role list.
const RECEIVE_ADMIN = "notif:receive_admin";

describe("feedback -> in-app admin notifications", () => {
  it("POST /feedback: creates one inbox notification per notif:receive_admin holder (others excluded)", async () => {
    const identity = fakeIdentity({
      byPermission: {
        [RECEIVE_ADMIN]: ["usr_admin1", "usr_admin2", "usr_maint1"],
        "notif:receive_all": ["usr_member1"],
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

    // one unread inbox item for each admin + maintainer user (feedback is audience='admin'
    // -> counted with the admin-viewer flag; members would never see it).
    expect(await unreadCount(h.db, "usr_admin1", true)).toBe(1);
    expect(await unreadCount(h.db, "usr_admin2", true)).toBe(1);
    expect(await unreadCount(h.db, "usr_maint1", true)).toBe(1);
    // a non-holder gets nothing; the submitter gets none either
    expect(await unreadCount(h.db, "usr_member1", true)).toBe(0);
    expect(await unreadCount(h.db, "usr_alice", true)).toBe(0);

    // only the admin audience key was expanded (no hard-coded role list)
    expect(identity.permissionCalls).toEqual([RECEIVE_ADMIN]);
    expect(identity.roleCalls).toEqual([]);

    // the inbox item is typed + deep-links back to the feedback record
    const inbox = await listInbox(h.db, "usr_admin1", { limit: 10 }, true);
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
    const identity = fakeIdentity({ byPermission: { [RECEIVE_ADMIN]: ["usr_admin1", "usr_maint1"] } });
    const h = makeTestEnv();
    const deps = buildIngestDeps(h.env, ctx("req_idem"), { identity });
    const item: notification.FeedbackItem = {
      id: "nfb_dupe",
      userId: "usr_alice",
      category: "bug",
      kind: "feedback",
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
    // (feedback is audience='admin' -> counted with the admin-viewer flag).
    expect(await unreadCount(h.db, "usr_admin1", true)).toBe(1);
    expect(await unreadCount(h.db, "usr_maint1", true)).toBe(1);
  });

  it("buildFeedbackNotifyInput: in_app only, admin-audience-targeted, feedback-scoped dedupKey", () => {
    const input = buildFeedbackNotifyInput(
      {
        id: "nfb_9",
        userId: "usr_a",
        category: "question",
        kind: "feedback",
        message: "使い方が分からない",
        pageUrl: "https://app/x",
        pageName: "ホーム",
        readAt: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
      "req_1",
    );
    expect(input.channels).toEqual(["in_app"]);
    expect(input.recipients.audiences).toEqual(["admin"]);
    expect(input.recipients.roles).toBeUndefined();
    expect(input.recipients.userIds).toBeUndefined();
    expect(input.dedupKey).toBe("feedback:nfb_9");
    expect(input.resourceType).toBe("feedback");
    expect(input.resourceId).toBe("nfb_9");
    expect(input.actorId).toBe("usr_a");
  });
});
