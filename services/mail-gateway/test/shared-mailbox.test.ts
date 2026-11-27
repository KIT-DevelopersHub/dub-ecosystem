// 共用アドレスから送る (0027): picking info@ as the From, the per-send permission check, the
// send log, the display name / signature, and replies reaching the member who sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import handler from "../src/index";
import { MockMailProvider, type OutboundMail } from "../src/provider";
import { buildInboundDeps } from "../src/deps";
import { handleInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { listInbound } from "../src/repo";
import { runScheduledSendDrain } from "../src/scheduled-send";
import { displayFrom } from "../src/shared-mailbox";
import { ctx, fakeIdentityFetcher, makeEnv, withMailAdmins } from "./helpers";

const INFO = "info@developershub.jp";
const NAME = "北陸ITカンファレンス 実行委員会";
const ROSTER = {
  usr_alice: { email: "alice@developershub.jp" },
  usr_bob: { email: "bob@developershub.jp" },
  usr_info: { email: INFO },
  usr_guest: { email: "guest@gmail.example" },
  usr_admin: { email: "admin@developershub.jp" },
};

/** member-service: `members` answers ?all=1, `teams[id]` answers ?teamIds=id. */
function memberFetcher(state: { members: string[]; teams?: Record<string, string[]>; down?: boolean }): Fetcher {
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/members/internal/team-members");
      expect(url.searchParams.get("excludeDeclined")).toBe("1");
      if (state.down) return new Response("{}", { status: 500 });
      if (url.searchParams.get("all") === "1") return Response.json({ userIds: state.members });
      return Response.json({ userIds: state.teams?.[url.searchParams.get("teamIds") ?? ""] ?? [] });
    },
  } as unknown as Fetcher;
}

let captured: OutboundMail[];
beforeEach(() => {
  captured = [];
  vi.spyOn(MockMailProvider.prototype, "send").mockImplementation(async (m: OutboundMail) => {
    captured.push(m);
    return { providerMessageId: `mock-${m.messageId}` };
  });
});
afterEach(() => vi.restoreAllMocks());

function setup(member: { members: string[]; teams?: Record<string, string[]>; down?: boolean } = { members: ["usr_alice"] }, admins: string[] = ["usr_admin"]) {
  const made = makeEnv({ SVC_IDENTITY: withMailAdmins(fakeIdentityFetcher(true, ROSTER), admins), SVC_MEMBER: memberFetcher(member) });
  const call = (path: string, user: string, init: RequestInit = {}) =>
    handler.fetch(
      new Request(`https://svc${path}`, { ...init, headers: { "content-type": "application/json", "x-dub-request-id": "req_shared", "x-dub-user-id": user } }),
      made.env,
      {} as never,
    );
  return { ...made, member, admins, call };
}

const compose = (over: Partial<mail.SendMailRequest> = {}) =>
  JSON.stringify({ to: [{ email: "speaker@partner.example" }], subject: "基調講演のご依頼", textBody: "ご検討をお願いいたします。", ...over });

function reply(inReplyTo: string, id = "<r1@partner.example>"): RawInbound {
  return {
    from: "speaker@partner.example",
    to: INFO,
    headers: {
      "message-id": id,
      from: "Speaker <speaker@partner.example>",
      to: INFO,
      subject: "Re: 基調講演のご依頼",
      "in-reply-to": inReplyTo,
      references: inReplyTo,
      date: "Thu, 26 Nov 2026 01:00:00 +0000",
    },
    rawText: "Subject: Re\r\n\r\nお引き受けします。",
    rawSize: 128,
  };
}

