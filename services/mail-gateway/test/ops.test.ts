// Gmail-parity操作系 endpoint tests: flags, labels, drafts, reply/forward, sent, search,
// thread ops, and the freeq D1 outbox drain. Uses the real in-memory D1 (with 0003) so
// the SQL / dedup guarantees are exercised authentically.
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { makeEnv, fakeIdentityFetcher } from "./helpers";
import type { MailDraft, MailLabel, MailMessageDetailX, MailMessageListItemX, SentMailListItem } from "../src/ops-dto";

const app = createApp();

const h = (over: Record<string, string> = {}) => ({ "content-type": "application/json", "x-dub-request-id": "req_ops", "x-dub-user-id": "usr_alice", ...over });

function seedInbound(
  raw: ReturnType<typeof makeEnv>["raw"],
  over: { id?: string; messageId?: string; threadId?: string; subject?: string; bodyText?: string; from?: string; receivedAt?: string } = {},
): string {
  const id = over.id ?? "mailin_1";
  raw
    .prepare(
      `INSERT INTO mail_inbound
         (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
          auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at)
       VALUES (?, ?, ?, 'info', ?, ?, ?, 'snip', NULL, NULL, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      over.messageId ?? `<${id}@x>`,
      over.threadId ?? "thr_1",
      JSON.stringify({ email: over.from ?? "sender@x.com", name: "Sender" }),
      JSON.stringify([{ email: "info@developershub.jp" }]),
      over.subject ?? "Hello",
      over.receivedAt ?? "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
      over.bodyText ?? "Full body text here.",
    );
  return id;
}

// Env-bound HTTP client (every Worker call must receive its bindings as fetch's 2nd arg).
function api(env: ReturnType<typeof makeEnv>["env"]) {
  return {
    post: (path: string, headers: Record<string, string>, body?: unknown) =>
      app.fetch(new Request(`https://svc${path}`, { method: "POST", headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env),
    del: (path: string, headers: Record<string, string>) => app.fetch(new Request(`https://svc${path}`, { method: "DELETE", headers }), env),
    put: (path: string, headers: Record<string, string>, body: unknown) =>
      app.fetch(new Request(`https://svc${path}`, { method: "PUT", headers, body: JSON.stringify(body) }), env),
    patch: (path: string, headers: Record<string, string>, body: unknown) =>
      app.fetch(new Request(`https://svc${path}`, { method: "PATCH", headers, body: JSON.stringify(body) }), env),
    get: (path: string, headers: Record<string, string>) => app.fetch(new Request(`https://svc${path}`, { headers }), env),
  };
}

describe("message flags — star / archive / trash", () => {
  it("stars a message, exposes it in list/detail, and folder=starred filters it", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { get, post } = api(env);
    const star = await post("/mail/messages/mailin_1/star", h());
    expect(star.status).toBe(200);
    expect(await star.json()).toEqual({ id: "mailin_1", starred: true });

    const detail = (await (await get("/mail/messages/mailin_1", h())).json()) as MailMessageDetailX;
    expect(detail.starred).toBe(true);

    const starred = (await (await get("/mail/messages?folder=starred", h())).json()) as { items: MailMessageListItemX[] };
    expect(starred.items).toHaveLength(1);
    expect(starred.items[0]!.starred).toBe(true);

    const unstar = await post("/mail/messages/mailin_1/unstar", h());
    expect(await unstar.json()).toEqual({ id: "mailin_1", starred: false });
    const empty = (await (await get("/mail/messages?folder=starred", h())).json()) as { items: unknown[] };
    expect(empty.items).toHaveLength(0);
  });

  it("archive removes from the inbox folder and appears under folder=archived", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { get, post } = api(env);
    await post("/mail/messages/mailin_1/archive", h());
    const inbox = (await (await get("/mail/messages", h())).json()) as { items: unknown[] };
    expect(inbox.items).toHaveLength(0);
    const archived = (await (await get("/mail/messages?folder=archived", h())).json()) as { items: unknown[] };
    expect(archived.items).toHaveLength(1);
    await post("/mail/messages/mailin_1/unarchive", h());
    const back = (await (await get("/mail/messages", h())).json()) as { items: unknown[] };
    expect(back.items).toHaveLength(1);
  });

  it("trash hides from inbox, shows under folder=trash, and untrash restores", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { get, post } = api(env);
    await post("/mail/messages/mailin_1/trash", h());
    expect(((await (await get("/mail/messages", h())).json()) as { items: unknown[] }).items).toHaveLength(0);
    expect(((await (await get("/mail/messages?folder=trash", h())).json()) as { items: unknown[] }).items).toHaveLength(1);
    await post("/mail/messages/mailin_1/untrash", h());
    expect(((await (await get("/mail/messages", h())).json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("404s an unknown id and 401s without a trusted user", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { post } = api(env);
    expect((await post("/mail/messages/nope/star", h())).status).toBe(404);
    expect((await post("/mail/messages/mailin_1/star", { "content-type": "application/json" })).status).toBe(401);
  });

  it("permanent DELETE removes the message (then 404)", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { get, del } = api(env);
    const res = await del("/mail/messages/mailin_1", h());
    expect(res.status).toBe(200);
    expect((await get("/mail/messages/mailin_1", h())).status).toBe(404);
  });

  it("mark unread flips read back to false", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { get, post } = api(env);
    await post("/mail/messages/mailin_1/read", h());
    expect(((await (await get("/mail/messages/mailin_1", h())).json()) as MailMessageDetailX).read).toBe(true);
    const un = await post("/mail/messages/mailin_1/unread", h());
    expect(await un.json()).toEqual({ id: "mailin_1", read: false });
    expect(((await (await get("/mail/messages/mailin_1", h())).json()) as MailMessageDetailX).read).toBe(false);
  });
});

