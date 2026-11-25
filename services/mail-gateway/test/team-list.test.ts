// Team mailing lists (0024): delivery to the team's inboxes, reply behaviour, and keeping a
// list out of the user roster.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import { issuedAddressesFromRules, rosterAddressesFromRules, teamListRuleInput, type CfRoutingRule } from "../src/email-routing";
import { resolveReplyFromAddress } from "../src/from";
import { handleInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { getInboundDetail, listInbound } from "../src/repo";
import { fakeIdentityFetcher, inboundDeps, makeEnv, makeHarness, type Harness } from "./helpers";

const LIST = "design@developershub.jp";
const A = "alice@developershub.jp";
const B = "bob@developershub.jp";
const C = "carol@developershub.jp";
const ROSTER = { usr_alice: { email: A }, usr_bob: { email: B }, usr_carol: { email: C } };

function memberFetcher(userIds: string[] | "error"): Fetcher {
  return {
    fetch: async (req: Request) => {
      expect(req.url).toContain("/members/internal/team-members?teamIds=team_design&excludeDeclined=1");
      if (userIds === "error") return new Response("{}", { status: 500 });
      return Response.json({ userIds });
    },
  } as unknown as Fetcher;
}

function copyFor(envelope: string, headers: Record<string, string> = {}): RawInbound {
  return {
    from: "x@partner.example",
    to: envelope,
    headers: {
      "message-id": "<list-1@partner.example>",
      from: "Xavier <x@partner.example>",
      to: "someone@partner.example",
      cc: LIST,
      subject: "Proposal",
      date: "Tue, 27 Oct 2026 01:00:00 +0000",
      ...headers,
    },
    rawText: "Subject: Proposal\r\n\r\nHello team.",
    rawSize: 256,
  };
}

function addList(h: Harness) {
  h.raw
    .prepare(`INSERT INTO mail_team_list (id, address, team_id, created_at, updated_at) VALUES ('l1', ?, 'team_design', 't', 't')`)
    .run(LIST);
}

function setup(userIds: string[] | "error" = ["usr_alice", "usr_bob"]) {
  const h = makeHarness();
  addList(h);
  const deps = inboundDeps(h, { identity: fakeIdentityFetcher(true, ROSTER), member: memberFetcher(userIds) });
  return { h, deps };
}

const deliveries = (h: Harness) =>
  h.raw.prepare(`SELECT owner_user_id, envelope_to FROM mail_inbound_delivery WHERE owner_user_id IS NOT NULL ORDER BY owner_user_id, envelope_to`).all();

describe("inbound: list address", () => {
  it("puts the mail in every member's inbox, with separate read state, and publishes once", async () => {
    const { h, deps } = setup();
    await handleInbound(deps, copyFor(LIST));
    expect(deliveries(h)).toEqual([
      { owner_user_id: "usr_alice", envelope_to: `list:${LIST}` },
      { owner_user_id: "usr_bob", envelope_to: `list:${LIST}` },
    ]);
    for (const uid of ["usr_alice", "usr_bob"]) {
      const page = await listInbound(h.db, { ownerUserId: uid, viewer: uid, limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ mine: true, read: false });
    }
    expect(h.mailAuto.sends).toHaveLength(1);
  });

  it("also delivers when the list copy is not the first copy of the mail", async () => {
    const { h, deps } = setup();
    await handleInbound(deps, copyFor(A));
    await handleInbound(deps, copyFor(LIST));
    expect((h.raw.prepare(`SELECT COUNT(*) AS c FROM mail_inbound`).get() as { c: number }).c).toBe(1);
    const page = await listInbound(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", limit: 10 });
    expect(page.items).toHaveLength(1); // Alice got it twice over; one mail in the inbox
    expect((await listInbound(h.db, { ownerUserId: "usr_bob", viewer: "usr_bob", limit: 10 })).items).toHaveLength(1);
  });

  it("a redelivered list copy adds no second delivery", async () => {
    const { h, deps } = setup();
    await handleInbound(deps, copyFor(LIST));
    await handleInbound(deps, copyFor(LIST));
    expect(deliveries(h)).toHaveLength(2);
  });

  it("does not hand the list copy to another internal address on the To: header", async () => {
    const { h, deps } = setup(["usr_alice"]);
    await handleInbound(deps, copyFor(LIST, { to: C }));
    expect(deliveries(h)).toEqual([{ owner_user_id: "usr_alice", envelope_to: `list:${LIST}` }]);
  });

  it("leaves the sender out of their own list mail", async () => {
    const { h, deps } = setup();
    await handleInbound(deps, copyFor(LIST, { from: `Alice <${A}>` }));
    expect(deliveries(h)).toEqual([{ owner_user_id: "usr_bob", envelope_to: `list:${LIST}` }]);
  });

  it("throws when the team cannot be read, keeping the stored body", async () => {
    const { h, deps } = setup("error");
    await expect(handleInbound(deps, copyFor(LIST))).rejects.toThrow();
    expect((h.raw.prepare(`SELECT COUNT(*) AS c FROM mail_inbound`).get() as { c: number }).c).toBe(1);
  });

  it("a deleted list delivers nothing further", async () => {
    const { h, deps } = setup();
    h.raw.prepare(`UPDATE mail_team_list SET deleted_at = 't'`).run();
    await handleInbound(deps, copyFor(LIST));
    expect(deliveries(h)).toEqual([]);
  });

  it("a list lookup failure other than a missing table is not swallowed", async () => {
    const { deps } = setup();
    const broken = { ...deps, db: { ...deps.db, first: async () => { throw new Error("D1_ERROR: overloaded"); } } };
    await expect(handleInbound(broken as typeof deps, copyFor(LIST))).rejects.toThrow("overloaded");
  });

  it("ordinary mail still lands when the table is missing (migration not applied)", async () => {
    const { h, deps } = setup();
    h.raw.exec(`DROP TABLE mail_team_list`);
    await handleInbound(deps, copyFor(A));
    expect(deliveries(h)).toEqual([{ owner_user_id: "usr_alice", envelope_to: A }]);
  });
});

describe("reading and replying to list mail", () => {
  it("never reports the list as the member's own address (全員に返信 keeps it)", async () => {
    const { h, deps } = setup();
    const { message } = await handleInbound(deps, copyFor(LIST));
    const detail = await getInboundDetail(h.db, message.id, "usr_bob", "usr_bob");
    expect(detail?.headerMeta?.deliveredTo).toBeUndefined();
    expect(detail?.cc).toEqual([{ email: LIST }]);
  });

  it("shows the member's own address when they were also addressed directly", async () => {
    const { h, deps } = setup();
    const { message } = await handleInbound(deps, copyFor(LIST));
    await handleInbound(deps, copyFor(A));
    const detail = await getInboundDetail(h.db, message.id, "usr_alice", "usr_alice");
    expect(detail?.headerMeta?.deliveredTo).toBe(A);
  });

  it("never shows a list-only member another recipient's envelope (a Bcc stays hidden)", async () => {
    const { h, deps } = setup();
    const { message } = await handleInbound(deps, copyFor(A)); // Alice's copy stored first
    await handleInbound(deps, copyFor(LIST));
    const detail = await getInboundDetail(h.db, message.id, "usr_bob", "usr_bob");
    expect(detail?.headerMeta?.deliveredTo).toBeUndefined();
  });

  it("an oversight reader with no copy of their own replies as themselves too", async () => {
    const { h, deps } = setup();
    await handleInbound(deps, copyFor(LIST, { to: LIST, cc: "" }));
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, ROSTER) });
    const from = await resolveReplyFromAddress(env, deps.ctx, h.db, "<list-1@partner.example>", "usr_carol");
    expect(from).toBe(C);
  });

  it("replies as the member, not as the list", async () => {
    const { h, deps } = setup();
    await handleInbound(deps, copyFor(LIST, { to: LIST, cc: "" }));
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, ROSTER) });
    const from = await resolveReplyFromAddress(env, deps.ctx, h.db, "<list-1@partner.example>", "usr_bob");
    expect(from).toBe(B);
  });
});

