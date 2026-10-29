// Sender block list (この送信者をブロック, 0021): API, validation, query-time marking and the
// ingest behaviour (stored, never dropped; no mail.message.received for a blocked sender).
import { describe, it, expect } from "vitest";
import { createDbClient } from "@dub/db";
import { mail } from "@dub/types";
import { createApp } from "../src/app";
import { blockMatcher, parseBlockRequest } from "../src/blocks";
import { handleInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { ctx, fakeIdentityFetcher, makeEnv, recordingQueue } from "./helpers";
import type { DubEventEnvelope } from "@dub/events";

const app = createApp();
const USERS = {
  usr_info: { email: "info@developershub.jp" },
  usr_alice: { email: "alice@developershub.jp" },
};
const asUser = (userId: string) => ({ "content-type": "application/json", "x-dub-request-id": "req_block", "x-dub-user-id": userId });

function env() {
  return makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, USERS) });
}

function raw(from: string, id: string, to = "info@developershub.jp"): RawInbound {
  return {
    from,
    to,
    headers: { "message-id": `<${id}@x>`, from, to, subject: `subject ${id}`, date: "Sat, 09 Aug 2026 05:00:00 +0000" },
    rawText: `Message-ID: <${id}@x>\r\nSubject: s\r\n\r\nbody ${id}`,
    rawSize: 128,
  };
}

async function ingest(e: ReturnType<typeof env>["env"], r: RawInbound) {
  const mailAuto = recordingQueue<DubEventEnvelope>();
  const notif = recordingQueue<DubEventEnvelope>();
  const audit = recordingQueue<never>();
  const out = await handleInbound(
    {
      db: createDbClient(e.DB, { namespace: "mail" }),
      events: { EVT_MAIL_AUTOMATION: mailAuto.queue, EVT_NOTIFICATION: notif.queue },
      audit: { AUDIT_QUEUE: audit.queue as never },
      orgId: "org_devhub",
      ctx: ctx("req_in"),
      identity: fakeIdentityFetcher(true, USERS),
      archiveAddress: "archive@developershub.jp",
      sharedAddress: "info@developershub.jp",
    },
    r,
  );
  return { out, mailAuto: mailAuto.sends };
}

const post = (e: ReturnType<typeof env>["env"], user: string, body: unknown) =>
  app.fetch(new Request("https://svc/mail/blocks", { method: "POST", headers: asUser(user), body: JSON.stringify(body) }), e);
const del = (e: ReturnType<typeof env>["env"], user: string, value: string) =>
  app.fetch(new Request(`https://svc/mail/blocks/${encodeURIComponent(value)}`, { method: "DELETE", headers: asUser(user) }), e);
const list = async (e: ReturnType<typeof env>["env"], user: string) =>
  ((await (await app.fetch(new Request("https://svc/mail/blocks", { headers: asUser(user) }), e)).json()) as { items: mail.MailSenderBlock[] }).items;
const inbox = async (e: ReturnType<typeof env>["env"], user: string) =>
  ((await (await app.fetch(new Request("https://svc/mail/messages", { headers: asUser(user) }), e)).json()) as { items: mail.MailMessageListItem[] }).items;

describe("parseBlockRequest (validation + normalization)", () => {
  it("lowercases and infers kind from the value", () => {
    expect(parseBlockRequest({ value: "  Spam@Example.COM " })).toEqual({ value: "spam@example.com", kind: "address" });
    expect(parseBlockRequest({ value: "Example.com" })).toEqual({ value: "example.com", kind: "domain" });
    expect(parseBlockRequest({ value: "@example.com" })).toEqual({ value: "example.com", kind: "domain" });
  });

  it("a domain block given a full address blocks that address's domain", () => {
    expect(parseBlockRequest({ value: "a@Spam.example", kind: "domain" })).toEqual({ value: "spam.example", kind: "domain" });
  });

  it("rejects malformed input (400)", () => {
    for (const body of [null, "x", {}, { value: "" }, { value: "not an email", kind: "address" }, { value: "no_tld" }, { value: "a@b.c", kind: "bogus" }]) {
      expect(() => parseBlockRequest(body)).toThrow();
    }
  });
});

describe("blockMatcher", () => {
  it("matches an exact address, a domain and its subdomains — case-insensitively", () => {
    const m = blockMatcher([
      { value: "bad@ok.example", kind: "address" },
      { value: "spam.example", kind: "domain" },
    ]);
    expect(m.matches("BAD@ok.example")).toBe(true);
    expect(m.matches("good@ok.example")).toBe(false);
    expect(m.matches("x@spam.example")).toBe(true);
    expect(m.matches("x@mail.spam.example")).toBe(true);
    expect(m.matches("x@notspam.example")).toBe(false);
    expect(m.matches(undefined)).toBe(false);
  });
});

