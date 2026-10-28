// Per-recipient inbound storage (0018 mail_inbound_delivery) + outbound Bcc. Pins the fix for
// "CC'd colleagues never receive the mail": one body row per Message-ID, one delivery per
// envelope recipient, per-recipient read state, backfill of pre-0018 rows, real Bcc.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { handleInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { getInboundDetail, getSentDetail, listInbound, listSent, listThread, markInboundRead } from "../src/repo";
import { sendMail } from "../src/send";
import { parseScheduleMailRequest, parseSendMailRequest } from "../src/validation";
import { fakeIdentityFetcher, inboundDeps, makeHarness, sendDeps } from "./helpers";

const A = "alice@developershub.jp";
const B = "bob@developershub.jp";
const ROSTER = { usr_alice: { email: A }, usr_bob: { email: B }, usr_info: { email: "info@developershub.jp" } };

function copyFor(envelope: string, headers: Record<string, string> = {}): RawInbound {
  return {
    from: "x@partner.example",
    to: envelope,
    headers: {
      "message-id": "<multi-1@partner.example>",
      from: "Xavier <x@partner.example>",
      to: A,
      cc: B,
      subject: "Proposal",
      date: "Tue, 27 Oct 2026 01:00:00 +0000",
      ...headers,
    },
    rawText: "Subject: Proposal\r\n\r\nHello both.",
    rawSize: 256,
  };
}

async function deliverToAandB() {
  const h = makeHarness();
  const deps = inboundDeps(h, { identity: fakeIdentityFetcher(true, ROSTER) });
  const first = await handleInbound(deps, copyFor(A));
  const second = await handleInbound(deps, copyFor(B));
  return { h, deps, first, second };
}

