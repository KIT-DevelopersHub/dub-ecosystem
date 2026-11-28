// #942 自分の班・チームのメンバーのメールを読み取り専用で見る — the handler-side range check
// (layer 2). The table (policy-table.test.ts) only proves the key is required; here: a leader
// sees only their 班, an organizer only their team, a plain member nobody; no write route exists;
// every opened item is audited; member-service down = 502, never a guess.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import handler from "../src/index";
import { MockMailProvider, type OutboundMail } from "../src/provider";
import { MANAGED_VIEW_AUDIT_ACTION } from "../src/managed-view";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const ROSTER = {
  usr_leadA: { email: "leada@developershub.jp" },
  usr_a1: { email: "a1@developershub.jp" },
  usr_b1: { email: "b1@developershub.jp" },
  usr_org1: { email: "org1@developershub.jp" },
  usr_c1: { email: "c1@developershub.jp" },
};

// member-service's answer per viewer (its own test proves how 班 / チーム are derived):
// 班A = leadA -> a1 / 班B -> b1 / 広報チーム org1 -> leadA, a1, b1 / 会場チーム -> c1.
const RANGE: Record<string, mail.MailManagedMailbox[]> = {
  usr_leadA: [{ userId: "usr_a1", name: "a1", relation: "squad" }],
  usr_org1: [
    { userId: "usr_leadA", name: "leadA", relation: "team" },
    { userId: "usr_a1", name: "a1", relation: "team" },
    { userId: "usr_b1", name: "b1", relation: "team" },
  ],
};

function memberFetcher(state: { down?: boolean } = {}): Fetcher {
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/members/internal/managed-mailboxes");
      if (state.down) return new Response("{}", { status: 500 });
      return Response.json({ items: RANGE[url.searchParams.get("userId") ?? ""] ?? [] });
    },
  } as unknown as Fetcher;
}

beforeEach(() => {
  vi.spyOn(MockMailProvider.prototype, "send").mockImplementation(async (m: OutboundMail) => ({ providerMessageId: `mock-${m.messageId}` }));
});
afterEach(() => vi.restoreAllMocks());

function setup(member: { down?: boolean } = {}) {
  const made = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, ROSTER), SVC_MEMBER: memberFetcher(member) });
  const call = (path: string, user: string, init: RequestInit = {}) =>
    handler.fetch(
      new Request(`https://svc${path}`, { ...init, headers: { "content-type": "application/json", "x-dub-request-id": "req_managed", "x-dub-user-id": user } }),
      made.env,
      {} as never,
    );
  const seedInbound = (id: string, owner: string) =>
    made.raw
      .prepare(
        `INSERT INTO mail_inbound
           (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
            auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id)
         VALUES (?, ?, ?, 'info', ?, ?, 'Hi', 'snip', NULL, NULL, ?, ?, 'body', NULL, NULL, ?)`,
      )
      .run(id, `<${id}@x>`, `thr_${id}`, JSON.stringify({ email: "sender@x.com" }), JSON.stringify([{ email: "x@developershub.jp" }]),
        "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z", owner);
  seedInbound("mailin_a1", "usr_a1");
  seedInbound("mailin_b1", "usr_b1");
  seedInbound("mailin_c1", "usr_c1");
  seedInbound("mailin_leadA", "usr_leadA");
  return { ...made, call };
}

const ids = async (res: Response): Promise<string[]> => ((await res.json()) as mail.MailMessagePage).items.map((m) => m.id);

describe("GET /mail/managed-mailboxes", () => {
  it("returns the caller's range from member-service (empty for a plain member)", async () => {
    const { call } = setup();
    const lead = (await (await call("/mail/managed-mailboxes", "usr_leadA")).json()) as mail.MailManagedMailboxList;
    expect(lead.items.map((i) => i.userId)).toEqual(["usr_a1"]);
    const plain = (await (await call("/mail/managed-mailboxes", "usr_a1")).json()) as mail.MailManagedMailboxList;
    expect(plain.items).toEqual([]);
  });
});