describe("thread-level flags", () => {
  it("stars every message in a thread and reports the affected count", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw, { id: "mailin_a", messageId: "<a@x>", threadId: "thr_9", receivedAt: "2026-08-10T00:00:00.000Z" });
    seedInbound(raw, { id: "mailin_b", messageId: "<b@x>", threadId: "thr_9", receivedAt: "2026-08-10T01:00:00.000Z" });
    const { get, post } = api(env);
    const res = await post("/mail/threads/thr_9/star", h());
    expect(await res.json()).toEqual({ threadId: "thr_9", starred: true, affected: 2 });
    const starred = (await (await get("/mail/messages?folder=starred", h())).json()) as { items: unknown[] };
    expect(starred.items).toHaveLength(2);
  });
});

describe("labels", () => {
  it("creates, lists, applies to a message, filters by label, and removes", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { get, post, del } = api(env);
    const created = await post("/mail/labels", h(), { name: "Urgent", color: "#EA4335" });
    expect(created.status).toBe(201);
    const label = (await created.json()) as MailLabel;
    expect(label.name).toBe("Urgent");
    expect(label.color).toBe("#EA4335");

    const list = (await (await get("/mail/labels", h())).json()) as { items: MailLabel[] };
    expect(list.items).toHaveLength(1);

    const applied = await post("/mail/messages/mailin_1/labels", h(), { labelId: label.id });
    expect(applied.status).toBe(200);
    const detail = (await (await get("/mail/messages/mailin_1", h())).json()) as MailMessageDetailX;
    expect(detail.labels.map((l) => l.name)).toEqual(["Urgent"]);

    const filtered = (await (await get(`/mail/messages?label=${label.id}`, h())).json()) as { items: unknown[] };
    expect(filtered.items).toHaveLength(1);

    const removed = await del(`/mail/messages/mailin_1/labels/${label.id}`, h());
    expect(await removed.json()).toEqual({ id: "mailin_1", labelId: label.id, applied: false });
    const after = (await (await get("/mail/messages/mailin_1", h())).json()) as MailMessageDetailX;
    expect(after.labels).toHaveLength(0);
  });

  it("rejects a duplicate label name (409) and a bad color (400)", async () => {
    const { env } = makeEnv();
    const { post } = api(env);
    await post("/mail/labels", h(), { name: "Dup" });
    expect((await post("/mail/labels", h(), { name: "Dup" })).status).toBe(409);
    expect((await post("/mail/labels", h(), { name: "X", color: "notacolor" })).status).toBe(400);
  });

  it("applying an unknown label id 404s", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw);
    const { post } = api(env);
    expect((await post("/mail/messages/mailin_1/labels", h(), { labelId: "maillbl_missing" })).status).toBe(404);
  });

  it("label create/update/delete require mail:admin (403 when denied)", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const { post } = api(env);
    expect((await post("/mail/labels", h(), { name: "Nope" })).status).toBe(403);
  });
});

describe("drafts", () => {
  it("creates, lists, fetches, updates, and deletes a draft", async () => {
    const { env } = makeEnv();
    const { get, post, put, del } = api(env);
    const created = await post("/mail/drafts", h(), { to: [{ email: "b@x.com" }], subject: "WIP", textBody: "half" });
    expect(created.status).toBe(201);
    const draft = (await created.json()) as MailDraft;
    expect(draft.subject).toBe("WIP");

    const list = (await (await get("/mail/drafts", h())).json()) as { items: MailDraft[] };
    expect(list.items).toHaveLength(1);

    const updated = await put(`/mail/drafts/${draft.id}`, h(), { to: [{ email: "b@x.com" }], subject: "Ready", textBody: "done" });
    expect(((await updated.json()) as MailDraft).subject).toBe("Ready");

    expect((await del(`/mail/drafts/${draft.id}`, h())).status).toBe(200);
    expect((await get(`/mail/drafts/${draft.id}`, h())).status).toBe(404);
  });

  it("accepts a blank-shell draft (all fields optional)", async () => {
    const { env } = makeEnv();
    const { post } = api(env);
    const res = await post("/mail/drafts", h(), {});
    expect(res.status).toBe(201);
    const draft = (await res.json()) as MailDraft;
    expect(draft.to).toEqual([]);
    expect(draft.subject).toBe("");
  });

  it("requires mail:send (403 when denied)", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const { get } = api(env);
    expect((await get("/mail/drafts", h())).status).toBe(403);
  });
});

