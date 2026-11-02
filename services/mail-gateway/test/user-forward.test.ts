// Per-user opt-in auto-forward (Gmail 自動転送, 0023): settings API, Cloudflare destination
// verification as the ownership proof, inbound forwarding + its guards, and the cron sweep.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import type { mail } from "@dub/types";
import handler from "../src/index";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { FORWARDED_HEADER } from "../src/gmail-forward";
import { scrubError, sweepPendingForwards } from "../src/user-forward";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const app = createApp();
const USERS = {
  usr_alice: { email: "alice@developershub.jp" },
  usr_bob: { email: "bob@developershub.jp" },
};
const GMAIL = "alice.personal@gmail.com";

interface CfAddr {
  id: string;
  email: string;
  verified: string | null;
}
interface CfRule {
  actions: { type: string; value?: string[] }[];
}

/** Stateful Cloudflare Email Routing fake (destination addresses + rules). */
function stubCf(init: { addresses?: CfAddr[]; rules?: CfRule[] } = {}) {
  const addresses = [...(init.addresses ?? [])];
  const rules = init.rules ?? [];
  const calls: string[] = [];
  let seq = 0;
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req: RequestInit) => {
      const u = new URL(url);
      const method = req.method ?? "GET";
      calls.push(`${method} ${u.pathname}`);
      const m = /\/email\/routing\/addresses(?:\/([^/]+))?$/.exec(u.pathname);
      if (m && method === "GET" && !m[1]) return ok(addresses);
      if (m && method === "GET" && m[1]) {
        const a = addresses.find((x) => x.id === m[1]);
        return a ? ok(a) : new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
      }
      if (m && method === "POST") {
        const { email } = JSON.parse(String(req.body)) as { email: string };
        const a = { id: `dst_${++seq}`, email, verified: null };
        addresses.push(a);
        return ok(a);
      }
      if (m && method === "DELETE" && m[1]) {
        const i = addresses.findIndex((x) => x.id === m[1]);
        const [a] = addresses.splice(i, 1);
        return ok(a);
      }
      if (u.pathname.endsWith("/email/routing/rules")) return ok(rules);
      return new Response("nf", { status: 404 });
    }),
  );
  return { addresses, calls, verify: (email: string) => addresses.filter((a) => a.email === email).forEach((a) => (a.verified = "2026-11-02T00:00:00Z")) };
}

afterEach(() => vi.unstubAllGlobals());

function wiredEnv(over: Partial<Env> = {}) {
  return makeEnv({
    SVC_IDENTITY: fakeIdentityFetcher(true, USERS),
    CF_EMAIL_ROUTING_TOKEN: "cf-secret",
    CF_EMAIL_ROUTING_ZONE_ID: "zone_1",
    CF_EMAIL_ROUTING_ACCOUNT_ID: "acc_1",
    MAIL_ARCHIVE_FORWARD_TO: "dub.developershub@gmail.com",
    ...over,
  });
}

