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

  it("sets From to the logged-in user's @developershub.jp address (roster lookup)", async () => {
    const { env } = makeEnv({
      SVC_IDENTITY: fakeIdentityFetcher(true, { usr_alice: { email: "alice@developershub.jp", displayName: "Alice" } }),
    });
    const send = await app.fetch(
      new Request("https://svc/mail/outbox", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }), body: JSON.stringify(sendBody) }),
      env,
    );
    expect(send.status).toBe(202);
    // The Sent folder projects the send-log's stored From — assert it is the user's address.
    const listRes = await app.fetch(new Request("https://svc/mail/sent", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    const page = (await listRes.json()) as { items: mail.MailSentListItem[] };
    expect(page.items[0]!.from?.email).toBe("alice@developershub.jp");
  });

  it("falls back to info@ when the caller is not a @developershub.jp roster member", async () => {
    const { env } = makeEnv({
      SVC_IDENTITY: fakeIdentityFetcher(true, { usr_ext: { email: "outsider@gmail.com" } }),
    });
    const send = await app.fetch(
      new Request("https://svc/mail/outbox", { method: "POST", headers: headers({ "x-dub-user-id": "usr_ext" }), body: JSON.stringify(sendBody) }),
      env,
    );
    expect(send.status).toBe(202);
    const listRes = await app.fetch(new Request("https://svc/mail/sent", { headers: headers({ "x-dub-user-id": "usr_ext" }) }), env);
    const page = (await listRes.json()) as { items: mail.MailSentListItem[] };
    expect(page.items[0]!.from?.email).toBe("info@developershub.jp");
  });

  it("a REPLY goes out AS the mailbox the parent was addressed to (info@), not the reader's own address, and links the thread", async () => {
    const { env, raw } = makeEnv({
      SVC_IDENTITY: fakeIdentityFetcher(true, { usr_admin: { email: "admin@developershub.jp", displayName: "Admin" } }),
    });
    // The received message the reply threads against — addressed to the shared info@ box.
    raw
      .prepare(
        `INSERT INTO mail_inbound
           (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
            auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at)
         VALUES ('mailin_r', 'ext-1@gmail.com', 'ext-1@gmail.com', 'info', ?, ?, 'Hi', 'snip', NULL, NULL, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z', 'hello', NULL, NULL)`,
      )
      .run(JSON.stringify({ email: "outsider@gmail.com" }), JSON.stringify([{ email: "info@developershub.jp" }]));

    const replyBody: mail.SendMailRequest = {
      to: [{ email: "outsider@gmail.com" }],
      subject: "Re: Hi",
      textBody: "thanks",
      inReplyTo: "ext-1@gmail.com",
    };
    const send = await app.fetch(
      new Request("https://svc/mail/outbox", { method: "POST", headers: headers({ "x-dub-user-id": "usr_admin" }), body: JSON.stringify(replyBody) }),
      env,
    );
    expect(send.status).toBe(202);
    const listRes = await app.fetch(new Request("https://svc/mail/sent", { headers: headers({ "x-dub-user-id": "usr_admin" }) }), env);
    const page = (await listRes.json()) as { items: mail.MailSentListItem[] };
    // From = info@ (shared mailbox the mail came in on) so the external reply returns to a
    // Worker-routed address — NOT admin@ (the reader). threadId links the reply to the thread.
    expect(page.items[0]!.from?.email).toBe("info@developershub.jp");
    expect(page.items[0]!.threadId).toBe("ext-1@gmail.com");
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

  it("409s downloading a DROPPED attachment stub (改善#2: unstorable, never a phantom download)", async () => {
    // A fake R2 bucket so buildBlobs is non-null (the route must 409 BEFORE touching it).
    const bucket = { get: async () => null, put: async () => undefined, delete: async () => undefined };
    const { env, raw } = makeEnv({ R2_MAIL: bucket as never });
    // Seed a dropped stub directly (r2_key='' — no bytes were ever stored).
    raw
      .prepare(
        `INSERT INTO mail_attachments (id, message_kind, message_id, filename, mime_type, size_bytes, r2_key, created_at, status)
         VALUES (?, 'inbound', ?, ?, 'application/octet-stream', ?, '', ?, 'dropped_too_large')`,
      )
      .run("mailatt_drop", "mailin_x", "巨大.zip", 41943040, "2026-08-10T00:00:00.000Z");
    const res = await app.fetch(
      new Request("https://svc/mail/messages/mailin_x/attachments/mailatt_drop", { headers: headers({ "x-dub-user-id": "usr_alice" }) }),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_ATTACHMENT_NOT_STORED");
  });
});

describe("per-user thread flags (/mail/flags — 改善#8)", () => {
  it("401s without a trusted user header", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/flags", { headers: headers() }), env);
    expect(res.status).toBe(401);
  });

  it("returns an empty list before anything is flagged", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/flags", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("persists a star and reads it back (survives a reload)", async () => {
    const { env } = makeEnv();
    const post = await app.fetch(
      new Request("https://svc/mail/flags/thr_1", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }), body: JSON.stringify({ starred: true }) }),
      env,
    );
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ threadId: "thr_1", starred: true, archived: false, trashed: false });
    // A fresh request (new "session") reads the persisted flag from the same DB.
    const get = await app.fetch(new Request("https://svc/mail/flags", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(await get.json()).toEqual({ items: [{ threadId: "thr_1", starred: true, archived: false, trashed: false }] });
  });

  it("trash then restore round-trips the trashed flag (ゴミ箱→復元), body never deleted", async () => {
    const { env } = makeEnv();
    const h = headers({ "x-dub-user-id": "usr_carol" });
    // Trash: the per-user soft-delete. Only this user's flag changes; no message row is touched.
    const trash = await app.fetch(new Request("https://svc/mail/flags/thr_trash", { method: "POST", headers: h, body: JSON.stringify({ trashed: true }) }), env);
    expect(await trash.json()).toEqual({ threadId: "thr_trash", starred: false, archived: false, trashed: true });
    // Restore: flips the same personal flag back off.
    const restore = await app.fetch(new Request("https://svc/mail/flags/thr_trash", { method: "POST", headers: h, body: JSON.stringify({ trashed: false }) }), env);
    expect(await restore.json()).toEqual({ threadId: "thr_trash", starred: false, archived: false, trashed: false });
    // Persisted state reads back as not-trashed (survives a reload).
    const get = await app.fetch(new Request("https://svc/mail/flags", { headers: h }), env);
    expect(await get.json()).toEqual({ items: [{ threadId: "thr_trash", starred: false, archived: false, trashed: false }] });
  });

  it("one user's trash is invisible to another (admin/other sees mail unaffected)", async () => {
    const { env } = makeEnv();
    await app.fetch(new Request("https://svc/mail/flags/thr_shared", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }), body: JSON.stringify({ trashed: true }) }), env);
    // Another account (e.g. an admin viewing the same conversation) has no trashed flag for it.
    const other = await app.fetch(new Request("https://svc/mail/flags", { headers: headers({ "x-dub-user-id": "usr_admin" }) }), env);
    expect(await other.json()).toEqual({ items: [] });
  });

  it("PATCH semantics: a later archive keeps the earlier star", async () => {
    const { env } = makeEnv();
    const h = headers({ "x-dub-user-id": "usr_bob" });
    await app.fetch(new Request("https://svc/mail/flags/thr_2", { method: "POST", headers: h, body: JSON.stringify({ starred: true }) }), env);
    const res = await app.fetch(new Request("https://svc/mail/flags/thr_2", { method: "POST", headers: h, body: JSON.stringify({ archived: true }) }), env);
    expect(await res.json()).toEqual({ threadId: "thr_2", starred: true, archived: true, trashed: false });
  });

  it("flags are per-user (Bob never sees Alice's stars)", async () => {
    const { env } = makeEnv();
    await app.fetch(new Request("https://svc/mail/flags/thr_3", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }), body: JSON.stringify({ starred: true }) }), env);
    const bob = await app.fetch(new Request("https://svc/mail/flags", { headers: headers({ "x-dub-user-id": "usr_bob" }) }), env);
    expect(await bob.json()).toEqual({ items: [] });
  });

  it("400s on a non-boolean flag", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/flags/thr_4", { method: "POST", headers: headers({ "x-dub-user-id": "usr_alice" }), body: JSON.stringify({ starred: "yes" }) }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("403s when mail:read is denied", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(new Request("https://svc/mail/flags", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(403);
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
    over: { id?: string; messageId?: string; threadId?: string; bodyText?: string; htmlBody?: string | null; readAt?: string | null; receivedAt?: string; ownerUserId?: string | null } = {},
  ) => {
    const id = over.id ?? "mailin_1";
    raw
      .prepare(
        `INSERT INTO mail_inbound
           (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
            auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id)
         VALUES (?, ?, ?, 'info', ?, ?, 'Hello', 'snip', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
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
        over.ownerUserId === undefined ? "usr_alice" : over.ownerUserId,
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

// ===================== per-account scope (Gmail-style isolation) =====================
// The security property: an account sees ONLY its own sent / received / thread mail, and
// can never open or mutate another account's message. Exercised through the REAL Hono app
// (real auth middleware + real in-memory D1) via app.fetch — the same pipeline production
// serves. usr_alice and usr_bob are two distinct signed-in accounts.
describe("account isolation (per-user scope)", () => {
  const asUser = (userId: string, over: Record<string, string> = {}) =>
    ({ "content-type": "application/json", "x-dub-request-id": "req_iso", "x-dub-user-id": userId, ...over });

  // Insert an inbound message owned by a specific user (bypasses ingest; owner set直接).
  const seedOwned = (
    raw: ReturnType<typeof makeEnv>["raw"],
    row: { id: string; ownerUserId: string; threadId?: string; messageId?: string },
  ) => {
    raw
      .prepare(
        `INSERT INTO mail_inbound
           (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
            auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id)
         VALUES (?, ?, ?, 'info', ?, ?, 'Hi', 'snip', NULL, NULL, ?, ?, 'body', NULL, NULL, ?)`,
      )
      .run(
        row.id,
        row.messageId ?? `<${row.id}@x>`,
        row.threadId ?? `thr_${row.id}`,
        JSON.stringify({ email: "sender@x.com" }),
        JSON.stringify([{ email: "info@developershub.jp" }]),
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
        row.ownerUserId,
      );
  };

  it("Sent: a mail A sends is invisible in B's Sent folder (and visible in A's)", async () => {
    const { env } = makeEnv();
    const send = await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: asUser("usr_alice", { "x-dub-idempotency-key": "iso-1" }),
        body: JSON.stringify({ to: [{ email: "x@x.com" }], subject: "Alice-only", textBody: "secret" }),
      }),
      env,
    );
    expect(send.status).toBe(202);

    const aList = (await (await app.fetch(new Request("https://svc/mail/sent", { headers: asUser("usr_alice") }), env)).json()) as { items: mail.MailSentListItem[] };
    expect(aList.items.map((i) => i.subject)).toContain("Alice-only");

    const bList = (await (await app.fetch(new Request("https://svc/mail/sent", { headers: asUser("usr_bob") }), env)).json()) as { items: mail.MailSentListItem[] };
    expect(bList.items).toHaveLength(0); // B sees none of A's sent mail
  });

  it("Sent detail: B cannot open A's sent message (404, not 403 — no existence leak)", async () => {
    const { env } = makeEnv();
    await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: asUser("usr_alice", { "x-dub-idempotency-key": "iso-2" }),
        body: JSON.stringify({ to: [{ email: "x@x.com" }], subject: "S", textBody: "b" }),
      }),
      env,
    );
    const aList = (await (await app.fetch(new Request("https://svc/mail/sent", { headers: asUser("usr_alice") }), env)).json()) as { items: mail.MailSentListItem[] };
    const id = aList.items[0]!.id;

    const bDetail = await app.fetch(new Request(`https://svc/mail/sent/${encodeURIComponent(id)}`, { headers: asUser("usr_bob") }), env);
    expect(bDetail.status).toBe(404);
    const aDetail = await app.fetch(new Request(`https://svc/mail/sent/${encodeURIComponent(id)}`, { headers: asUser("usr_alice") }), env);
    expect(aDetail.status).toBe(200);
  });

  it("Inbox: each account lists only messages delivered to it", async () => {
    const { env, raw } = makeEnv();
    seedOwned(raw, { id: "in_alice", ownerUserId: "usr_alice" });
    seedOwned(raw, { id: "in_bob", ownerUserId: "usr_bob" });

    const aBox = (await (await app.fetch(new Request("https://svc/mail/messages", { headers: asUser("usr_alice") }), env)).json()) as { items: mail.MailMessageListItem[] };
    expect(aBox.items.map((m) => m.id)).toEqual(["in_alice"]);

    const bBox = (await (await app.fetch(new Request("https://svc/mail/messages", { headers: asUser("usr_bob") }), env)).json()) as { items: mail.MailMessageListItem[] };
    expect(bBox.items.map((m) => m.id)).toEqual(["in_bob"]);
  });

  it("Message detail + thread: B cannot read A's message or thread (404)", async () => {
    const { env, raw } = makeEnv();
    seedOwned(raw, { id: "in_a", ownerUserId: "usr_alice", threadId: "thr_a" });

    const bMsg = await app.fetch(new Request("https://svc/mail/messages/in_a", { headers: asUser("usr_bob") }), env);
    expect(bMsg.status).toBe(404);
    const bThread = await app.fetch(new Request("https://svc/mail/threads/thr_a", { headers: asUser("usr_bob") }), env);
    expect(bThread.status).toBe(404);

    // A can (owns it)
    expect((await app.fetch(new Request("https://svc/mail/messages/in_a", { headers: asUser("usr_alice") }), env)).status).toBe(200);
  });

  it("Mark-read: B cannot flip A's message read state (404, and it stays unread for A)", async () => {
    const { env, raw } = makeEnv();
    seedOwned(raw, { id: "in_a2", ownerUserId: "usr_alice" });

    const bMark = await app.fetch(new Request("https://svc/mail/messages/in_a2/read", { method: "POST", headers: asUser("usr_bob") }), env);
    expect(bMark.status).toBe(404);

    const aDetail = (await (await app.fetch(new Request("https://svc/mail/messages/in_a2", { headers: asUser("usr_alice") }), env)).json()) as mail.MailMessageDetail;
    expect(aDetail.read).toBe(false); // B's attempt did not touch A's message
  });

  it("legacy rows with no owner are invisible to everyone (fail-closed)", async () => {
    const { env, raw } = makeEnv();
    seedOwned(raw, { id: "in_orphan", ownerUserId: null as unknown as string });
    for (const u of ["usr_alice", "usr_bob"]) {
      const box = (await (await app.fetch(new Request("https://svc/mail/messages", { headers: asUser(u) }), env)).json()) as { items: unknown[] };
      expect(box.items).toHaveLength(0);
    }
  });
});

