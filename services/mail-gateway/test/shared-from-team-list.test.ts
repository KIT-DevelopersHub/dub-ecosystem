// 共用アドレスから送る (0027) の続き: チームのメーリングリスト (0024) を差出人に選べること、
// 差出人が本人以外の時は本人を必ず Cc に入れること (送信 API 側で強制)。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import handler from "../src/index";
import { MockMailProvider, type OutboundMail } from "../src/provider";
import { runScheduledSendDrain } from "../src/scheduled-send";
import { withSelfCc } from "../src/from";
import { makeEnv, fakeIdentityFetcher } from "./helpers";

const INFO = "info@developershub.jp";
const DESIGN = "design@developershub.jp";
const ROSTER = {
  usr_alice: { email: "alice@developershub.jp" },
  usr_bob: { email: "bob@developershub.jp" },
};

interface MemberState {
  members: string[];
  teams: Record<string, string[]>;
  names: Record<string, string>;
  namesDown?: boolean;
}

/** member-service: team-members (?all=1 / ?teamIds=) and team-names. */
function memberFetcher(state: MemberState): Fetcher {
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/members/internal/team-names") {
        if (state.namesDown) return new Response("{}", { status: 500 });
        const ids = (url.searchParams.get("teamIds") ?? "").split(",");
        return Response.json({ teams: ids.filter((id) => state.names[id]).map((id) => ({ id, name: state.names[id] })) });
      }
      expect(url.pathname).toBe("/members/internal/team-members");
      if (url.searchParams.get("all") === "1") return Response.json({ userIds: state.members });
      return Response.json({ userIds: state.teams[url.searchParams.get("teamIds") ?? ""] ?? [] });
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

function setup(over: Partial<MemberState> = {}) {
  const member: MemberState = { members: ["usr_alice", "usr_bob"], teams: { team_design: ["usr_alice"] }, names: { team_design: "デザインチーム" }, ...over };
  const made = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, ROSTER), SVC_MEMBER: memberFetcher(member) });
  made.raw
    .prepare(`INSERT INTO mail_team_list (id, address, team_id, created_by, created_at, updated_at, deleted_at) VALUES ('mtl_1', ?, 'team_design', NULL, 't', 't', NULL)`)
    .run(DESIGN);
  const call = (path: string, user: string, init: RequestInit = {}) =>
    handler.fetch(
      new Request(`https://svc${path}`, { ...init, headers: { "content-type": "application/json", "x-dub-request-id": "req_team_from", "x-dub-user-id": user } }),
      made.env,
      {} as never,
    );
  return { ...made, member, call };
}

const compose = (over: Partial<mail.SendMailRequest> = {}) =>
  JSON.stringify({ to: [{ email: "vendor@partner.example" }], subject: "ポスターの入稿", textBody: "よろしくお願いします。", ...over });
const ccOf = (m: OutboundMail) => (m.cc ?? []).map((a) => a.email.toLowerCase());

describe("team mailing list as a From", () => {
  it("is offered to the team's members only, named and signed after the team", async () => {
    const { call } = setup();
    const alice = ((await (await call("/mail/send-as", "usr_alice")).json()) as mail.MailSendAsList).items;
    expect(alice.map((i) => [i.address, i.kind])).toEqual([
      ["alice@developershub.jp", "self"],
      [INFO, "shared"],
      [DESIGN, "team_list"],
    ]);
    expect(alice[2]).toEqual({ address: DESIGN, kind: "team_list", displayName: "デザインチーム", signature: `--\nデザインチーム\n${DESIGN}` });
    const bob = ((await (await call("/mail/send-as", "usr_bob")).json()) as mail.MailSendAsList).items;
    expect(bob.map((i) => i.address)).not.toContain(DESIGN);
  });

  it("sends as the list with the team name for a member, 403 for anyone else", async () => {
    const { call, raw } = setup();
    expect((await call("/mail/outbox", "usr_bob", { method: "POST", body: compose({ fromAddress: DESIGN }) })).status).toBe(403);
    expect(captured).toHaveLength(0);
    const res = await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN }) });
    expect(res.status).toBe(202);
    expect(captured[0]!.from).toBe(`デザインチーム <${DESIGN}>`);
    expect(raw.prepare(`SELECT owner_user_id, from_address, shared_mailbox FROM mail_send_log`).get()).toEqual({ owner_user_id: "usr_alice", from_address: DESIGN, shared_mailbox: DESIGN });
  });

  it("follows the team: leaving it removes the right at once", async () => {
    const { call, member } = setup();
    member.teams.team_design = [];
    expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN }) })).status).toBe(403);
  });

  it("without the team name the From is the bare list address (still sendable)", async () => {
    const { call } = setup({ namesDown: true });
    expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN }) })).status).toBe(202);
    expect(captured[0]!.from).toBe(DESIGN);
  });

  it("a removed list can no longer be picked", async () => {
    const { call, raw } = setup();
    raw.prepare(`UPDATE mail_team_list SET deleted_at = 't' WHERE address = ?`).run(DESIGN);
    expect((await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN }) })).status).toBe(403);
  });
});