const headers = (user: string) => ({ "content-type": "application/json", "x-dub-request-id": "req_fwd", "x-dub-user-id": user });
const call = (env: Env, user: string, method: string, body?: unknown) =>
  app.fetch(new Request("https://svc/mail/forward", { method, headers: headers(user), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
const json = async (res: Response) => (await res.json()) as mail.MailForwardSetting & { error?: { code: string } };

function setRow(env: Env, sql: string, ...args: unknown[]) {
  return createDbClient(env.DB, { namespace: "mail" }).run(sql, ...args);
}

describe("settings API", () => {
  it("GET: nothing registered = status none, available when Email Routing is wired", async () => {
    const { env } = wiredEnv();
    const s = await json(await call(env, "usr_alice", "GET"));
    expect(s).toMatchObject({ target: null, status: "none", enabled: false, active: false, available: true });
  });

  it("GET: available=false without the Email Routing token or with the kill switch", async () => {
    expect((await json(await call(makeEnv().env, "usr_alice", "GET"))).available).toBe(false);
    expect((await json(await call(wiredEnv({ MAIL_USER_FORWARD: "off" }).env, "usr_alice", "GET"))).available).toBe(false);
  });

  it("PUT registers: creates a Cloudflare destination (verification mail) and is pending, not active", async () => {
    const cf = stubCf();
    const { env } = wiredEnv();
    const res = await call(env, "usr_alice", "PUT", { target: "  Alice.Personal@Gmail.com " });
    expect(res.status).toBe(200);
    const s = await json(res);
    expect(s).toMatchObject({ target: GMAIL, status: "pending", enabled: true, active: false });
    expect(cf.addresses.map((a) => a.email)).toEqual([GMAIL]);
  });

  it("GET after the user clicked Cloudflare's link: verified + active", async () => {
    const cf = stubCf();
    const { env } = wiredEnv();
    await call(env, "usr_alice", "PUT", { target: GMAIL });
    cf.verify(GMAIL);
    const s = await json(await call(env, "usr_alice", "GET"));
    expect(s).toMatchObject({ status: "verified", enabled: true, active: true });
    expect(s.verifiedAt).not.toBeNull();
  });

  it("an already-verified destination is re-created, so THIS user must verify it again", async () => {
    const cf = stubCf({ addresses: [{ id: "old", email: GMAIL, verified: "2026-01-01T00:00:00Z" }] });
    const { env } = wiredEnv();
    const s = await json(await call(env, "usr_alice", "PUT", { target: GMAIL }));
    expect(s.status).toBe("pending");
    expect(cf.addresses).toHaveLength(1);
    expect(cf.addresses[0]).toMatchObject({ email: GMAIL, verified: null });
    expect(cf.calls).toContain("DELETE /client/v4/accounts/acc_1/email/routing/addresses/old");
  });

  it("409 when the verified destination is used by an Email Routing forward rule (left untouched)", async () => {
    const cf = stubCf({ addresses: [{ id: "old", email: GMAIL, verified: "2026-01-01T00:00:00Z" }], rules: [{ actions: [{ type: "forward", value: [GMAIL] }] }] });
    const { env } = wiredEnv();
    const res = await call(env, "usr_alice", "PUT", { target: GMAIL });
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("MAIL_FORWARD_TARGET_IN_USE");
    expect(cf.addresses[0]!.id).toBe("old");
  });

  it("rejects bad / internal / own / archive targets", async () => {
    stubCf();
    const { env } = wiredEnv();
    expect((await call(env, "usr_alice", "PUT", { target: "nope" })).status).toBe(400);
    expect((await call(env, "usr_alice", "PUT", {})).status).toBe(400);
    expect((await call(env, "usr_alice", "PUT", { target: "bob@developershub.jp" })).status).toBe(400);
    expect((await call(env, "usr_alice", "PUT", { target: "x@mail.developershub.jp" })).status).toBe(400);
    expect((await call(env, "usr_alice", "PUT", { target: "dub.developershub@gmail.com" })).status).toBe(409);
  });

  it("409 when another account already registered the same address", async () => {
    stubCf();
    const { env } = wiredEnv();
    expect((await call(env, "usr_alice", "PUT", { target: GMAIL })).status).toBe(200);
    expect((await call(env, "usr_bob", "PUT", { target: GMAIL })).status).toBe(409);
  });

  it("rate limits: 60s cooldown and a daily cap on verification mails", async () => {
    stubCf();
    const { env } = wiredEnv();
    expect((await call(env, "usr_alice", "PUT", { target: GMAIL })).status).toBe(200);
    expect((await call(env, "usr_alice", "PUT", { target: GMAIL })).status).toBe(429);
    const today = new Date().toISOString().slice(0, 10);
    await setRow(env, `UPDATE mail_user_forward SET requested_at = '2000-01-01T00:00:00.000Z', register_day = ?, register_count = 5`, today);
    expect((await call(env, "usr_alice", "PUT", { target: GMAIL })).status).toBe(429);
  });

  it("503 when Email Routing is not configured or the feature is switched off", async () => {
    expect((await call(makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, USERS) }).env, "usr_alice", "PUT", { target: GMAIL })).status).toBe(503);
    expect((await call(wiredEnv({ MAIL_USER_FORWARD: "off" }).env, "usr_alice", "PUT", { target: GMAIL })).status).toBe(503);
  });

  it("PATCH toggles, DELETE forgets (soft); both 404 with nothing registered; audited", async () => {
    stubCf();
    const { env, sends } = wiredEnv();
    expect((await call(env, "usr_alice", "PATCH", { enabled: false })).status).toBe(404);
    await call(env, "usr_alice", "PUT", { target: GMAIL });
    expect((await json(await call(env, "usr_alice", "PATCH", { enabled: false }))).enabled).toBe(false);
    expect((await call(env, "usr_alice", "PATCH", { enabled: "yes" })).status).toBe(400);
    expect((await json(await call(env, "usr_alice", "DELETE"))).status).toBe("none");
    expect((await call(env, "usr_alice", "DELETE")).status).toBe(404);
    const actions = sends.audit.map((a) => `${a.payload.action}:${a.payload.result}`);
    expect(actions).toContain("mail.user_forward.register:success");
    expect(actions).toContain("mail.user_forward.update:success");
    expect(actions).toContain("mail.user_forward.delete:success");
    // the address is freed for another account after removal
    expect((await call(env, "usr_bob", "PUT", { target: GMAIL })).status).toBe(200);
  });

  it("settings are personal: bob never sees alice's address", async () => {
    stubCf();
    const { env } = wiredEnv();
    await call(env, "usr_alice", "PUT", { target: GMAIL });
    expect((await json(await call(env, "usr_bob", "GET"))).target).toBeNull();
  });
});

