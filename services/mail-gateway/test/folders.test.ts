// Folder views (GET /mail/messages?folder=, GET /mail/counts): blocked senders and the
// viewer's flags are applied in SQL BEFORE the limit, so every page is full.
import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const app = createApp();
const ME = "usr_me";
const hdr = (userId = ME) => ({ "content-type": "application/json", "x-dub-request-id": "req_folder", "x-dub-user-id": userId });

type Raw = ReturnType<typeof makeEnv>["raw"];

function env() {
  return makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, { [ME]: { email: "me@developershub.jp" } }) });
}

let seq = 0;
/** Insert one inbound message owned by `owner` (ids grow, so newest = highest id). */
function addMail(raw: Raw, o: { from: string; thread?: string; owner?: string; read?: boolean; subject?: string }): string {
  seq += 1;
  const id = `mailin_${String(seq).padStart(6, "0")}`;
  const at = new Date(Date.UTC(2026, 0, 1) + seq * 60_000).toISOString();
  raw
    .prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at, owner_user_id, read_at)
       VALUES (?, ?, ?, ?, '[{"email":"me@developershub.jp"}]', ?, 'snip', ?, ?, ?, ?)`,
    )
    .run(id, `m_${id}`, o.thread ?? `thr_${id}`, JSON.stringify({ email: o.from }), o.subject ?? `subject ${id}`, at, at, o.owner ?? ME, o.read ? at : null);
  return id;
}

async function page(e: ReturnType<typeof env>["env"], folder: string, cursor?: string, extra = "") {
  const qs = `folder=${folder}&limit=50${cursor ? `&cursor=${cursor}` : ""}${extra}`;
  const res = await app.fetch(new Request(`https://svc/mail/messages?${qs}`, { headers: hdr() }), e);
  expect(res.status).toBe(200);
  const body = (await res.json()) as mail.MailMessagePage;
  return { ...body, threads: [...new Set(body.items.map((m) => m.threadId))] };
}

async function block(e: ReturnType<typeof env>["env"], value: string, kind?: "domain") {
  const res = await app.fetch(new Request("https://svc/mail/blocks", { method: "POST", headers: hdr(), body: JSON.stringify(kind ? { value, kind } : { value }) }), e);
  expect(res.status).toBe(201);
}

/** 200 conversations; blocked senders interleaved: every 3rd from *.spam.example (domain
 *  block, exact domain + subdomain), every 7th from bad@x.example (address block). */
function seedInterleaved(raw: Raw): { blocked: number; clean: number } {
  let blocked = 0;
  for (let i = 0; i < 200; i++) {
    if (i % 3 === 0) {
      addMail(raw, { from: i % 2 === 0 ? `n${i}@spam.example` : `n${i}@mail.spam.example` });
      blocked++;
    } else if (i % 7 === 0) {
      addMail(raw, { from: "Bad@X.example" });
      blocked++;
    } else {
      addMail(raw, { from: `friend${i}@ok.example`, read: i % 2 === 0 });
    }
  }
  return { blocked, clean: 200 - blocked };
}