describe("/mail/blocks API", () => {
  it("block → list → unblock round trip, idempotent create, audited", async () => {
    const { env: e, sends } = env();
    const first = await post(e, "usr_alice", { value: "Spam@Example.com" });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ value: "spam@example.com", kind: "address" });
    expect((await post(e, "usr_alice", { value: "spam@example.com" })).status).toBe(200); // already blocked
    expect((await list(e, "usr_alice")).map((b) => b.value)).toEqual(["spam@example.com"]);

    const un = await del(e, "usr_alice", "SPAM@example.com");
    expect(un.status).toBe(200);
    expect(await list(e, "usr_alice")).toEqual([]);
    expect((await del(e, "usr_alice", "spam@example.com")).status).toBe(404);
    // Re-block after unblock revives the (soft-deleted) row.
    expect((await post(e, "usr_alice", { value: "spam@example.com" })).status).toBe(201);
    expect(await list(e, "usr_alice")).toHaveLength(1);

    const audited = JSON.stringify(sends.audit);
    expect(audited.match(/mail\.sender_block\.create/g)).toHaveLength(3);
    expect(audited.match(/mail\.sender_block\.delete/g)).toHaveLength(2); // incl. the failed (404) one
    expect(audited).toContain('"failure"');
  });

  it("unblock never physically deletes the row (soft delete)", async () => {
    const { env: e, raw: db } = env();
    await post(e, "usr_alice", { value: "x@example.com" });
    await del(e, "usr_alice", "x@example.com");
    const rows = db.prepare(`SELECT value, deleted_at FROM mail_sender_blocks`).all() as { value: string; deleted_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it("is per mailbox owner: one account's block list never touches another's", async () => {
    const { env: e } = env();
    await post(e, "usr_alice", { value: "spam@example.com" });
    expect(await list(e, "usr_info")).toEqual([]);
    expect((await del(e, "usr_info", "spam@example.com")).status).toBe(404);
    expect(await list(e, "usr_alice")).toHaveLength(1);
  });

  it("rejects blocking your own address and the organization domain", async () => {
    const { env: e } = env();
    expect((await post(e, "usr_alice", { value: "Alice@developershub.jp" })).status).toBe(400);
    expect((await post(e, "usr_alice", { value: "developershub.jp" })).status).toBe(400);
    expect((await post(e, "usr_alice", { value: "x@developershub.jp", kind: "domain" })).status).toBe(400);
    expect((await post(e, "usr_alice", { value: "sub.developershub.jp" })).status).toBe(400);
    // A colleague's single address is allowed (only domain-wide is refused).
    expect((await post(e, "usr_alice", { value: "bob@developershub.jp" })).status).toBe(201);
    expect((await post(e, "usr_alice", { value: "not-an-address", kind: "address" })).status).toBe(400);
  });

  it("caps the list size (409 beyond the limit)", async () => {
    const { env: e, raw: db } = env();
    const ins = db.prepare(`INSERT INTO mail_sender_blocks (owner_user_id, value, kind, created_at) VALUES ('usr_alice', ?, 'domain', '2026-01-01T00:00:00.000Z')`);
    for (let i = 0; i < mail.MAIL_SENDER_BLOCK_LIMIT; i++) ins.run(`d${i}.example`);
    const res = await post(e, "usr_alice", { value: "one-more.example" });
    expect(res.status).toBe(409);
    // Re-posting an already-blocked value is still fine at the cap (idempotent).
    expect((await post(e, "usr_alice", { value: "d0.example" })).status).toBe(200);
  });
});

describe("blocked senders on read + ingest", () => {
  it("ingest from a blocked sender is STORED, flagged blocked, and publishes no mail.message.received", async () => {
    const { env: e, raw: db } = env();
    await post(e, "usr_info", { value: "spam@outside.com" });

    const blocked = await ingest(e, raw("spam@outside.com", "b1"));
    expect(blocked.out.processed).toBe(true);
    expect(blocked.mailAuto).toHaveLength(0); // no auto-reply / notification pipeline
    const ok = await ingest(e, raw("friend@outside.com", "ok1"));
    expect(ok.mailAuto).toHaveLength(1);

    // Never dropped: both rows exist.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM mail_inbound`).get() as { n: number }).n).toBe(2);
    const items = await inbox(e, "usr_info");
    const bySubject = Object.fromEntries(items.map((m) => [m.subject, m.blocked === true]));
    expect(bySubject).toEqual({ "subject b1": true, "subject ok1": false });
  });

  it("domain block flags existing mail; unblocking restores it (query-time, not stamped)", async () => {
    const { env: e } = env();
    await ingest(e, raw("a@spam.example", "d1"));
    await ingest(e, raw("b@mail.spam.example", "d2"));
    await ingest(e, raw("c@fine.example", "d3"));
    expect((await inbox(e, "usr_info")).filter((m) => m.blocked)).toHaveLength(0);

    await post(e, "usr_info", { value: "spam.example", kind: "domain" });
    expect((await inbox(e, "usr_info")).filter((m) => m.blocked).map((m) => m.subject).sort()).toEqual(["subject d1", "subject d2"]);

    // Thread + detail reads carry the same flag.
    const first = (await inbox(e, "usr_info")).find((m) => m.subject === "subject d1")!;
    const detail = (await (await app.fetch(new Request(`https://svc/mail/messages/${first.id}`, { headers: asUser("usr_info") }), e)).json()) as mail.MailMessageDetail;
    expect(detail.blocked).toBe(true);
    const thread = (await (await app.fetch(new Request(`https://svc/mail/threads/${encodeURIComponent(first.threadId)}`, { headers: asUser("usr_info") }), e)).json()) as mail.MailThread;
    expect(thread.messages[0]!.blocked).toBe(true);

    await del(e, "usr_info", "spam.example");
    expect((await inbox(e, "usr_info")).filter((m) => m.blocked)).toHaveLength(0);
  });
});