describe("inbound: one delivery per internal recipient", () => {
  it("To=A + Cc=B: both see it once, one body row, two deliveries, one event", async () => {
    const { h, first, second } = await deliverToAandB();
    expect(first.processed).toBe(true);
    expect(second.processed).toBe(false);
    expect(second.message.id).toBe(first.message.id);

    expect((h.raw.prepare(`SELECT COUNT(*) AS c FROM mail_inbound`).get() as { c: number }).c).toBe(1);
    const dlv = h.raw.prepare(`SELECT owner_user_id, envelope_to FROM mail_inbound_delivery ORDER BY envelope_to`).all();
    expect(dlv).toEqual([
      { owner_user_id: "usr_alice", envelope_to: A },
      { owner_user_id: "usr_bob", envelope_to: B },
    ]);
    expect(h.mailAuto.sends).toHaveLength(1); // mail.message.received only for the first copy

    for (const uid of ["usr_alice", "usr_bob"]) {
      const page = await listInbound(h.db, { ownerUserId: uid, viewer: uid, limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.mine).toBe(true);
      const thread = await listThread(h.db, page.items[0]!.threadId, uid, uid);
      expect(thread).toHaveLength(1);
    }
    // A non-recipient still sees nothing (fail-closed).
    expect((await listInbound(h.db, { ownerUserId: "usr_info", limit: 10 })).items).toHaveLength(0);
  });

  it("a redelivery of the same copies adds nothing", async () => {
    const { h, deps } = await deliverToAandB();
    await handleInbound(deps, copyFor(A));
    await handleInbound(deps, copyFor(B));
    expect((h.raw.prepare(`SELECT COUNT(*) AS c FROM mail_inbound_delivery`).get() as { c: number }).c).toBe(2);
    expect((await listInbound(h.db, { ownerUserId: "usr_bob", limit: 10 })).items).toHaveLength(1);
  });

  it("the archive@ copy is an ownerless oversight delivery and does not block later recipients", async () => {
    const h = makeHarness();
    const deps = inboundDeps(h, { identity: fakeIdentityFetcher(true, { ...ROSTER, usr_archive: { email: "archive@developershub.jp" } }) });
    await handleInbound(deps, copyFor("archive@developershub.jp"));
    await handleInbound(deps, copyFor(B));
    const dlv = h.raw.prepare(`SELECT owner_user_id, envelope_to FROM mail_inbound_delivery ORDER BY envelope_to`).all();
    expect(dlv).toEqual([
      { owner_user_id: null, envelope_to: "archive@developershub.jp" },
      { owner_user_id: "usr_bob", envelope_to: B },
    ]);
    expect((await listInbound(h.db, { ownerUserId: "usr_bob", limit: 10 })).items).toHaveLength(1);
    expect((await listInbound(h.db, { ownerUserId: "usr_archive", limit: 10 })).items).toHaveLength(0);
    expect((await listInbound(h.db, { ownerUserId: { readAll: true }, limit: 10 })).items).toHaveLength(1);
  });

  it("shows each recipient the address their own copy was delivered to", async () => {
    const { h, first } = await deliverToAandB();
    const forBob = await getInboundDetail(h.db, first.message.id, "usr_bob", "usr_bob");
    expect(forBob?.headerMeta?.deliveredTo).toBe(B);
    const forAlice = await getInboundDetail(h.db, first.message.id, "usr_alice", "usr_alice");
    expect(forAlice?.headerMeta?.deliveredTo).toBe(A);
  });
});

describe("inbound: read state is per recipient", () => {
  it("A reading it leaves B unread; oversight readers stay view-only", async () => {
    const { h, first } = await deliverToAandB();
    const id = first.message.id;
    const readOf = async (uid: string) => (await listInbound(h.db, { ownerUserId: uid, viewer: uid, limit: 10 })).items[0]!.read;

    expect(await readOf("usr_alice")).toBe(false);
    expect(await readOf("usr_bob")).toBe(false);

    expect(await markInboundRead(h.db, id, "usr_alice", "usr_alice")).toEqual({ found: true });
    expect(await readOf("usr_alice")).toBe(true);
    expect(await readOf("usr_bob")).toBe(false);

    // A read_all supervisor opening it flips nobody's state.
    expect(await markInboundRead(h.db, id, { readAll: true }, "usr_info")).toEqual({ found: true });
    expect(await readOf("usr_bob")).toBe(false);

    // A non-recipient without oversight cannot even find it.
    expect(await markInboundRead(h.db, id, "usr_info", "usr_info")).toEqual({ found: false });

    expect(await markInboundRead(h.db, id, "usr_bob", "usr_bob")).toEqual({ found: true });
    expect(await readOf("usr_bob")).toBe(true);
  });
});

describe("0018 backfill", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(HERE, "../db/0018_inbound_delivery.sql"), "utf8");
  // The backfill statement exactly as shipped (comments stripped, split like the runner).
  const backfill = migration
    .split(";")
    .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
    .find((s) => s.startsWith("INSERT OR IGNORE INTO mail_inbound_delivery"))!;

  it("turns every pre-0018 owned row into its owner's delivery (read state kept)", async () => {
    const h = makeHarness();
    const insert = h.raw.prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at, owner_user_id, read_at, header_meta_json)
       VALUES (?, ?, ?, '{"email":"x@partner.example"}', '[]', 's', 's', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?, ?, ?)`,
    );
    insert.run("in_old_read", "old1@x", "old1@x", "usr_alice", "2026-10-02T00:00:00.000Z", JSON.stringify({ deliveredTo: "Alice@DevelopersHub.jp" }));
    insert.run("in_old_unread", "old2@x", "old2@x", "usr_alice", null, null);
    insert.run("in_old_orphan", "old3@x", "old3@x", null, null, null);
    insert.run("in_old_badjson", "old4@x", "old4@x", "usr_bob", null, "{not json");

    expect(backfill).toBeDefined();
    h.raw.exec(backfill);
    h.raw.exec(backfill); // idempotent

    const rows = h.raw.prepare(`SELECT inbound_id, owner_user_id, envelope_to, read_at FROM mail_inbound_delivery ORDER BY inbound_id`).all();
    expect(rows).toEqual([
      { inbound_id: "in_old_badjson", owner_user_id: "usr_bob", envelope_to: "", read_at: null },
      { inbound_id: "in_old_read", owner_user_id: "usr_alice", envelope_to: A, read_at: "2026-10-02T00:00:00.000Z" },
      { inbound_id: "in_old_unread", owner_user_id: "usr_alice", envelope_to: "", read_at: null },
    ]);

    const alice = await listInbound(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", limit: 10 });
    expect(alice.items.map((m) => [m.id, m.read, m.mine])).toEqual([
      ["in_old_unread", false, true],
      ["in_old_read", true, true],
    ]);
    expect((await listInbound(h.db, { ownerUserId: "usr_bob", limit: 10 })).items.map((m) => m.id)).toEqual(["in_old_badjson"]);
  });

  it("a legacy owned row without any delivery stays visible to its owner", async () => {
    const h = makeHarness();
    h.raw
      .prepare(
        `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at, owner_user_id)
         VALUES ('in_legacy', 'l@x', 'l@x', '{"email":"x@partner.example"}', '[]', 's', 's', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'usr_alice')`,
      )
      .run();
    expect((await listInbound(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", limit: 10 })).items[0]?.mine).toBe(true);
  });
});

describe("outbound Bcc", () => {
  it("validates bcc like cc and rejects it on a scheduled send", () => {
    const base = { to: [{ email: "x@partner.example" }], subject: "s", textBody: "b" };
    expect(parseSendMailRequest({ ...base, bcc: [{ email: B }] }).bcc).toEqual([{ email: B }]);
    expect(() => parseSendMailRequest({ ...base, bcc: [{ email: "not-an-email" }] })).toThrow();
    const many = Array.from({ length: 101 }, (_, i) => ({ email: `u${i}@x.example` }));
    expect(() => parseSendMailRequest({ ...base, bcc: many })).toThrow();
    expect(() =>
      parseScheduleMailRequest({ ...base, bcc: [{ email: B }], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ).toThrow();
  });

  it("delivers Bcc on the envelope only, never in headers, and shows it in Sent to the sender only", async () => {
    const h = makeHarness();
    const deps = sendDeps(h, { archiveCc: "archive@developershub.jp" });
    const { response } = await sendMail(
      deps,
      { to: [{ email: "x@partner.example" }], bcc: [{ email: B }], subject: "Secret", textBody: "hi" },
      "idem-bcc-1",
      "usr_alice",
    );
    const out = h.provider.sent[0]!;
    expect(out.bcc?.map((a) => a.email)).toEqual([B, "archive@developershub.jp"]);
    expect(out.cc.map((a) => a.email)).not.toContain(B);
    const head = out.mime.slice(0, out.mime.search(/\r?\n\r?\n/)).toLowerCase();
    expect(head).not.toMatch(/^bcc:/m);
    expect(head).not.toContain(B);

    const id = response.messageId.split("@")[0]!;
    expect((await getSentDetail(h.db, id, "usr_alice", "usr_alice"))?.bcc).toEqual([{ email: B }]);
    expect((await listSent(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", limit: 10 })).items[0]?.bcc).toEqual([{ email: B }]);
    // Oversight can open the send but never learns who was Bcc'd.
    expect((await getSentDetail(h.db, id, { readAll: true }, "usr_info"))?.bcc).toBeUndefined();
    expect((await listSent(h.db, { ownerUserId: { readAll: true }, viewer: "usr_info", limit: 10 })).items[0]?.bcc).toBeUndefined();
  });
});