describe("GET /mail/messages?folder= (conversation paging, blocked excluded before LIMIT)", () => {
  it("pages 1 and 2 of 受信トレイ are both full (50) with no blocked sender; totals are exact", async () => {
    const { env: e, raw } = env();
    const { blocked, clean } = seedInterleaved(raw);
    await block(e, "spam.example", "domain");
    await block(e, "bad@x.example");

    const p1 = await page(e, "inbox");
    expect(p1.threads).toHaveLength(50);
    expect(p1.total).toBe(clean);
    expect(p1.items.every((m) => !m.blocked && !/spam\.example|x\.example/.test(m.from.email.toLowerCase()))).toBe(true);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await page(e, "inbox", p1.nextCursor!);
    expect(p2.threads).toHaveLength(50);
    expect(p2.threads.some((t) => p1.threads.includes(t))).toBe(false);
    // Newest first across the page boundary.
    expect(p1.items.at(-1)!.id > p2.items[0]!.id).toBe(true);

    // Walk to the end: every conversation exactly once, last page partial.
    const seen = new Set([...p1.threads, ...p2.threads]);
    let cur = p2.nextCursor;
    let lastSize = 50;
    while (cur) {
      const p = await page(e, "inbox", cur);
      p.threads.forEach((t) => seen.add(t));
      lastSize = p.threads.length;
      cur = p.nextCursor;
    }
    expect(seen.size).toBe(clean);
    expect(lastSize).toBe(clean % 50 || 50);

    // ブロック済み: only blocked conversations, paged the same way.
    const b1 = await page(e, "blocked");
    expect(b1.total).toBe(blocked);
    expect(b1.threads).toHaveLength(50);
    expect(b1.items.every((m) => m.blocked === true)).toBe(true);
  });

  it("unblocking restores the full inbox (read-only: nothing was stamped)", async () => {
    const { env: e, raw } = env();
    seedInterleaved(raw);
    await block(e, "spam.example", "domain");
    expect((await page(e, "inbox")).total).toBeLessThan(200);
    await app.fetch(new Request("https://svc/mail/blocks/spam.example", { method: "DELETE", headers: hdr() }), e);
    await app.fetch(new Request("https://svc/mail/blocks/bad%40x.example", { method: "DELETE", headers: hdr() }), e);
    expect((await page(e, "inbox")).total).toBe(200);
    expect((await page(e, "blocked")).total).toBe(0);
  });

  it("a mixed conversation (blocked + unblocked sender) stays in the inbox with all its messages", async () => {
    const { env: e, raw } = env();
    addMail(raw, { from: "a@spam.example", thread: "thr_mix" });
    addMail(raw, { from: "friend@ok.example", thread: "thr_mix" });
    addMail(raw, { from: "b@spam.example", thread: "thr_only_spam" });
    await block(e, "spam.example", "domain");
    const p = await page(e, "inbox");
    expect(p.threads).toEqual(["thr_mix"]);
    expect(p.items).toHaveLength(2);
    expect((await page(e, "blocked")).threads).toEqual(["thr_only_spam"]);
  });

  it("applies the viewer's flags before LIMIT: archive / trash / star / purge views are full too", async () => {
    const { env: e, raw } = env();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(addMail(raw, { from: `p${i}@ok.example` }));
    const flag = (i: number, body: Record<string, boolean>) =>
      app.fetch(new Request(`https://svc/mail/flags/thr_${ids[i]}`, { method: "POST", headers: hdr(), body: JSON.stringify(body) }), e);
    // Interleave: every 2nd archived, every 5th trashed, every 11th purged, every 3rd starred.
    let archived = 0;
    let trashed = 0;
    let purged = 0;
    for (let i = 0; i < 120; i++) {
      if (i % 11 === 0) {
        await flag(i, { purged: true, trashed: true });
        purged++;
      } else if (i % 5 === 0) {
        await flag(i, { trashed: true });
        trashed++;
      } else if (i % 2 === 0) {
        await flag(i, { archived: true });
        archived++;
      }
      if (i % 3 === 0 && i % 11 !== 0 && i % 5 !== 0) await flag(i, { starred: true });
    }
    const inboxTotal = 120 - archived - trashed - purged;
    const inbox = await page(e, "inbox");
    expect(inbox.total).toBe(inboxTotal);
    expect(inbox.threads).toHaveLength(Math.min(50, inboxTotal));
    expect((await page(e, "trash")).total).toBe(trashed);
    expect((await page(e, "archive")).total).toBe(archived);
    const all = await page(e, "all");
    expect(all.total).toBe(inboxTotal + archived);
    expect(all.threads).toHaveLength(50);
  });

  it("mine / others split by delivery, and search (folder=all&q=) excludes blocked before LIMIT", async () => {
    const { env: e, raw } = env();
    for (let i = 0; i < 60; i++) addMail(raw, { from: i % 2 ? "x@spam.example" : `f${i}@ok.example`, subject: `report ${i}` });
    for (let i = 0; i < 3; i++) addMail(raw, { from: `peer${i}@ok.example`, owner: "usr_peer" });
    await block(e, "spam.example", "domain");
    expect((await page(e, "mine")).total).toBe(30);
    expect((await page(e, "others")).total).toBe(0); // peers' mail is outside my scope here
    const s = await page(e, "all", undefined, "&q=report");
    expect(s.total).toBe(30);
    expect(s.items.every((m) => !m.blocked)).toBe(true);
  });

  it("rejects an unknown folder (400); no folder keeps the legacy message list", async () => {
    const { env: e, raw } = env();
    addMail(raw, { from: "x@spam.example" });
    await block(e, "spam.example", "domain");
    const bad = await app.fetch(new Request("https://svc/mail/messages?folder=nope", { headers: hdr() }), e);
    expect(bad.status).toBe(400);
    const legacy = (await (await app.fetch(new Request("https://svc/mail/messages", { headers: hdr() }), e)).json()) as mail.MailMessagePage;
    expect(legacy.items).toHaveLength(1);
    expect(legacy.items[0]!.blocked).toBe(true);
    expect(legacy.total).toBeUndefined();
  });
});