describe("list rules stay out of the roster", () => {
  const rule = (name: string, address: string): CfRoutingRule =>
    ({ id: name, name, enabled: true, priority: 0, matchers: [{ type: "literal", field: "to", value: address }], actions: [{ type: "worker", value: ["dub-mail-gateway"] }] }) as CfRoutingRule;
  const rules = [rule(teamListRuleInput(LIST, "design", "w").name, LIST), rule("dub-issued:sales", "sales@developershub.jp")];

  it("is neither a roster address nor an issued address", () => {
    expect(rosterAddressesFromRules(rules, "developershub.jp").map((a) => a.address)).toEqual(["sales@developershub.jp"]);
    expect(issuedAddressesFromRules(rules, "developershub.jp").map((a) => a.address)).toEqual(["sales@developershub.jp"]);
  });
});

describe("admin routes", () => {
  const app = createApp();
  const headers = { "content-type": "application/json", "x-dub-user-id": "usr_admin", "x-dub-request-id": "r" };
  const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
  const wired = (identity: Fetcher = fakeIdentityFetcher(true)) =>
    makeEnv({ SVC_IDENTITY: identity, CF_EMAIL_ROUTING_TOKEN: "t", CF_EMAIL_ROUTING_ZONE_ID: "z", CF_EMAIL_ROUTING_ACCOUNT_ID: "a", CF_EMAIL_ROUTING_ZONE_NAME: "developershub.jp" });
  const stub = (rules: unknown[], createStatus = 200) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        calls.push({ method, url, body: init.body ? JSON.parse(init.body as string) : undefined });
        if (method === "POST") return createStatus === 200 ? ok({ id: "r_new" }) : new Response("{}", { status: createStatus });
        return ok(method === "GET" ? rules : { id: "r_new" });
      }),
    );
    return calls;
  };
  const post = (env: unknown, body: unknown) =>
    app.fetch(new Request("https://svc/mail/admin/lists", { method: "POST", headers, body: JSON.stringify(body) }), env as never);

  afterEach(() => vi.unstubAllGlobals());

  it("creates a list: row + dub-list: rule, then lists and deletes it", async () => {
    const calls = stub([]);
    const { env } = wired();
    const res = await post(env, { localPart: "Design", teamId: "team_design" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; address: string; teamId: string };
    expect(created).toMatchObject({ address: LIST, teamId: "team_design" });
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ name: "dub-list:design", actions: [{ type: "worker" }] });

    const listed = await app.fetch(new Request("https://svc/mail/admin/lists", { headers }), env);
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1);

    stub([{ id: "r_new" }]);
    const del = await app.fetch(new Request(`https://svc/mail/admin/lists/${created.id}`, { method: "DELETE", headers }), env);
    expect(del.status).toBe(200);
    const after = await app.fetch(new Request("https://svc/mail/admin/lists", { headers }), env);
    expect(((await after.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("409 when the address already has a rule or belongs to a person", async () => {
    stub([{ id: "r1", name: "dub-issued:design", matchers: [{ type: "literal", field: "to", value: LIST }], actions: [] }]);
    expect((await post(wired().env, { localPart: "design", teamId: "t" })).status).toBe(409);
    stub([]);
    const { env } = wired(fakeIdentityFetcher(true, { usr_d: { email: LIST } }));
    expect((await post(env, { localPart: "design", teamId: "t" })).status).toBe(409);
  });

  it("refuses the archive and shared addresses", async () => {
    stub([]);
    const { env } = wired();
    expect((await post(env, { localPart: "archive", teamId: "t" })).status).toBe(409);
    expect((await post(env, { localPart: "info", teamId: "t" })).status).toBe(409);
  });

  it("clears a leftover dub-list: rule with no live row and creates the list", async () => {
    const calls = stub([{ id: "r_old", name: "dub-list:design", matchers: [{ type: "literal", field: "to", value: LIST }], actions: [] }]);
    expect((await post(wired().env, { localPart: "design", teamId: "t" })).status).toBe(201);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/r_old"))).toBe(true);
  });

  it("leaves no live row behind when Cloudflare refuses the rule", async () => {
    stub([], 500);
    const { env, raw } = wired();
    expect((await post(env, { localPart: "design", teamId: "t" })).status).toBe(502);
    expect(raw.prepare(`SELECT COUNT(*) AS c FROM mail_team_list WHERE deleted_at IS NULL`).get()).toEqual({ c: 0 });
  });

  it("400 without a team", async () => {
    stub([]);
    expect((await post(wired().env, { localPart: "design" })).status).toBe(400);
  });
});