describe("GET /mail/send-as", () => {
  it("lists the caller's own address first, then the shared mailboxes they may use", async () => {
    const { call } = setup();
    const res = await call("/mail/send-as", "usr_alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as mail.MailSendAsList;
    expect(body.items).toEqual([
      { address: "alice@developershub.jp", kind: "self" },
      { address: INFO, kind: "shared", displayName: NAME, signature: `--\n${NAME}\n${INFO}` },
    ]);
  });

  it("leaves out a shared mailbox the caller may not use, and hides it when member-service is down", async () => {
    expect(((await (await setup().call("/mail/send-as", "usr_bob")).json()) as mail.MailSendAsList).items).toEqual([{ address: "bob@developershub.jp", kind: "self" }]);
    const down = await setup({ members: ["usr_alice"], down: true }).call("/mail/send-as", "usr_alice");
    expect(((await down.json()) as mail.MailSendAsList).items.map((i) => i.address)).toEqual(["alice@developershub.jp"]);
  });
});

describe("POST /mail/outbox with fromAddress", () => {
  it("sends as info@ with the display name and records who sent it", async () => {
    const { call, raw } = setup();
    const res = await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: INFO }) });
    expect(res.status).toBe(202);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.from).toBe(`${NAME} <${INFO}>`);
    expect(captured[0]!.mime).toMatch(/^From: =\?UTF-8\?B\?[^\r\n]+ <info@developershub\.jp>/m);
    const row = raw.prepare(`SELECT requester, owner_user_id, from_address, shared_mailbox FROM mail_send_log`).get();
    expect(row).toEqual({ requester: "usr_alice", owner_user_id: "usr_alice", from_address: INFO, shared_mailbox: INFO });
  });

  it("403s a member who may not send as info@ and sends nothing", async () => {
    const { call, raw } = setup();
    const res = await call("/mail/outbox", "usr_bob", { method: "POST", body: compose({ fromAddress: INFO }) });
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM mail_send_log`).get()).toEqual({ n: 0 });
  });

  it("403s someone else's address and an address that is not a shared mailbox", async () => {
    const { call } = setup();
    for (const from of ["bob@developershub.jp", "sales@developershub.jp"]) {
      expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: from }) })).status).toBe(403);
    }
    expect(captured).toHaveLength(0);
  });

  it("502s instead of guessing when member-service cannot answer", async () => {
    const { call } = setup({ members: [], down: true });
    expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: INFO }) })).status).toBe(502);
    expect(captured).toHaveLength(0);
  });

  it("the caller's own address is always fine and is not a shared send", async () => {
    const { call, raw } = setup();
    expect((await call("/mail/outbox", "usr_bob", { method: "POST", body: compose({ fromAddress: "BOB@developershub.jp" }) })).status).toBe(202);
    expect(captured[0]!.from).toBe("bob@developershub.jp");
    expect(raw.prepare(`SELECT shared_mailbox FROM mail_send_log`).get()).toEqual({ shared_mailbox: null });
  });

  it("without fromAddress nothing changes: own address, no display name", async () => {
    const { call } = setup();
    expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose() })).status).toBe(202);
    expect(captured[0]!.from).toBe("alice@developershub.jp");
  });

  it("a team-scoped shared mailbox follows that team", async () => {
    const { call, raw } = setup({ members: ["usr_alice", "usr_bob"], teams: { team_session: ["usr_bob"] } });
    raw.prepare(`UPDATE mail_shared_mailbox SET allow = 'team', team_id = 'team_session' WHERE address = ?`).run(INFO);
    expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: INFO }) })).status).toBe(403);
    expect((await call("/mail/outbox", "usr_bob", { method: "POST", body: compose({ fromAddress: INFO }) })).status).toBe(202);
  });

  it("a removed shared mailbox can no longer be picked", async () => {
    const { call, raw } = setup();
    raw.prepare(`UPDATE mail_shared_mailbox SET deleted_at = 't' WHERE address = ?`).run(INFO);
    expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: INFO }) })).status).toBe(403);
  });
});

describe("replies to a shared-address send", () => {
  it("reach the member who sent it, and info@ keeps its copy", async () => {
    const { call, env } = setup();
    const res = await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: INFO }) });
    const { messageId } = (await res.json()) as mail.SendMailResponse;
    const deps = buildInboundDeps(env, ctx());
    await handleInbound(deps, reply(`<${messageId}>`));
    const db = deps.db;
    for (const uid of ["usr_alice", "usr_info"]) {
      const page = await listInbound(db, { ownerUserId: uid, viewer: uid, limit: 10 });
      expect(page.items.map((m) => m.subject), uid).toEqual(["Re: 基調講演のご依頼"]);
    }
    expect((await listInbound(db, { ownerUserId: "usr_bob", viewer: "usr_bob", limit: 10 })).items).toHaveLength(0);

    // Alice answering from her copy goes out as info@ again (her copy's envelope is info@).
    const inbound = (await listInbound(db, { ownerUserId: "usr_alice", viewer: "usr_alice", limit: 10 })).items[0]!;
    const again = await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ subject: "Re: 基調講演のご依頼", inReplyTo: inbound.messageId }) });
    expect(again.status).toBe(202);
    expect(captured[1]!.from).toBe(`${NAME} <${INFO}>`);
  });

  it("a reply that matches none of our sends stays with info@ only", async () => {
    const { env } = setup();
    const deps = buildInboundDeps(env, ctx());
    await handleInbound(deps, reply("<unknown@partner.example>"));
    expect((await listInbound(deps.db, { ownerUserId: "usr_info", viewer: "usr_info", limit: 10 })).items).toHaveLength(1);
    expect((await listInbound(deps.db, { ownerUserId: "usr_alice", viewer: "usr_alice", limit: 10 })).items).toHaveLength(0);
  });

  it("a redelivered reply adds no second copy", async () => {
    const { call, env, raw } = setup();
    const { messageId } = (await (await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: INFO }) })).json()) as mail.SendMailResponse;
    const deps = buildInboundDeps(env, ctx());
    await handleInbound(deps, reply(`<${messageId}>`));
    await handleInbound(deps, reply(`<${messageId}>`));
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM mail_inbound_delivery WHERE owner_user_id = 'usr_alice'`).get()).toEqual({ n: 1 });
  });
});