describe("GET /mail/counts", () => {
  it("counts conversations + unread per view; blocked mail never counts as unread", async () => {
    const { env: e, raw } = env();
    seedInterleaved(raw);
    await block(e, "spam.example", "domain");
    await block(e, "bad@x.example");
    const res = await app.fetch(new Request("https://svc/mail/counts", { headers: hdr() }), e);
    expect(res.status).toBe(200);
    const c = (await res.json()) as mail.MailFolderCounts;
    const inbox = await page(e, "inbox");
    expect(c.inbox.total).toBe(inbox.total);
    // Clean mail is unread on odd i only.
    let unread = 0;
    for (let i = 0; i < 200; i++) if (i % 3 !== 0 && i % 7 !== 0 && i % 2 !== 0) unread++;
    expect(c.inbox.unread).toBe(unread);
    expect(c.mine).toEqual(c.inbox);
    expect(c.blocked.total).toBe(200 - inbox.total!);
    expect(c.blocked.unread).toBe(0);
  });
});

describe("POST /mail/read-all", () => {
  const readAll = (e: ReturnType<typeof env>["env"], folder: unknown, userId = ME) =>
    app.fetch(new Request("https://svc/mail/read-all", { method: "POST", headers: hdr(userId), body: JSON.stringify({ folder }) }), e);
  const counts = async (e: ReturnType<typeof env>["env"]) =>
    (await (await app.fetch(new Request("https://svc/mail/counts", { headers: hdr() }), e)).json()) as mail.MailFolderCounts;
  const flag = (e: ReturnType<typeof env>["env"], thread: string, body: object) =>
    app.fetch(new Request(`https://svc/mail/flags/${thread}`, { method: "POST", headers: hdr(), body: JSON.stringify(body) }), e);

  it("clears every page of the view, and a thread's older unread messages with it", async () => {
    const { env: e, raw } = env();
    for (let i = 0; i < 120; i++) addMail(raw, { from: `friend${i}@ok.example` });
    addMail(raw, { from: "a@ok.example", thread: "thr_multi" });
    addMail(raw, { from: "b@ok.example", thread: "thr_multi" });
    expect((await counts(e)).inbox.unread).toBe(121);
    const res = await readAll(e, "inbox");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 122 });
    expect((await counts(e)).inbox.unread).toBe(0);
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM mail_inbound WHERE read_at IS NULL`).get() as { n: number }).n).toBe(0);
  });

  it("stays inside the view: archived, trashed and blocked mail keep their unread state", async () => {
    const { env: e, raw } = env();
    addMail(raw, { from: "in@ok.example" });
    const archived = addMail(raw, { from: "arc@ok.example" });
    const trashed = addMail(raw, { from: "trash@ok.example" });
    const blocked = addMail(raw, { from: "bad@x.example" });
    await flag(e, `thr_${archived}`, { archived: true });
    await flag(e, `thr_${trashed}`, { trashed: true });
    await block(e, "bad@x.example");
    await readAll(e, "inbox");
    const unread = raw.prepare(`SELECT id FROM mail_inbound WHERE read_at IS NULL ORDER BY id`).all() as { id: string }[];
    expect(unread.map((r) => r.id)).toEqual([archived, trashed, blocked]);
  });

  it("stamps only the caller's copies: a co-recipient's delivery and another account's mail stay unread", async () => {
    const { env: e, raw } = env();
    const shared = addMail(raw, { from: "a@ok.example" });
    const theirs = addMail(raw, { from: "b@ok.example", owner: "usr_other" });
    const delivery = raw.prepare(
      `INSERT INTO mail_inbound_delivery (id, inbound_id, owner_user_id, envelope_to, read_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 't', 't')`,
    );
    delivery.run("d_me", shared, ME, "me@developershub.jp");
    delivery.run("d_other", shared, "usr_other", "other@developershub.jp");
    await readAll(e, "inbox");
    const readAt = (id: string) => (raw.prepare(`SELECT read_at FROM mail_inbound_delivery WHERE id = ?`).get(id) as { read_at: string | null }).read_at;
    expect(readAt("d_me")).not.toBeNull();
    expect(readAt("d_other")).toBeNull();
    // The legacy per-message stamp moves with the delivery, or read_all viewers keep seeing it unread.
    expect((raw.prepare(`SELECT read_at FROM mail_inbound WHERE id = ?`).get(shared) as { read_at: string | null }).read_at).not.toBeNull();
    expect((raw.prepare(`SELECT read_at FROM mail_inbound WHERE id = ?`).get(theirs) as { read_at: string | null }).read_at).toBeNull();
  });

  it("rejects an unknown folder", async () => {
    const { env: e } = env();
    expect((await readAll(e, "nope")).status).toBe(400);
    expect((await readAll(e, undefined)).status).toBe(400);
  });
});
