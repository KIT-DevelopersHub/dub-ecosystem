// Server-side search (`q`) on GET /mail/messages + GET /mail/sent: matches subject / sender
// name / body beyond the snippet / Japanese, escapes LIKE wildcards, pages with a cursor,
// and only ever NARROWS the caller's account scope (never widens it).
import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { escapeLike } from "../src/repo";
import { makeEnv, fakeIdentityFetcher } from "./helpers";

const app = createApp();
const asUser = (userId: string, over: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-dub-request-id": "req_search",
  "x-dub-user-id": userId,
  ...over,
});

type Raw = ReturnType<typeof makeEnv>["raw"];
interface Seed {
  id: string;
  owner: string | null;
  subject?: string;
  snippet?: string;
  body?: string;
  from?: mail.MailAddress;
  to?: mail.MailAddress[];
  cc?: mail.MailAddress[] | null;
}
function seed(raw: Raw, r: Seed): void {
  raw
    .prepare(
      `INSERT INTO mail_inbound
         (id, message_id, thread_id, mailbox, from_json, to_json, cc_json, subject, snippet,
          auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id)
       VALUES (?, ?, ?, 'info', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      r.id,
      `<${r.id}@x>`,
      `thr_${r.id}`,
      JSON.stringify(r.from ?? { email: "sender@x.com" }),
      JSON.stringify(r.to ?? [{ email: "info@developershub.jp" }]),
      r.cc === undefined || r.cc === null ? null : JSON.stringify(r.cc),
      r.subject ?? "Hi",
      r.snippet ?? "snip",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
      r.body ?? "body",
      r.owner,
    );
}

async function search(env: ReturnType<typeof makeEnv>["env"], user: string, q: string, extra = ""): Promise<common<mail.MailMessageListItem>> {
  const res = await app.fetch(new Request(`https://svc/mail/messages?q=${encodeURIComponent(q)}${extra}`, { headers: asUser(user) }), env);
  expect(res.status).toBe(200);
  return (await res.json()) as common<mail.MailMessageListItem>;
}
type common<T> = { items: T[]; nextCursor: string | null };
const ids = (p: { items: { id: string }[] }) => p.items.map((i) => i.id).sort();

describe("GET /mail/messages?q= (server-side search)", () => {
  it("matches subject, sender name, body beyond the snippet, and Japanese text", async () => {
    const { env, raw } = makeEnv();
    seed(raw, { id: "in_subj", owner: "usr_a", subject: "Quarterly REPORT" });
    seed(raw, { id: "in_from", owner: "usr_a", from: { email: "info@zenryoku.example", name: "全力エージェンシー" } });
    seed(raw, { id: "in_body", owner: "usr_a", snippet: "冒頭だけ", body: `${"あ".repeat(400)} 秘密のキーワード` });
    seed(raw, { id: "in_cc", owner: "usr_a", cc: [{ email: "carol@cc.example", name: "Carol" }] });
    seed(raw, { id: "in_none", owner: "usr_a" });

    expect(ids(await search(env, "usr_a", "report"))).toEqual(["in_subj"]); // ASCII case-insensitive
    expect(ids(await search(env, "usr_a", "全力エージェンシー"))).toEqual(["in_from"]);
    expect(ids(await search(env, "usr_a", "エージェンシー"))).toEqual(["in_from"]); // substring
    expect(ids(await search(env, "usr_a", "zenryoku"))).toEqual(["in_from"]); // sender email
    expect(ids(await search(env, "usr_a", "秘密のキーワード"))).toEqual(["in_body"]); // beyond snippet
    expect(ids(await search(env, "usr_a", "carol"))).toEqual(["in_cc"]);
    // JSON keys are never matched (address columns are searched per name/email).
    expect(ids(await search(env, "usr_a", "email"))).toEqual([]);
  });

  it("blank q is no search; q over 200 chars is rejected (400)", async () => {
    const { env, raw } = makeEnv();
    seed(raw, { id: "in_1", owner: "usr_a" });
    expect(ids(await search(env, "usr_a", "   "))).toEqual(["in_1"]);
    const res = await app.fetch(new Request(`https://svc/mail/messages?q=${"x".repeat(201)}`, { headers: asUser("usr_a") }), env);
    expect(res.status).toBe(400);
  });

  it("escapes LIKE wildcards (% and _ match literally) and binds the needle (no injection)", async () => {
    const { env, raw } = makeEnv();
    seed(raw, { id: "in_pct", owner: "usr_a", subject: "100% off" });
    seed(raw, { id: "in_us", owner: "usr_a", subject: "file_name" });
    seed(raw, { id: "in_plain", owner: "usr_a", subject: "filename 100 off" });
    expect(ids(await search(env, "usr_a", "%"))).toEqual(["in_pct"]);
    expect(ids(await search(env, "usr_a", "_"))).toEqual(["in_us"]);
    expect(ids(await search(env, "usr_a", "' OR 1=1 --"))).toEqual([]);
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("scope: user B cannot find user A's mail via q; A can", async () => {
    const { env, raw } = makeEnv();
    seed(raw, { id: "in_a", owner: "usr_alice", subject: "全力エージェンシー 見積" });
    seed(raw, { id: "in_orphan", owner: null, subject: "全力エージェンシー 孤児" });
    expect(ids(await search(env, "usr_bob", "全力"))).toEqual([]);
    expect(ids(await search(env, "usr_alice", "全力"))).toEqual(["in_a"]);
  });

  it("scope: a mail:read_all holder finds every account's matching mail", async () => {
    const { env, raw } = makeEnv({
      SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["app:mail:view", "app:mail:edit", "mail:read", "mail:read_all", "mail:send"]),
    });
    seed(raw, { id: "in_a", owner: "usr_alice", subject: "見積 A" });
    seed(raw, { id: "in_b", owner: "usr_bob", subject: "見積 B" });
    seed(raw, { id: "in_x", owner: "usr_bob", subject: "other" });
    expect(ids(await search(env, "usr_super", "見積"))).toEqual(["in_a", "in_b"]);
  });

  it("pages results with a cursor while q stays applied", async () => {
    const { env, raw } = makeEnv();
    for (let i = 1; i <= 5; i++) seed(raw, { id: `in_${i}`, owner: "usr_a", subject: `hit ${i}` });
    seed(raw, { id: "in_9miss", owner: "usr_a", subject: "nope" });
    const p1 = await search(env, "usr_a", "hit", "&limit=2");
    expect(p1.items.map((i) => i.id)).toEqual(["in_5", "in_4"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await search(env, "usr_a", "hit", `&limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`);
    expect(p2.items.map((i) => i.id)).toEqual(["in_3", "in_2"]);
    const p3 = await search(env, "usr_a", "hit", `&limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}`);
    expect(p3.items.map((i) => i.id)).toEqual(["in_1"]);
    expect(p3.nextCursor).toBeNull();
  });
});

describe("GET /mail/sent?q= (server-side search)", () => {
  const send = (env: ReturnType<typeof makeEnv>["env"], user: string, key: string, body: mail.SendMailRequest) =>
    app.fetch(new Request("https://svc/mail/outbox", { method: "POST", headers: asUser(user, { "x-dub-idempotency-key": key }), body: JSON.stringify(body) }), env);
  const sentSearch = async (env: ReturnType<typeof makeEnv>["env"], user: string, q: string) =>
    ((await (await app.fetch(new Request(`https://svc/mail/sent?q=${encodeURIComponent(q)}`, { headers: asUser(user) }), env)).json()) as common<mail.MailSentListItem>).items.map((i) => i.subject);

  it("matches subject / recipient / body, scoped to the sender, never via Bcc", async () => {
    const { env } = makeEnv();
    expect((await send(env, "usr_alice", "s1", { to: [{ email: "x@zenryoku.example", name: "全力エージェンシー" }], subject: "御見積", textBody: `${"本文".repeat(200)}末尾の語` })).status).toBe(202);
    expect((await send(env, "usr_alice", "s2", { to: [{ email: "y@y.com" }], bcc: [{ email: "hidden@secret.example" }], subject: "other", textBody: "b" })).status).toBe(202);

    expect(await sentSearch(env, "usr_alice", "見積")).toEqual(["御見積"]);
    expect(await sentSearch(env, "usr_alice", "全力")).toEqual(["御見積"]);
    expect(await sentSearch(env, "usr_alice", "末尾の語")).toEqual(["御見積"]);
    expect(await sentSearch(env, "usr_alice", "secret.example")).toEqual([]); // Bcc not searchable
    expect(await sentSearch(env, "usr_bob", "見積")).toEqual([]); // another user's Sent
  });
});