// ---- inbound ----

function fakeMessage(to: string, opts: { from?: string; fail?: Error; extraHeaders?: Record<string, string> } = {}) {
  const from = opts.from ?? "sender@outside.com";
  const text = `Message-ID: <m-${Math.random()}@outside.com>\r\nFrom: ${from}\r\nTo: ${to}\r\nSubject: hi\r\n\r\nbody`;
  const bytes = new TextEncoder().encode(text);
  const calls: { to: string; headers?: Headers }[] = [];
  const headers = new Headers({ from, to, subject: "hi", "message-id": `<m-${Math.random()}@outside.com>`, ...opts.extraHeaders });
  const msg = {
    from,
    to,
    headers,
    raw: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    rawSize: bytes.byteLength,
    async forward(rcpt: string, h?: Headers) {
      calls.push({ to: rcpt, headers: h });
      if (opts.fail) throw opts.fail;
    },
    setReject() {},
    async reply() {},
  };
  return { msg: msg as unknown as ForwardableEmailMessage, calls };
}

async function seed(env: Env, row: { owner?: string; target?: string; enabled?: 0 | 1; verified?: boolean }) {
  const ts = "2026-11-01T00:00:00.000Z";
  await setRow(
    env,
    `INSERT INTO mail_user_forward (owner_user_id, target, cf_address_id, enabled, requested_at, verified_at, register_count, created_at, updated_at) VALUES (?, ?, 'dst_x', ?, ?, ?, 1, ?, ?)`,
    row.owner ?? "usr_alice",
    row.target ?? GMAIL,
    row.enabled ?? 1,
    ts,
    row.verified === false ? null : ts,
    ts,
    ts,
  );
}

const inboundEnv = (over: Partial<Env> = {}) => makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, USERS), ...over });
const count = (raw: ReturnType<typeof makeEnv>["raw"]) => (raw.prepare(`SELECT COUNT(*) AS n FROM mail_inbound`).get() as { n: number }).n;