describe("the sender is always Cc'd when the From is not their own", () => {
  it("adds the sender to Cc for a team list and for info@, even when the client left it out", async () => {
    const { call, raw } = setup();
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN }) });
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: INFO, subject: "info" }) });
    for (const m of captured) expect(ccOf(m)).toContain("alice@developershub.jp");
    const rows = raw.prepare(`SELECT cc_json FROM mail_send_log ORDER BY created_at`).all() as { cc_json: string }[];
    for (const r of rows) expect(r.cc_json).toContain("alice@developershub.jp");
  });

  it("does not duplicate it when the client already put the sender on Cc or To", async () => {
    const { call } = setup();
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN, cc: [{ email: "Alice@developershub.jp" }] }) });
    expect(ccOf(captured[0]!).filter((a) => a === "alice@developershub.jp")).toHaveLength(1);
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN, subject: "to self", to: [{ email: "alice@developershub.jp" }] }) });
    expect(ccOf(captured[1]!)).not.toContain("alice@developershub.jp");
  });

  it("moves a Bcc copy of the sender to the Cc", async () => {
    const { call } = setup();
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: DESIGN, bcc: [{ email: "alice@developershub.jp" }, { email: "boss@partner.example" }] }) });
    expect(ccOf(captured[0]!)).toContain("alice@developershub.jp");
    const bcc = (captured[0]!.bcc ?? []).map((a) => a.email);
    expect(bcc).toContain("boss@partner.example");
    expect(bcc).not.toContain("alice@developershub.jp");
  });

  it("adds nothing when the From is the sender's own (picked or default) or a reply", async () => {
    const { call } = setup();
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ fromAddress: "alice@developershub.jp" }) });
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ subject: "default" }) });
    await call("/mail/outbox", "usr_alice", { method: "POST", body: compose({ subject: "Re", inReplyTo: "<x@partner.example>" }) });
    for (const m of captured) expect(ccOf(m)).not.toContain("alice@developershub.jp");
  });

  it("refuses to send when the sender's address cannot be read (never sends without the Cc)", async () => {
    const { env, member } = setup();
    member.teams.team_design = ["usr_ghost"];
    const res = await handler.fetch(
      new Request("https://svc/mail/outbox", { method: "POST", body: compose({ fromAddress: DESIGN }), headers: { "content-type": "application/json", "x-dub-request-id": "r", "x-dub-user-id": "usr_ghost" } }),
      env,
      {} as never,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(captured).toHaveLength(0);
  });

  it("scheduled: stored on the booking, kept through an edit, and enforced again at send time", async () => {
    const { call, env, raw } = setup();
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const booked = await call("/mail/scheduled", "usr_alice", { method: "POST", body: JSON.stringify({ ...JSON.parse(compose({ fromAddress: DESIGN })), scheduledAt: at }) });
    expect(booked.status).toBe(202);
    const { id } = (await booked.json()) as mail.ScheduleMailResponse;
    expect((raw.prepare(`SELECT cc_json FROM mail_scheduled`).get() as { cc_json: string }).cc_json).toContain("alice@developershub.jp");

    const edited = await call(`/mail/scheduled/${id}`, "usr_alice", { method: "PATCH", body: JSON.stringify({ cc: [] }) });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as mail.ScheduledSendDetail).cc?.map((a) => a.email)).toEqual(["alice@developershub.jp"]);

    raw.prepare(`UPDATE mail_scheduled SET cc_json = '[]'`).run(); // a row booked before the rule
    expect((await runScheduledSendDrain(env, Date.now() + 2 * 60 * 60 * 1000, new MockMailProvider())).sent).toBe(1);
    expect(captured[0]!.from).toBe(`デザインチーム <${DESIGN}>`);
    expect(ccOf(captured[0]!)).toContain("alice@developershub.jp");
  });
});

describe("withSelfCc", () => {
  it("adds once, case-insensitively, and leaves a null self alone", () => {
    const req: { to: mail.MailAddress[]; cc?: mail.MailAddress[] } = { to: [{ email: "a@x.example" }] };
    expect(withSelfCc(req, null)).toBe(req);
    expect(withSelfCc(req, "Me@x.example").cc).toEqual([{ email: "me@x.example" }]);
    expect(withSelfCc(req, "a@X.example").cc).toBeUndefined();
    expect(withSelfCc({ to: [], cc: [{ email: "me@x.example" }] }, "me@x.example").cc).toHaveLength(1);
    expect(withSelfCc({ to: [], bcc: [{ email: "me@x.example" }] }, "me@x.example")).toEqual({ to: [], cc: [{ email: "me@x.example" }] });
  });
});
