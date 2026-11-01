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