describe("inbound forward", () => {
  it("verified + on: stores first, then forwards to the user's address with the loop-guard header", async () => {
    const { env, raw, sends } = inboundEnv();
    await seed(env, {});
    const { msg, calls } = fakeMessage("alice@developershub.jp");
    await handler.email(msg, env);
    expect(count(raw)).toBe(1);
    expect(calls.map((c) => c.to)).toEqual([GMAIL]);
    expect(calls[0]!.headers?.get(FORWARDED_HEADER)).toBe("user");
    const row = raw.prepare(`SELECT last_result FROM mail_user_forward`).get() as { last_result: string };
    expect(row.last_result).toBe("forwarded");
    expect(sends.audit.some((a) => a.payload.action === "mail.message.forward_user" && a.payload.result === "success")).toBe(true);
  });

  it("only the envelope recipient's own setting applies (bob's mail is not sent to alice)", async () => {
    const { env } = inboundEnv();
    await seed(env, {});
    const { msg, calls } = fakeMessage("bob@developershub.jp");
    await handler.email(msg, env);
    expect(calls).toEqual([]);
  });

  it.each([
    ["unverified", { verified: false }],
    ["switched off", { enabled: 0 as const }],
  ])("%s: nothing is forwarded", async (_n, row) => {
    const { env, raw } = inboundEnv();
    await seed(env, row);
    const { msg, calls } = fakeMessage("alice@developershub.jp");
    await handler.email(msg, env);
    expect(count(raw)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("kill switch MAIL_USER_FORWARD=off stops forwarding", async () => {
    const { env } = inboundEnv({ MAIL_USER_FORWARD: "off" });
    await seed(env, {});
    const { msg, calls } = fakeMessage("alice@developershub.jp");
    await handler.email(msg, env);
    expect(calls).toEqual([]);
  });

  it("loop guards: already-forwarded copies and mail sent from the target are skipped", async () => {
    const { env } = inboundEnv();
    await seed(env, {});
    const a = fakeMessage("alice@developershub.jp", { extraHeaders: { [FORWARDED_HEADER]: "user" } });
    await handler.email(a.msg, env);
    const b = fakeMessage("alice@developershub.jp", { from: GMAIL });
    await handler.email(b.msg, env);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  it("a failing forward never blocks storage; the error is stored without addresses", async () => {
    const { env, raw } = inboundEnv();
    await seed(env, {});
    const { msg } = fakeMessage("alice@developershub.jp", { fail: new Error(`destination ${GMAIL} not verified`) });
    await expect(handler.email(msg, env)).resolves.toBeUndefined();
    expect(count(raw)).toBe(1);
    const row = raw.prepare(`SELECT last_result, last_error FROM mail_user_forward`).get() as { last_result: string; last_error: string };
    expect(row.last_result).toBe("failed");
    expect(row.last_error).not.toContain(GMAIL);
  });

  it("an opt-in registration (even off) suppresses the legacy 名簿 Gmail forward", async () => {
    const legacy = {
      async fetch() {
        return new Response(JSON.stringify({ items: [{ userId: "usr_alice", gmail: "legacy@gmail.com" }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const { env } = inboundEnv({ MAIL_GMAIL_FORWARD: "on", SVC_MEMBER: legacy as never });
    await seed(env, { enabled: 0 });
    const off = fakeMessage("alice@developershub.jp");
    await handler.email(off.msg, env);
    expect(off.calls).toEqual([]);
    // no registration at all -> legacy behaviour unchanged
    const { env: env2 } = inboundEnv({ MAIL_GMAIL_FORWARD: "on", SVC_MEMBER: legacy as never });
    const none = fakeMessage("alice@developershub.jp");
    await handler.email(none.msg, env2);
    expect(none.calls.map((c) => c.to)).toEqual(["legacy@gmail.com"]);
  });
});

describe("cron sweep + helpers", () => {
  it("verifies pending registrations whose Cloudflare destination got verified", async () => {
    const cf = stubCf();
    const { env, raw } = wiredEnv();
    await call(env, "usr_alice", "PUT", { target: GMAIL });
    expect(await sweepPendingForwards(createDbClient(env.DB, { namespace: "mail" }), env)).toBe(0);
    cf.verify(GMAIL);
    expect(await sweepPendingForwards(createDbClient(env.DB, { namespace: "mail" }), env)).toBe(1);
    expect((raw.prepare(`SELECT verified_at FROM mail_user_forward`).get() as { verified_at: string | null }).verified_at).not.toBeNull();
  });

  it("scrubError masks addresses and caps length", () => {
    expect(scrubError("to a@b.com failed")).toBe("to (address) failed");
    expect(scrubError("x".repeat(500))).toHaveLength(200);
  });
});