describe("reply / replyAll / forward", () => {
  it("reply sends (202) and emits mail.message.sent", async () => {
    const { env, raw, sends } = makeEnv();
    seedInbound(raw, { subject: "Question", from: "asker@x.com" });
    const { post } = api(env);
    const res = await post("/mail/messages/mailin_1/reply", h(), { textBody: "Here is the answer" });
    expect(res.status).toBe(202);
    expect(sends.notif).toHaveLength(1);
    expect(sends.notif[0]!.name).toBe("mail.message.sent");
  });

  it("forward sends (202) to the supplied recipients", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw, { subject: "FYI" });
    const { post } = api(env);
    const res = await post("/mail/messages/mailin_1/forward", h(), { to: [{ email: "team@x.com" }], textBody: "see below" });
    expect(res.status).toBe(202);
  });

  it("reply requires mail:send (403 when denied)", async () => {
    const { env, raw } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    seedInbound(raw);
    const { post } = api(env);
    expect((await post("/mail/messages/mailin_1/reply", h(), { textBody: "x" })).status).toBe(403);
  });

  it("reply 404s an unknown message", async () => {
    const { env } = makeEnv();
    const { post } = api(env);
    expect((await post("/mail/messages/nope/reply", h(), { textBody: "x" })).status).toBe(404);
  });
});

describe("sent folder", () => {
  it("lists messages sent through /outbox", async () => {
    const { env } = makeEnv();
    const { get, post } = api(env);
    const sent = await post("/mail/outbox", h(), { to: [{ email: "c@x.com" }], subject: "Hi", textBody: "yo" });
    expect(sent.status).toBe(202);
    const list = (await (await get("/mail/sent", h())).json()) as { items: SentMailListItem[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.subject).toBe("Hi");
    expect(list.items[0]!.status).toBe("sent");
  });
});

describe("search", () => {
  it("filters by free text and by from: / subject: operators", async () => {
    const { env, raw } = makeEnv();
    seedInbound(raw, { id: "mailin_1", messageId: "<1@x>", subject: "Invoice March", from: "billing@acme.com", bodyText: "please pay" });
    seedInbound(raw, { id: "mailin_2", messageId: "<2@x>", subject: "Lunch?", from: "friend@x.com", bodyText: "sushi" });
    const { get } = api(env);

    const invoice = (await (await get("/mail/messages?q=Invoice", h())).json()) as { items: MailMessageListItemX[] };
    expect(invoice.items.map((i) => i.id)).toEqual(["mailin_1"]);

    const fromAcme = (await (await get("/mail/messages?q=from:acme", h())).json()) as { items: MailMessageListItemX[] };
    expect(fromAcme.items.map((i) => i.id)).toEqual(["mailin_1"]);

    const body = (await (await get("/mail/messages?q=sushi", h())).json()) as { items: MailMessageListItemX[] };
    expect(body.items.map((i) => i.id)).toEqual(["mailin_2"]);
  });
});

describe("freeq D1 outbox", () => {
  it("a mutation enqueues an audit row that the drain publishes to AUDIT_QUEUE", async () => {
    const { env, raw, sends } = makeEnv();
    seedInbound(raw);
    const { post } = api(env);
    // star → state change now; audit is buffered in mail_outbox, not yet on the queue.
    await post("/mail/messages/mailin_1/star", h());
    expect(sends.audit).toHaveLength(0);
    const pending = raw.prepare(`SELECT COUNT(*) AS n FROM mail_outbox WHERE status = 'pending'`).get() as { n: number };
    expect(Number(pending.n)).toBe(1);

    // drain (internal-only) → publishes the buffered record to the existing AUDIT_QUEUE.
    const drain = await post("/internal/outbox/drain", { "content-type": "application/json", "x-dub-request-id": "req_d", "x-dub-internal": "1" });
    expect(drain.status).toBe(200);
    expect(await drain.json()).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(sends.audit).toHaveLength(1);
    expect(sends.audit[0]!.payload.action).toBe("mail.message.star");

    const done = raw.prepare(`SELECT COUNT(*) AS n FROM mail_outbox WHERE status = 'done'`).get() as { n: number };
    expect(Number(done.n)).toBe(1);
  });

  it("drain is internal-only (403 without x-dub-internal)", async () => {
    const { env } = makeEnv();
    const { post } = api(env);
    expect((await post("/internal/outbox/drain", { "content-type": "application/json" })).status).toBe(403);
  });
});