describe("scheduled send as info@", () => {
  const later = () => Date.now() + 2 * 60 * 60 * 1000;
  const at = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it("is checked when booked and sent with the display name", async () => {
    const { call, env, raw } = setup();
    expect((await call("/mail/scheduled", "usr_bob", { method: "POST", body: JSON.stringify({ ...JSON.parse(compose({ fromAddress: INFO })), scheduledAt: at() }) })).status).toBe(403);
    const ok = await call("/mail/scheduled", "usr_alice", { method: "POST", body: JSON.stringify({ ...JSON.parse(compose({ fromAddress: INFO })), scheduledAt: at() }) });
    expect(ok.status).toBe(202);
    expect(raw.prepare(`SELECT from_address, shared_mailbox FROM mail_scheduled`).get()).toEqual({ from_address: INFO, shared_mailbox: INFO });
    expect((await runScheduledSendDrain(env, later(), new MockMailProvider())).sent).toBe(1);
    expect(captured[0]!.from).toBe(`${NAME} <${INFO}>`);
    expect(raw.prepare(`SELECT owner_user_id, shared_mailbox FROM mail_send_log`).get()).toEqual({ owner_user_id: "usr_alice", shared_mailbox: INFO });
  });

  it("is not sent when the right is gone by the time it is due", async () => {
    const { call, env, member } = setup();
    await call("/mail/scheduled", "usr_alice", { method: "POST", body: JSON.stringify({ ...JSON.parse(compose({ fromAddress: INFO })), scheduledAt: at() }) });
    member.members = [];
    const res = await runScheduledSendDrain(env, later(), new MockMailProvider());
    expect(res.sent).toBe(0);
    expect(captured).toHaveLength(0);
  });
});