describe("oversight — mail:read_all bypasses account scope", () => {
  const asUser = (userId: string, over: Record<string, string> = {}) =>
    ({ "content-type": "application/json", "x-dub-request-id": "req_ovr", "x-dub-user-id": userId, ...over });
  // An identity where the caller holds BOTH mail:read (guard) and mail:read_all (oversight).
  const oversightEnv = () => makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["mail:read", "mail:read_all", "mail:send"]) });

  const seedOwned = (raw: ReturnType<typeof makeEnv>["raw"], row: { id: string; ownerUserId: string | null; threadId?: string }) => {
    raw
      .prepare(
        `INSERT INTO mail_inbound
           (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
            auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id)
         VALUES (?, ?, ?, 'info', ?, ?, 'Hi', 'snip', NULL, NULL, ?, ?, 'body', NULL, NULL, ?)`,
      )
      .run(
        row.id,
        `<${row.id}@x>`,
        row.threadId ?? `thr_${row.id}`,
        JSON.stringify({ email: "sender@x.com" }),
        JSON.stringify([{ email: "info@developershub.jp" }]),
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
        row.ownerUserId,
      );
  };

  it("Inbox: a mail:read_all holder lists EVERY account's messages (incl. NULL-owner)", async () => {
    const { env, raw } = oversightEnv();
    seedOwned(raw, { id: "in_alice", ownerUserId: "usr_alice" });
    seedOwned(raw, { id: "in_bob", ownerUserId: "usr_bob" });
    seedOwned(raw, { id: "in_orphan", ownerUserId: null }); // archive/legacy row, owner unresolved

    const box = (await (await app.fetch(new Request("https://svc/mail/messages", { headers: asUser("usr_super") }), env)).json()) as { items: mail.MailMessageListItem[] };
    expect(box.items.map((m) => m.id).sort()).toEqual(["in_alice", "in_bob", "in_orphan"]);
  });

  it("Detail + thread: a mail:read_all holder can open any account's message and thread", async () => {
    const { env, raw } = oversightEnv();
    seedOwned(raw, { id: "in_a", ownerUserId: "usr_alice", threadId: "thr_a" });
    expect((await app.fetch(new Request("https://svc/mail/messages/in_a", { headers: asUser("usr_super") }), env)).status).toBe(200);
    const thread = await app.fetch(new Request("https://svc/mail/threads/thr_a", { headers: asUser("usr_super") }), env);
    expect(thread.status).toBe(200);
  });

  it("Sent: a mail:read_all holder sees another user's sent mail", async () => {
    const { env } = oversightEnv();
    await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: asUser("usr_alice", { "x-dub-idempotency-key": "ovr-1" }),
        body: JSON.stringify({ to: [{ email: "x@x.com" }], subject: "Alice-sent", textBody: "body" }),
      }),
      env,
    );
    const list = (await (await app.fetch(new Request("https://svc/mail/sent", { headers: asUser("usr_super") }), env)).json()) as { items: mail.MailSentListItem[] };
    expect(list.items.map((i) => i.subject)).toContain("Alice-sent");
  });

  it("without mail:read_all a caller stays scoped to their own mail (fail-closed)", async () => {
    // grant mail:read only (NOT mail:read_all) — the default isolation applies.
    const { env, raw } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["mail:read"]) });
    seedOwned(raw, { id: "in_alice", ownerUserId: "usr_alice" });
    const box = (await (await app.fetch(new Request("https://svc/mail/messages", { headers: asUser("usr_bob") }), env)).json()) as { items: mail.MailMessageListItem[] };
    expect(box.items).toHaveLength(0); // bob (no read_all) sees none of alice's mail
  });
});

