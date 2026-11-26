// List filters (#899) on GET /mail/messages (folder view + legacy) and GET /mail/sent:
// each filter narrows, filters combine (AND), bad input is a 400, and every new probe runs
// on an index (EXPLAIN QUERY PLAN never shows a SCAN of the probed tables).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const app = createApp();
const ME = "usr_me";
const hdr = { "content-type": "application/json", "x-dub-request-id": "req_filter", "x-dub-user-id": ME };
const HERE = dirname(fileURLToPath(import.meta.url));

type Raw = ReturnType<typeof makeEnv>["raw"];

function env() {
  const made = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, { [ME]: { email: "me@developershub.jp" } }) });
  // The Sent indexes from 0028 (not in the shared test schema list yet).
  made.raw.exec(readFileSync(join(HERE, "../db/0028_send_log_status_created_idx.sql"), "utf8"));
  return made;
}

let seq = 0;
interface In {
  from: string;
  to?: string;
  cc?: string;
  read?: boolean;
  day?: number; // day of 2026-03
  attach?: "file" | "inline";
  envelope?: string;
  thread?: string;
}
function addIn(raw: Raw, o: In): string {
  seq += 1;
  const id = `mailin_${String(seq).padStart(6, "0")}`;
  const at = new Date(Date.UTC(2026, 2, o.day ?? 1, 3, seq)).toISOString();
  raw
    .prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, cc_json, subject, snippet, received_at, created_at, owner_user_id, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'snip', ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      `m_${id}`,
      o.thread ?? `thr_${id}`,
      JSON.stringify({ email: o.from }),
      JSON.stringify([{ email: o.to ?? "me@developershub.jp" }]),
      o.cc ? JSON.stringify([{ email: o.cc }]) : null,
      `subject ${id}`,
      at,
      at,
    );
  raw
    .prepare(`INSERT INTO mail_inbound_delivery (id, inbound_id, owner_user_id, envelope_to, read_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`dlv_${id}`, id, ME, o.envelope ?? "me@developershub.jp", o.read ? at : null, at, at);
  if (o.attach)
    raw
      .prepare(`INSERT INTO mail_attachments (id, message_kind, message_id, filename, mime_type, size_bytes, r2_key, created_at, content_id) VALUES (?, 'inbound', ?, ?, ?, 10, 'k', ?, ?)`)
      .run(`att_${id}`, id, o.attach === "file" ? "a.pdf" : "logo.png", o.attach === "file" ? "application/pdf" : "image/png", at, o.attach === "inline" ? "cid1" : null);
  return id;
}

function addSent(raw: Raw, o: { to: string; from?: string; day?: number; thread?: string; attach?: boolean }): string {
  seq += 1;
  const id = `maillog_${String(seq).padStart(6, "0")}`;
  const at = new Date(Date.UTC(2026, 2, o.day ?? 1, 3, seq)).toISOString();
  raw
    .prepare(
      `INSERT INTO mail_send_log (id, idempotency_key, req_hash, requester, to_json, subject, thread_id, status, created_at, updated_at, from_address, owner_user_id, snippet)
       VALUES (?, ?, 'h', ?, ?, 'sub', ?, 'sent', ?, ?, ?, ?, 's')`,
    )
    .run(id, `k_${id}`, ME, JSON.stringify([{ email: o.to }]), o.thread ?? null, at, at, o.from ?? "me@developershub.jp", ME);
  if (o.attach)
    raw
      .prepare(`INSERT INTO mail_attachments (id, message_kind, message_id, filename, mime_type, size_bytes, r2_key, created_at) VALUES (?, 'sent', ?, 'b.pdf', 'application/pdf', 10, 'k', ?)`)
      .run(`att_${id}`, id, at);
  return id;
}

function star(raw: Raw, threadId: string): void {
  raw
    .prepare(`INSERT INTO mail_user_flags (owner_user_id, thread_id, starred, archived, trashed, created_at, updated_at) VALUES (?, ?, 1, 0, 0, 'x', 'x')`)
    .run(ME, threadId);
}

async function get(e: ReturnType<typeof env>["env"], path: string): Promise<Response> {
  return app.fetch(new Request(`https://svc/mail/${path}`, { headers: hdr }), e);
}
async function ids(e: ReturnType<typeof env>["env"], path: string): Promise<string[]> {
  const res = await get(e, path);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string }[] };
  return body.items.map((m) => m.id).sort();
}

function seed(raw: Raw) {
  const a = addIn(raw, { from: "Alice@Example.com", read: false, day: 2, attach: "file" });
  const b = addIn(raw, { from: "bob@example.com", read: true, day: 5, cc: "team@developershub.jp" });
  const c = addIn(raw, { from: "alice@example.com", read: true, day: 9, attach: "inline", envelope: "info@developershub.jp", to: "info@developershub.jp" });
  const d = addIn(raw, { from: "carol@example.com", read: false, day: 12, envelope: "list:team@developershub.jp", to: "team@developershub.jp" });
  star(raw, `thr_${b}`);
  const s1 = addSent(raw, { to: "alice@example.com", day: 3, attach: true });
  const s2 = addSent(raw, { to: "dave@example.com", day: 10, from: "info@developershub.jp" });
  star(raw, s2);
  return { a, b, c, d, s1, s2 };
}

