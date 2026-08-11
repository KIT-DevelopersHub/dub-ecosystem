import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { makeEnv, fakeIdentityFetcher } from "./helpers";

const app = createApp();

function headers(over: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-dub-request-id": "req_app", ...over };
}

const sendBody: mail.SendMailRequest = { to: [{ email: "a@x.com" }], subject: "Hi", textBody: "Body" };

describe("POST /send", () => {
  it("403s without x-dub-internal (internal-only)", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/send", { method: "POST", headers: headers(), body: JSON.stringify(sendBody) }), env);
    expect(res.status).toBe(403);
  });

  it("400s without an Idempotency-Key", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/send", { method: "POST", headers: headers({ "x-dub-internal": "1", "x-dub-caller": "notification" }), body: JSON.stringify(sendBody) }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_INVALID_REQUEST");
  });

  it("sends (202) for a system-origin internal call (no user) and records the event", async () => {
    const { env, sends } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/send", {
        method: "POST",
        headers: headers({ "x-dub-internal": "1", "x-dub-caller": "notification", "x-dub-idempotency-key": "k1" }),
        body: JSON.stringify(sendBody),
      }),
      env,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as mail.SendMailResponse;
    expect(body.provider).toBe("resend");
    expect(sends.notif).toHaveLength(1);
    expect(sends.notif[0]!.name).toBe("mail.message.sent");
  });

  it("enforces mail:send when a user is present (403 when denied)", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(
      new Request("https://svc/send", {
        method: "POST",
        headers: headers({ "x-dub-internal": "1", "x-dub-user-id": "usr_bob", "x-dub-caller": "notification", "x-dub-idempotency-key": "k2" }),
        body: JSON.stringify(sendBody),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 on idempotent replay", async () => {
    const { env } = makeEnv();
    const h = headers({ "x-dub-internal": "1", "x-dub-caller": "notification", "x-dub-idempotency-key": "k3" });
    const first = await app.fetch(new Request("https://svc/send", { method: "POST", headers: h, body: JSON.stringify(sendBody) }), env);
    expect(first.status).toBe(202);
    const second = await app.fetch(new Request("https://svc/send", { method: "POST", headers: h, body: JSON.stringify(sendBody) }), env);
    expect(second.status).toBe(200);
  });

  it("400s on an invalid recipient", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/send", {
        method: "POST",
        headers: headers({ "x-dub-internal": "1", "x-dub-caller": "notification", "x-dub-idempotency-key": "k4" }),
        body: JSON.stringify({ to: [{ email: "not-an-email" }], subject: "x", textBody: "y" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /mail/outbox (user-facing compose)", () => {
  it("401s without a trusted user header", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/outbox", { method: "POST", headers: headers(), body: JSON.stringify(sendBody) }), env);
    expect(res.status).toBe(401);
  });

  it("403s when mail:send is denied", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(
      new Request("https://svc/mail/outbox", { method: "POST", headers: headers({ "x-dub-user-id": "usr_bob" }), body: JSON.stringify(sendBody) }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("sends (202) for an authorized user with mail:send — no Idempotency-Key required", async () => {
    const { env, sends } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/outbox", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }), body: JSON.stringify(sendBody) }),
      env,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as mail.SendMailResponse;
    expect(body.messageId).toContain("@developershub.jp");
    expect(sends.notif).toHaveLength(1);
    expect(sends.notif[0]!.name).toBe("mail.message.sent");
  });

  it("400s on an invalid recipient", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: headers({ "x-dub-user-id": "usr_alice" }),
        body: JSON.stringify({ to: [{ email: "nope" }], subject: "x", textBody: "y" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("dedupes on a repeated Idempotency-Key (二重送信ゼロ)", async () => {
    const { env, sends } = makeEnv();
    const h = headers({ "x-dub-user-id": "usr_alice", "x-dub-idempotency-key": "ob1" });
    const first = await app.fetch(new Request("https://svc/mail/outbox", { method: "POST", headers: h, body: JSON.stringify(sendBody) }), env);
    expect(first.status).toBe(202);
    const second = await app.fetch(new Request("https://svc/mail/outbox", { method: "POST", headers: h, body: JSON.stringify(sendBody) }), env);
    expect(second.status).toBe(200);
    expect(sends.notif).toHaveLength(1);
  });
});

describe("read routes (/mail/messages)", () => {
  it("401s without a trusted user header", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/messages", { headers: headers() }), env);
    expect(res.status).toBe(401);
  });

  it("lists messages (empty) with mail:read", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/messages", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: null };
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("403s when mail:read is denied", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(new Request("https://svc/mail/messages", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(403);
  });

  it("404s for a missing message", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/messages/does-not-exist", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_MESSAGE_NOT_FOUND");
  });
});

// The external surface is mounted under /mail so the gateway-forwarded /api/v1/mail/*
// (segment preserved, API_PREFIX stripped) reaches the Worker. Guard against a
// regression to bare external paths (which would 404 every gateway-forwarded request).
describe("external routes require the /mail mount", () => {
  it("bare /messages (no /mail) is not routed → 404", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/messages", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(404);
  });

  it("bare /messages/:id/read (no /mail) is not routed → 404", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/messages/mailin_1/read", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(404);
  });

  it("bare /outbox (no /mail) is not routed → 404", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/outbox", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }), body: JSON.stringify(sendBody) }), env);
    expect(res.status).toBe(404);
  });
});

describe("inbox detail (body + read state)", () => {
  const seedInbound = (
    raw: ReturnType<typeof makeEnv>["raw"],
    over: { id?: string; messageId?: string; threadId?: string; bodyText?: string; htmlBody?: string | null; readAt?: string | null; receivedAt?: string } = {},
  ) => {
    const id = over.id ?? "mailin_1";
    raw
      .prepare(
        `INSERT INTO mail_inbound
           (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
            auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at)
         VALUES (?, ?, ?, 'info', ?, ?, 'Hello', 'snip', NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        over.messageId ?? `<${id}@x>`,
        over.threadId ?? "thr_1",
        JSON.stringify({ email: "sender@x.com", name: "Sender" }),
        JSON.stringify([{ email: "info@developershub.jp" }]),
        over.receivedAt ?? "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
        over.bodyText ?? "Full body text here.",
        over.htmlBody === undefined ? null : over.htmlBody,
        over.readAt === undefined ? null : over.readAt,
      );
    return id;
  };
  const h = (over: Record<string, string> = {}) => ({ "content-type": "application/json", "x-dub-request-id": "req_d", "x-dub-user-id": "usr_alice", ...over });

  it("GET /messages returns read:false for a fresh message", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const res = await app.fetch(new Request("https://svc/mail/messages", { headers: h() }), env);
    const body = (await res.json()) as { items: mail.MailMessageListItem[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.read).toBe(false);
  });

  it("GET /messages/:id returns the full body + read state", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw, { bodyText: "Dear team, please review." });
    const res = await app.fetch(new Request("https://svc/mail/messages/mailin_1", { headers: h() }), env);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as mail.MailMessageDetail;
    expect(detail.textBody).toBe("Dear team, please review.");
    expect(detail.read).toBe(false);
    expect(detail.htmlBody).toBeUndefined();
  });

  it("GET /messages/:id surfaces an htmlBody when the row has one", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw, { htmlBody: "<p>hi</p>" });
    const res = await app.fetch(new Request("https://svc/mail/messages/mailin_1", { headers: h() }), env);
    const detail = (await res.json()) as mail.MailMessageDetail;
    expect(detail.htmlBody).toBe("<p>hi</p>");
  });

  it("POST /messages/:id/read flips read to true (idempotently) and 404s an unknown id", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const mark = await app.fetch(new Request("https://svc/mail/messages/mailin_1/read", { method: "POST", headers: h() }), env);
    expect(mark.status).toBe(200);
    expect(await mark.json()).toEqual({ read: true });

    const after = await app.fetch(new Request("https://svc/mail/messages/mailin_1", { headers: h() }), env);
    expect(((await after.json()) as mail.MailMessageDetail).read).toBe(true);

    // second call is a no-op (still 200) — first-open stamp is not overwritten
    const again = await app.fetch(new Request("https://svc/mail/messages/mailin_1/read", { method: "POST", headers: h() }), env);
    expect(again.status).toBe(200);

    const missing = await app.fetch(new Request("https://svc/mail/messages/nope/read", { method: "POST", headers: h() }), env);
    expect(missing.status).toBe(404);
  });

  it("POST /messages/:id/read requires mail:read (403 when denied)", async () => {
    const { env, raw } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    seedInbound(raw);
    const res = await app.fetch(new Request("https://svc/mail/messages/mailin_1/read", { method: "POST", headers: h() }), env);
    expect(res.status).toBe(403);
  });

  it("GET /threads/:id returns every message in the thread with bodies (oldest→newest)", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw, { id: "mailin_a", messageId: "<a@x>", threadId: "thr_9", bodyText: "first", receivedAt: "2026-08-10T00:00:00.000Z" });
    seedInbound(raw, { id: "mailin_b", messageId: "<b@x>", threadId: "thr_9", bodyText: "second", receivedAt: "2026-08-10T01:00:00.000Z" });
    const res = await app.fetch(new Request("https://svc/mail/threads/thr_9", { headers: h() }), env);
    expect(res.status).toBe(200);
    const thread = (await res.json()) as mail.MailThread;
    expect(thread.id).toBe("thr_9");
    expect(thread.messages.map((m) => m.textBody)).toEqual(["first", "second"]);
  });

  it("GET /threads/:id 404s an unknown thread", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/threads/missing", { headers: h() }), env);
    expect(res.status).toBe(404);
  });
});

describe("Sent folder (/mail/sent)", () => {
  const h = (over: Record<string, string> = {}) => ({ "content-type": "application/json", "x-dub-request-id": "req_s", "x-dub-user-id": "usr_alice", ...over });

  it("401/403s the list without a session identity", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/sent", { headers: headers() }), env);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  it("403s the list when mail:read is denied", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(new Request("https://svc/mail/sent", { headers: h() }), env);
    expect(res.status).toBe(403);
  });

  it("lists a mail sent through /mail/outbox and opens its detail", async () => {
    const { env } = makeEnv();
    const out = await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: h({ "x-dub-idempotency-key": "sent-ob-1" }),
        body: JSON.stringify({ to: [{ email: "b@x.com", name: "Bob" }], subject: "Report", textBody: "Body of the report." }),
      }),
      env,
    );
    expect(out.status).toBe(202);

    const list = await app.fetch(new Request("https://svc/mail/sent", { headers: h() }), env);
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: mail.MailSentListItem[] };
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.subject).toBe("Report");
    expect(item.to).toEqual([{ email: "b@x.com", name: "Bob" }]);
    expect(item.status).toBe("sent");
    expect(item.snippet).toBe("Body of the report.");

    const detailRes = await app.fetch(new Request(`https://svc/mail/sent/${encodeURIComponent(item.id)}`, { headers: h() }), env);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as mail.MailSentDetail;
    expect(detail.textBody).toBe("Body of the report.");
  });

  it("404s an unknown sent id", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/sent/nope", { headers: h() }), env);
    expect(res.status).toBe(404);
  });
});

describe("health", () => {
  it("reports ok", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/internal/health", { headers: headers() }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "mail-gateway" });
  });
});

describe("GET /internal/status (rate-limit visibility)", () => {
  const seedFailure = (raw: ReturnType<typeof makeEnv>["raw"], errorCode: string, updatedAt: string) => {
    raw
      .prepare(
        `INSERT INTO mail_send_log
           (id, idempotency_key, req_hash, requester, to_json, subject, thread_id,
            provider, provider_message_id, status, error_code, created_at, updated_at)
         VALUES (?, ?, 'h', 'notification', '[]', 'S', NULL, NULL, NULL, 'failed', ?, ?, ?)`,
      )
      .run(`maillog_${errorCode}_${updatedAt}`, `k_${updatedAt}`, errorCode, updatedAt, updatedAt);
  };

  it("403s without x-dub-internal", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/internal/status", { headers: headers() }), env);
    expect(res.status).toBe(403);
  });

  it("reports rateLimit.active=false with no recent 429", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/internal/status", { headers: headers({ "x-dub-internal": "1" }) }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; provider: string; rateLimit: { active: boolean } };
    expect(body.service).toBe("mail-gateway");
    expect(body.rateLimit.active).toBe(false);
  });

  it("reports rateLimit.active=true after a recent MAIL_RATE_LIMITED failure", async () => {
    const { env, raw } = makeEnv();
    seedFailure(raw, "MAIL_RATE_LIMITED", new Date().toISOString());
    const res = await app.fetch(new Request("https://svc/internal/status", { headers: headers({ "x-dub-internal": "1" }) }), env);
    const body = (await res.json()) as { rateLimit: { active: boolean; code?: string; recoversAt?: string } };
    expect(body.rateLimit.active).toBe(true);
    expect(body.rateLimit.code).toBe("MAIL_RATE_LIMITED");
    expect(typeof body.rateLimit.recoversAt).toBe("string");
  });

  it("stays active=false when the latest failure is an old 429 (cooled down)", async () => {
    const { env, raw } = makeEnv();
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago > 60s default
    seedFailure(raw, "MAIL_RATE_LIMITED", old);
    const res = await app.fetch(new Request("https://svc/internal/status", { headers: headers({ "x-dub-internal": "1" }) }), env);
    const body = (await res.json()) as { rateLimit: { active: boolean } };
    expect(body.rateLimit.active).toBe(false);
  });
});