describe("archive auto-CC on send", () => {
  const asUser = (userId: string, over: Record<string, string> = {}) =>
    ({ "content-type": "application/json", "x-dub-request-id": "req_cc", "x-dub-user-id": userId, ...over });

  it("adds the archive address to Cc on every outbox send (default archive@developershub.jp)", async () => {
    const { env } = makeEnv(); // MAIL_ARCHIVE_CC unset -> DEFAULT_ARCHIVE_CC_ADDRESS
    const out = await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: asUser("usr_alice", { "x-dub-idempotency-key": "cc-1" }),
        body: JSON.stringify({ to: [{ email: "b@x.com" }], subject: "Report", textBody: "body" }),
      }),
      env,
    );
    expect(out.status).toBe(202);
    // The persisted Sent row records the archive in its Cc.
    const detailList = (await (await app.fetch(new Request("https://svc/mail/sent", { headers: asUser("usr_alice") }), env)).json()) as { items: mail.MailSentListItem[] };
    const id = detailList.items[0]!.id;
    const detail = (await (await app.fetch(new Request(`https://svc/mail/sent/${encodeURIComponent(id)}`, { headers: asUser("usr_alice") }), env)).json()) as mail.MailSentDetail;
    expect((detail.cc ?? []).map((a) => a.email)).toContain("archive@developershub.jp");
  });

  it("does not duplicate the archive address when the caller already CC'd it", async () => {
    const { env } = makeEnv({ MAIL_ARCHIVE_CC: "archive@developershub.jp" });
    await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: asUser("usr_alice", { "x-dub-idempotency-key": "cc-2" }),
        body: JSON.stringify({ to: [{ email: "b@x.com" }], cc: [{ email: "archive@developershub.jp" }], subject: "R", textBody: "b" }),
      }),
      env,
    );
    const list = (await (await app.fetch(new Request("https://svc/mail/sent", { headers: asUser("usr_alice") }), env)).json()) as { items: mail.MailSentListItem[] };
    const detail = (await (await app.fetch(new Request(`https://svc/mail/sent/${encodeURIComponent(list.items[0]!.id)}`, { headers: asUser("usr_alice") }), env)).json()) as mail.MailSentDetail;
    const archives = (detail.cc ?? []).filter((a) => a.email === "archive@developershub.jp");
    expect(archives).toHaveLength(1);
  });

  it("MAIL_ARCHIVE_CC='' disables the auto-CC (opt-out)", async () => {
    const { env } = makeEnv({ MAIL_ARCHIVE_CC: "" });
    await app.fetch(
      new Request("https://svc/mail/outbox", {
        method: "POST",
        headers: asUser("usr_alice", { "x-dub-idempotency-key": "cc-3" }),
        body: JSON.stringify({ to: [{ email: "b@x.com" }], subject: "R", textBody: "b" }),
      }),
      env,
    );
    const list = (await (await app.fetch(new Request("https://svc/mail/sent", { headers: asUser("usr_alice") }), env)).json()) as { items: mail.MailSentListItem[] };
    const detail = (await (await app.fetch(new Request(`https://svc/mail/sent/${encodeURIComponent(list.items[0]!.id)}`, { headers: asUser("usr_alice") }), env)).json()) as mail.MailSentDetail;
    expect((detail.cc ?? []).map((a) => a.email)).not.toContain("archive@developershub.jp");
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