describe("mail:admin with no 名簿 row (admin@)", () => {
  const at = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const later = () => Date.now() + 2 * 60 * 60 * 1000;

  it("may pick info@ (all_members): offered, sent with the name, Cc'd, and re-checked when due", async () => {
    const { call, env, raw, admins } = setup({ members: ["usr_alice"] });
    const list = (await (await call("/mail/send-as", "usr_admin")).json()) as mail.MailSendAsList;
    expect(list.items.map((i) => i.address)).toEqual(["admin@developershub.jp", INFO]);
    expect((await call("/mail/outbox", "usr_admin", { method: "POST", body: compose({ fromAddress: INFO }) })).status).toBe(202);
    expect(captured[0]!.from).toBe(`${NAME} <${INFO}>`);
    expect(captured[0]!.cc?.map((a) => a.email)).toContain("admin@developershub.jp");
    expect(raw.prepare(`SELECT owner_user_id, shared_mailbox FROM mail_send_log`).get()).toEqual({ owner_user_id: "usr_admin", shared_mailbox: INFO });

    const body = JSON.stringify({ ...JSON.parse(compose({ fromAddress: INFO })), scheduledAt: at() });
    expect((await call("/mail/scheduled", "usr_admin", { method: "POST", body })).status).toBe(202);
    admins.length = 0; // mail:admin taken away before the time
    expect((await runScheduledSendDrain(env, later(), new MockMailProvider())).sent).toBe(0);
    expect(captured).toHaveLength(1);
  });

  it("still may not pick a team-scoped address", async () => {
    const { call, raw } = setup({ members: ["usr_alice"], teams: { team_session: ["usr_alice"] } });
    raw.prepare(`UPDATE mail_shared_mailbox SET allow = 'team', team_id = 'team_session' WHERE address = ?`).run(INFO);
    const list = (await (await call("/mail/send-as", "usr_admin")).json()) as mail.MailSendAsList;
    expect(list.items.map((i) => i.address)).toEqual(["admin@developershub.jp"]);
    expect((await call("/mail/outbox", "usr_admin", { method: "POST", body: compose({ fromAddress: INFO }) })).status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("someone with neither a 名簿 row nor mail:admin may not", async () => {
    const { call } = setup({ members: ["usr_alice"] });
    const list = (await (await call("/mail/send-as", "usr_bob")).json()) as mail.MailSendAsList;
    expect(list.items.map((i) => i.address)).toEqual(["bob@developershub.jp"]);
    expect((await call("/mail/outbox", "usr_bob", { method: "POST", body: compose({ fromAddress: INFO }) })).status).toBe(403);
    expect(captured).toHaveLength(0);
  });
});

describe("admin: shared mailboxes", () => {
  it("creates, edits and removes one (mail:admin)", async () => {
    const { call } = setup();
    const created = await call("/mail/admin/shared-mailboxes", "usr_admin", {
      method: "POST",
      body: JSON.stringify({ localPart: "speakers", displayName: "セッションチーム", signature: "", allow: "team", teamId: "team_session" }),
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as mail.MailSharedMailbox;
    expect(row).toMatchObject({ address: "speakers@developershub.jp", allow: "team", teamId: "team_session" });
    const dup = await call("/mail/admin/shared-mailboxes", "usr_admin", { method: "POST", body: JSON.stringify({ localPart: "info", displayName: "x", allow: "all_members" }) });
    expect(dup.status).toBe(409);
    const patched = await call(`/mail/admin/shared-mailboxes/${row.id}`, "usr_admin", { method: "PATCH", body: JSON.stringify({ allow: "all_members" }) });
    expect(((await patched.json()) as mail.MailSharedMailbox)).toMatchObject({ allow: "all_members", teamId: null });
    expect((await call(`/mail/admin/shared-mailboxes/${row.id}`, "usr_admin", { method: "DELETE" })).status).toBe(200);
    const list = (await (await call("/mail/admin/shared-mailboxes", "usr_admin")).json()) as { items: mail.MailSharedMailbox[] };
    expect(list.items.map((i) => i.address)).toEqual([INFO]);
  });

  it("refuses a team-scoped mailbox without a team", async () => {
    const { call } = setup();
    const res = await call("/mail/admin/shared-mailboxes", "usr_admin", { method: "POST", body: JSON.stringify({ localPart: "x", displayName: "x", allow: "team" }) });
    expect(res.status).toBe(400);
  });
});

describe("displayFrom", () => {
  it("quotes a name with specials and keeps a bare address bare", () => {
    expect(displayFrom(INFO, null)).toBe(INFO);
    expect(displayFrom(INFO, NAME)).toBe(`${NAME} <${INFO}>`);
    expect(displayFrom(INFO, 'Dub, "Team"')).toBe(`"Dub, \\"Team\\"" <${INFO}>`);
    expect(displayFrom(INFO, "a\r\nBcc: x")).toBe(`"a Bcc: x" <${INFO}>`);
  });
});