describe("range boundary (layer 2)", () => {
  it("a leader reads their 班 member's mailbox — that member's mail only", async () => {
    const { call } = setup();
    const res = await call("/mail/managed/usr_a1/messages", "usr_leadA");
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(["mailin_a1"]);
    expect((await call("/mail/managed/usr_a1/messages?folder=inbox", "usr_leadA")).status).toBe(200);
    expect((await call("/mail/managed/usr_a1/counts", "usr_leadA")).status).toBe(200);
    expect((await call("/mail/managed/usr_a1/messages/mailin_a1", "usr_leadA")).status).toBe(200);
  });

  it("a leader cannot open another 班's member, nor someone outside the team", async () => {
    const { call } = setup();
    for (const path of ["/mail/managed/usr_b1/messages", "/mail/managed/usr_b1/messages/mailin_b1", "/mail/managed/usr_b1/threads/thr_mailin_b1", "/mail/managed/usr_c1/counts", "/mail/managed/usr_b1/sent"]) {
      expect((await call(path, "usr_leadA")).status, path).toBe(403);
    }
  });

  it("an organizer reads their team (leaders included) but not another team", async () => {
    const { call } = setup();
    expect(await ids(await call("/mail/managed/usr_leadA/messages", "usr_org1"))).toEqual(["mailin_leadA"]);
    expect(await ids(await call("/mail/managed/usr_b1/messages", "usr_org1"))).toEqual(["mailin_b1"]);
    expect((await call("/mail/managed/usr_c1/messages", "usr_org1")).status).toBe(403);
    expect((await call("/mail/managed/usr_c1/messages/mailin_c1", "usr_org1")).status).toBe(403);
  });

  it("a plain member cannot open anyone, themselves included through this path", async () => {
    const { call } = setup();
    for (const target of ["usr_leadA", "usr_b1", "usr_a1"]) {
      expect((await call(`/mail/managed/${target}/messages`, "usr_a1")).status).toBe(403);
    }
  });

  it("a message of someone else, addressed through an in-range member's path, is 404", async () => {
    const { call } = setup();
    expect((await call("/mail/managed/usr_a1/messages/mailin_b1", "usr_leadA")).status).toBe(404);
    expect((await call("/mail/managed/usr_a1/threads/thr_mailin_b1", "usr_leadA")).status).toBe(404);
  });

  it("fails closed with 502 when member-service cannot answer", async () => {
    const { call } = setup({ down: true });
    expect((await call("/mail/managed/usr_a1/messages", "usr_leadA")).status).toBe(502);
    expect((await call("/mail/managed-mailboxes", "usr_leadA")).status).toBe(502);
  });
});

describe("read-only", () => {
  it("has no write route: marking read / flagging / sending as the member are not served", async () => {
    const { call, raw } = setup();
    for (const [method, path] of [
      ["POST", "/mail/managed/usr_a1/messages/mailin_a1/read"],
      ["POST", "/mail/managed/usr_a1/read-state"],
      ["POST", "/mail/managed/usr_a1/flags/thr_mailin_a1"],
      ["POST", "/mail/managed/usr_a1/outbox"],
    ] as const) {
      const res = await call(path, "usr_leadA", { method, body: "{}" });
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    // Opening does not mark it read for the member.
    await call("/mail/managed/usr_a1/messages/mailin_a1", "usr_leadA");
    await call("/mail/managed/usr_a1/threads/thr_mailin_a1", "usr_leadA");
    expect(raw.prepare(`SELECT read_at FROM mail_inbound WHERE id = 'mailin_a1'`).get()).toEqual({ read_at: null });
  });

  it("the member's Sent folder hides Bcc from the viewer", async () => {
    const { call } = setup();
    const sent = await call("/mail/outbox", "usr_a1", {
      method: "POST",
      body: JSON.stringify({ to: [{ email: "p@partner.example" }], bcc: [{ email: "secret@partner.example" }], subject: "s", textBody: "b" }),
    });
    expect(sent.status).toBe(202);
    const list = (await (await call("/mail/managed/usr_a1/sent", "usr_leadA")).json()) as { items: mail.MailSentListItem[] };
    expect(list.items).toHaveLength(1);
    const detail = await call(`/mail/managed/usr_a1/sent/${list.items[0]!.id}`, "usr_leadA");
    expect(detail.status).toBe(200);
    expect(JSON.stringify(await detail.json())).not.toContain("secret@partner.example");
  });
});

describe("audit", () => {
  it("records each opened message / thread with the member it belonged to; lists are not audited", async () => {
    const { call, sends } = setup();
    await call("/mail/managed/usr_a1/messages", "usr_leadA");
    await call("/mail/managed/usr_a1/messages/mailin_a1", "usr_leadA");
    await call("/mail/managed/usr_a1/threads/thr_mailin_a1", "usr_leadA");
    await call("/mail/managed/usr_b1/messages/mailin_b1", "usr_leadA"); // denied: not audited as an open
    const rows = JSON.stringify(sends.audit);
    expect(rows.match(new RegExp(MANAGED_VIEW_AUDIT_ACTION.replace(/\./g, "\\."), "g"))).toHaveLength(2);
    expect(rows).toContain('"targetUserId":"usr_a1"');
    expect(rows).toContain('"actorId":"usr_leadA"');
    expect(rows).not.toContain("usr_b1");
  });
});