describe("GET /mail/messages?folder=all — filters (#899)", () => {
  it("each filter narrows the list", async () => {
    const { env: e, raw } = env();
    const m = seed(raw);
    expect(await ids(e, "messages?folder=all&unread=1")).toEqual([m.a, m.d].sort());
    expect(await ids(e, "messages?folder=all&unread=0")).toEqual([m.b, m.c].sort());
    expect(await ids(e, "messages?folder=all&from=ALICE@example.com")).toEqual([m.a, m.c].sort());
    expect(await ids(e, "messages?folder=all&to=team@developershub.jp")).toEqual([m.b, m.d].sort());
    expect(await ids(e, "messages?folder=all&starred=1")).toEqual([m.b]);
    // An inline logo (image with a Content-ID) is not an attachment.
    expect(await ids(e, "messages?folder=all&hasAttachment=1")).toEqual([m.a]);
    expect(await ids(e, "messages?folder=all&after=2026-03-05T00:00:00Z&before=2026-03-10T00:00:00Z")).toEqual([m.b, m.c].sort());
    expect(await ids(e, "messages?folder=all&mailbox=info@developershub.jp")).toEqual([m.c]);
    // A team-list copy matches its list address.
    expect(await ids(e, "messages?folder=all&mailbox=team@developershub.jp")).toEqual([m.d]);
  });

  it("filters combine (AND) and the total counts only matching conversations", async () => {
    const { env: e, raw } = env();
    const m = seed(raw);
    expect(await ids(e, "messages?folder=all&from=alice@example.com&unread=1")).toEqual([m.a]);
    expect(await ids(e, "messages?folder=all&from=alice@example.com&hasAttachment=1&before=2026-03-01T00:00:00Z")).toEqual([]);
    const res = await get(e, "messages?folder=all&unread=1&q=subject");
    expect(((await res.json()) as mail.MailMessagePage).total).toBe(2);
  });

  it("the legacy message list (no folder) honours the same filters", async () => {
    const { env: e, raw } = env();
    const m = seed(raw);
    expect(await ids(e, "messages?unread=1")).toEqual([m.a, m.d].sort());
    expect(await ids(e, "messages?starred=1&unread=0")).toEqual([m.b]);
    expect(await ids(e, "messages?from=alice@example.com&hasAttachment=1")).toEqual([m.a]);
  });

  it("rejects malformed filter values with 400", async () => {
    const { env: e } = env();
    for (const bad of ["unread=yes", "starred=0", "hasAttachment=true", "from=nope", "to=a@b", "after=tomorrow", "mailbox=x"]) {
      const res = await get(e, `messages?folder=all&${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("GET /mail/sent — filters (#899)", () => {
  it("narrows sent mail; unread=1 matches nothing", async () => {
    const { env: e, raw } = env();
    const m = seed(raw);
    expect(await ids(e, "sent?unread=1")).toEqual([]);
    expect(await ids(e, "sent?unread=0")).toEqual([m.s1, m.s2].sort());
    expect(await ids(e, "sent?to=alice@example.com")).toEqual([m.s1]);
    expect(await ids(e, "sent?from=info@developershub.jp")).toEqual([m.s2]);
    expect(await ids(e, "sent?mailbox=info@developershub.jp")).toEqual([m.s2]);
    expect(await ids(e, "sent?hasAttachment=1")).toEqual([m.s1]);
    expect(await ids(e, "sent?starred=1")).toEqual([m.s2]);
    expect(await ids(e, "sent?after=2026-03-05T00:00:00Z")).toEqual([m.s2]);
    expect(await ids(e, "sent?to=alice@example.com&after=2026-03-05T00:00:00Z")).toEqual([]);
  });
});

describe("query plans (rows-read budget)", () => {
  it("every filter probe uses an index: no SCAN of attachments / deliveries / flags / send log", async () => {
    const { env: e, raw } = env();
    seed(raw);
    const seen: { sql: string }[] = [];
    const orig = raw.prepare.bind(raw);
    (raw as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      if (/^\s*SELECT/i.test(sql)) seen.push({ sql });
      return orig(sql);
    };
    const all = "unread=1&starred=1&hasAttachment=1&from=a@example.com&to=b@example.com&after=2026-03-01T00:00:00Z&before=2026-04-01T00:00:00Z&mailbox=info@developershub.jp";
    await get(e, `messages?folder=all&${all}`);
    await get(e, `messages?${all.replace("unread=1", "unread=0")}`);
    await get(e, `sent?${all.replace("unread=1&", "").replace("from=a@example.com", "from=info@developershub.jp")}`);
    (raw as unknown as { prepare: unknown }).prepare = orig;

    const filtered = seen.filter((s) => /mail_attachments|mail_user_flags|envelope_to IN|from_address\) =/.test(s.sql));
    expect(filtered.length).toBeGreaterThanOrEqual(3);
    expect(filtered.some((s) => /FROM mail_send_log WHERE/.test(s.sql))).toBe(true);
    for (const { sql } of filtered) {
      const params = (sql.match(/\?/g) ?? []).map(() => "x");
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail);
      for (const t of ["mail_attachments", "mail_inbound_delivery", "mail_user_flags", "mail_send_log"]) {
        const scans = plan.filter((d) => new RegExp(`^SCAN (${t}|\\w+)\\b`).test(d) && d.includes(t) && !d.includes("USING"));
        expect(scans, `${t} scanned in:\n${plan.join("\n")}`).toEqual([]);
      }
      // A date-bounded Sent page stays on the per-owner index (not every user's sends).
      if (/FROM mail_send_log WHERE/.test(sql)) expect(plan.some((d) => d.includes("idx_mail_send_log_owner_status_created (owner_user_id=? AND status=? AND created_at>?)"))).toBe(true);
      // Probes are index lookups.
      if (sql.includes("mail_attachments ma")) expect(plan.some((d) => /SEARCH ma USING INDEX idx_mail_attachments_msg/.test(d))).toBe(true);
      if (sql.includes("mail_user_flags sf")) expect(plan.some((d) => /SEARCH sf USING (INDEX|PRIMARY KEY|COVERING INDEX) /.test(d))).toBe(true);
    }
  });
});
