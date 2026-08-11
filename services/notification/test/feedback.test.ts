// In-app feedback surface: authed submit -> append-only save + best-effort admin mail;
// admin list (notif:admin) + unread filter + mark-read; non-admin rejected.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { notification } from "@dub/types";
import { createApp } from "../src/app";
import { buildFeedbackEmail } from "../src/feedback";
import { makeTestEnv, type TestEnvHandle, type RecordingMail } from "./helpers";

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
