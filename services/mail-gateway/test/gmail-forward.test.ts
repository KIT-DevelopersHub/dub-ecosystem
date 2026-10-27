import { describe, it, expect } from "vitest";
import type { Fetcher, ForwardableEmailMessage } from "@cloudflare/workers-types";
import handler from "../src/index";
import { FORWARDED_HEADER, ORIGINAL_RCPT_HEADER, forwardToArchive, forwardToLinkedGmail, gmailForwardEnabled, maskEmail, type GmailForwardDeps } from "../src/gmail-forward";
import type { RawInbound } from "../src/mime";
import { ctx, fakeIdentityFetcher, makeEnv, makeHarness } from "./helpers";

const ROSTER = {
  usr_alice: { email: "alice@developershub.jp" },
  usr_bob: { email: "bob@developershub.jp" },
  usr_nogmail: { email: "carol@developershub.jp" },
};
const GMAIL: Record<string, string | null> = {
  usr_alice: "alice.personal@gmail.com",
  usr_bob: "Bob.Personal@gmail.com",
  usr_nogmail: null,
};

/** member-service /members/internal/google-emails fake. */
function memberFetcher(map: Record<string, string | null> = GMAIL): Fetcher {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname !== "/members/internal/google-emails") return new Response("nf", { status: 404 });
      const { userIds } = (await req.json()) as { userIds: string[] };
      const items = userIds.filter((id) => id in map).map((id) => ({ userId: id, gmail: map[id], name: id }));
      return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
}

function rawFor(to: string, over: Partial<RawInbound> = {}, headers: Record<string, string> = {}): RawInbound {
  return {
    from: "sender@outside.com",
    to,
    headers: {
      "message-id": "<m1@outside.com>",
      from: "Sender <sender@outside.com>",
      to: "alice@developershub.jp",
      cc: "bob@developershub.jp",
      subject: "hello",
      ...headers,
    },
    rawText: "Subject: hello\r\n\r\nbody",
    rawSize: 64,
    ...over,
  };
}

function recorder(fail?: Error) {
  const calls: { to: string; headers: Headers | undefined }[] = [];
  return {
    calls,
    forwarder: {
      async forward(to: string, headers?: Headers) {
        calls.push({ to, headers });
        if (fail) throw fail;
      },
    },
  };
}

function fwdDeps(over: Partial<GmailForwardDeps> = {}): GmailForwardDeps {
  const h = makeHarness();
  return {
    identity: fakeIdentityFetcher(true, ROSTER),
    member: memberFetcher(),
    audit: h.audit,
    orgId: "org_devhub",
    ctx: ctx("req_fwd"),
    archiveAddress: "archive@developershub.jp",
    internalDomain: "developershub.jp",
    ...over,
  };
}

describe("gmailForwardEnabled / maskEmail", () => {
  it("is OFF unless the flag is exactly on", () => {
    expect(gmailForwardEnabled(undefined)).toBe(false);
    expect(gmailForwardEnabled("")).toBe(false);
    expect(gmailForwardEnabled("true")).toBe(false);
    expect(gmailForwardEnabled("on")).toBe(true);
    expect(gmailForwardEnabled(" ON ")).toBe(true);
  });
  it("masks personal addresses", () => {
    expect(maskEmail("alice.personal@gmail.com")).toBe("a***@gmail.com");
  });
});

describe("forwardToLinkedGmail", () => {
  it("forwards to the envelope recipient's own Gmail with the loop header", async () => {
    const r = recorder();
    const out = await forwardToLinkedGmail(fwdDeps(), r.forwarder, rawFor("alice@developershub.jp"));
    expect(out).toEqual({ status: "forwarded", userId: "usr_alice" });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.to).toBe("alice.personal@gmail.com");
    expect(r.calls[0]!.headers?.get(FORWARDED_HEADER)).toBe("1");
  });

  it("multi-recipient: each envelope invocation forwards once, to that recipient only", async () => {
    // Email Routing calls email() once per envelope recipient (alice To:, bob CC:).
    const r = recorder();
    const deps = fwdDeps();
    await forwardToLinkedGmail(deps, r.forwarder, rawFor("alice@developershub.jp"));
    await forwardToLinkedGmail(deps, r.forwarder, rawFor("bob@developershub.jp"));
    expect(r.calls.map((c) => c.to)).toEqual(["alice.personal@gmail.com", "bob.personal@gmail.com"]);
  });

  it("skips users without a linked Gmail, non-roster addresses and the archive", async () => {
    const r = recorder();
    const deps = fwdDeps();
    expect(await forwardToLinkedGmail(deps, r.forwarder, rawFor("carol@developershub.jp"))).toEqual({ status: "skipped", reason: "no_linked_gmail" });
    expect(await forwardToLinkedGmail(deps, r.forwarder, rawFor("nobody@developershub.jp"))).toEqual({ status: "skipped", reason: "no_roster_user" });
    expect(await forwardToLinkedGmail(deps, r.forwarder, rawFor("archive@developershub.jp"))).toEqual({ status: "skipped", reason: "archive" });
    expect(r.calls).toHaveLength(0);
  });

  it("loop guard: skips a copy already carrying X-Dub-Forwarded", async () => {
    const r = recorder();
    const out = await forwardToLinkedGmail(fwdDeps(), r.forwarder, rawFor("alice@developershub.jp", {}, { "x-dub-forwarded": "1" }));
    expect(out).toEqual({ status: "skipped", reason: "already_forwarded" });
    expect(r.calls).toHaveLength(0);
  });

  it("loop guard: skips mail sent from the target Gmail itself", async () => {
    const r = recorder();
    const out = await forwardToLinkedGmail(
      fwdDeps(),
      r.forwarder,
      rawFor("alice@developershub.jp", { from: "alice.personal@gmail.com" }, { from: "Alice <Alice.Personal@gmail.com>" }),
    );
    expect(out).toEqual({ status: "skipped", reason: "from_target" });
    expect(r.calls).toHaveLength(0);
  });

  it("loop guard: never forwards back into our own zone", async () => {
    const r = recorder();
    const deps = fwdDeps({ member: memberFetcher({ usr_alice: "alias@developershub.jp" }) });
    const out = await forwardToLinkedGmail(deps, r.forwarder, rawFor("alice@developershub.jp"));
    expect(out).toEqual({ status: "skipped", reason: "internal_target" });
    expect(r.calls).toHaveLength(0);
  });

  it("a rejecting forward() is recorded as failed (audited), never thrown", async () => {
    const h = makeHarness();
    const r = recorder(new Error("destination address not verified"));
    const out = await forwardToLinkedGmail(fwdDeps({ audit: h.audit }), r.forwarder, rawFor("alice@developershub.jp"));
    expect(out).toMatchObject({ status: "failed", userId: "usr_alice" });
    expect(h.auditQ.sends).toHaveLength(1);
    const rec = h.auditQ.sends[0]!.payload;
    expect(rec).toMatchObject({ action: "mail.message.forward_gmail", result: "failure", resourceId: "usr_alice" });
    expect(rec.details).toMatchObject({ target: "a***@gmail.com" });
    expect(JSON.stringify(rec)).not.toContain("alice.personal@gmail.com");
  });

  it("a member-service outage degrades to skipped, never thrown", async () => {
    const broken = { async fetch() { throw new Error("down"); } } as unknown as Fetcher;
    const r = recorder();
    const out = await forwardToLinkedGmail(fwdDeps({ member: broken }), r.forwarder, rawFor("alice@developershub.jp"));
    expect(out.status).toBe("skipped");
    expect(r.calls).toHaveLength(0);
  });
});

// ---- Worker email() handler: store-then-forward wiring ----

function fakeMessage(to: string, fail?: Error | ((rcpt: string) => Error | undefined), opts: { messageId?: string | null; from?: string } = {}) {
  const messageId = opts.messageId === undefined ? "<wire-1@outside.com>" : opts.messageId;
  const from = opts.from ?? "sender@outside.com";
  const text = `${messageId ? `Message-ID: ${messageId}\r\n` : ""}From: ${from}\r\nTo: alice@developershub.jp\r\nSubject: wire\r\n\r\nbody`;
  const bytes = new TextEncoder().encode(text);
  const calls: string[] = [];
  const sentHeaders: (Headers | undefined)[] = [];
  const headers = new Headers({ from, to: "alice@developershub.jp", subject: "wire" });
  if (messageId) headers.set("message-id", messageId);
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
      calls.push(rcpt);
      sentHeaders.push(h);
      const err = typeof fail === "function" ? fail(rcpt) : fail;
      if (err) throw err;
    },
    setReject() {},
    async reply() {},
  };
  return { msg: msg as unknown as ForwardableEmailMessage, calls, sentHeaders };
}

function inboundCount(raw: ReturnType<typeof makeEnv>["raw"]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM mail_inbound`).get() as { n: number }).n;
}

describe("email() handler", () => {
  const services = { SVC_IDENTITY: fakeIdentityFetcher(true, ROSTER), SVC_MEMBER: memberFetcher() };

  it("flag off (default): stores, forwards nothing", async () => {
    const { env, raw } = makeEnv(services);
    const { msg, calls } = fakeMessage("alice@developershub.jp");
    await handler.email(msg, env);
    expect(inboundCount(raw)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("flag on: stores, then forwards to the linked Gmail", async () => {
    const { env, raw } = makeEnv({ ...services, MAIL_GMAIL_FORWARD: "on" });
    const { msg, calls } = fakeMessage("alice@developershub.jp");
    await handler.email(msg, env);
    expect(inboundCount(raw)).toBe(1);
    expect(calls).toEqual(["alice.personal@gmail.com"]);
  });

  it("flag on: storage still happens and email() resolves when forward throws", async () => {
    const { env, raw } = makeEnv({ ...services, MAIL_GMAIL_FORWARD: "on" });
    const { msg, calls } = fakeMessage("alice@developershub.jp", new Error("not verified"));
    await expect(handler.email(msg, env)).resolves.toBeUndefined();
    expect(inboundCount(raw)).toBe(1);
    expect(calls).toEqual(["alice.personal@gmail.com"]);
  });

  it("flag on: a second envelope recipient (same Message-ID) still gets its own forward", async () => {
    const { env, raw } = makeEnv({ ...services, MAIL_GMAIL_FORWARD: "on" });
    const a = fakeMessage("alice@developershub.jp");
    const b = fakeMessage("bob@developershub.jp");
    await handler.email(a.msg, env);
    await handler.email(b.msg, env);
    expect(inboundCount(raw)).toBe(1); // deduped by Message-ID (existing behaviour)
    expect(a.calls).toEqual(["alice.personal@gmail.com"]);
    expect(b.calls).toEqual(["bob.personal@gmail.com"]);
  });
});

// ---- Archive forward (MAIL_ARCHIVE_FORWARD_TO) ----

const ARCHIVE = "dub.developershub@gmail.com";

describe("email() handler: archive forward", () => {
  const services = { SVC_IDENTITY: fakeIdentityFetcher(true, ROSTER), SVC_MEMBER: memberFetcher() };

  it("forwards once per Message-ID across recipient invocations, with MAIL_GMAIL_FORWARD off", async () => {
    const { env, raw } = makeEnv({ ...services, MAIL_ARCHIVE_FORWARD_TO: ARCHIVE });
    const a = fakeMessage("alice@developershub.jp");
    const b = fakeMessage("bob@developershub.jp");
    await handler.email(a.msg, env);
    await handler.email(b.msg, env);
    expect(inboundCount(raw)).toBe(1);
    expect(a.calls).toEqual([ARCHIVE]); // no Gmail forward: flag off
    expect(b.calls).toEqual([]); // same Message-ID -> no second archive copy
    expect(a.sentHeaders[0]?.get(ORIGINAL_RCPT_HEADER)).toBe("alice@developershub.jp");
    expect(a.sentHeaders[0]?.get(FORWARDED_HEADER)).toBe("archive");
  });

  it("forwards every invocation when the Message-ID is missing", async () => {
    const { env } = makeEnv({ ...services, MAIL_ARCHIVE_FORWARD_TO: ARCHIVE });
    const a = fakeMessage("alice@developershub.jp", undefined, { messageId: null });
    const b = fakeMessage("bob@developershub.jp", undefined, { messageId: null });
    await handler.email(a.msg, env);
    await handler.email(b.msg, env);
    expect(a.calls).toEqual([ARCHIVE]);
    expect(b.calls).toEqual([ARCHIVE]);
  });

  it("unverified archive (forward rejects): stored, audited as failure, email() resolves", async () => {
    const { env, raw, sends } = makeEnv({ ...services, MAIL_ARCHIVE_FORWARD_TO: ARCHIVE });
    const m = fakeMessage("alice@developershub.jp", new Error("destination address not verified"));
    await expect(handler.email(m.msg, env)).resolves.toBeUndefined();
    expect(inboundCount(raw)).toBe(1);
    const rec = sends.audit.map((e) => e.payload).find((p) => p.action === "mail.message.forward_archive");
    expect(rec).toMatchObject({ result: "failure", resourceId: "wire-1@outside.com", details: { target: "d***@gmail.com" } });
    expect(JSON.stringify(sends.audit)).not.toContain(ARCHIVE);
  });

  it("archive and Gmail forwards are independent (one failing does not stop the other)", async () => {
    const { env } = makeEnv({ ...services, MAIL_ARCHIVE_FORWARD_TO: ARCHIVE, MAIL_GMAIL_FORWARD: "on" });
    const m = fakeMessage("alice@developershub.jp", (rcpt) => (rcpt === ARCHIVE ? new Error("not verified") : undefined));
    await handler.email(m.msg, env);
    expect(m.calls).toEqual([ARCHIVE, "alice.personal@gmail.com"]);
  });

  it("unset = no archive forward", async () => {
    const { env } = makeEnv(services);
    const m = fakeMessage("alice@developershub.jp");
    await handler.email(m.msg, env);
    expect(m.calls).toEqual([]);
  });
});

describe("forwardToArchive loop guard", () => {
  const deps = () => ({ audit: makeHarness().audit, orgId: "org_devhub", ctx: ctx("req_arc"), archiveTo: ARCHIVE });

  it("skips a copy already carrying X-Dub-Forwarded", async () => {
    const r = recorder();
    const out = await forwardToArchive(deps(), r.forwarder, rawFor("alice@developershub.jp", {}, { "x-dub-forwarded": "1" }), { firstCopy: true });
    expect(out).toEqual({ status: "skipped", reason: "already_forwarded" });
    expect(r.calls).toHaveLength(0);
  });

  it("skips mail sent from the archive address itself", async () => {
    const r = recorder();
    const out = await forwardToArchive(deps(), r.forwarder, rawFor("alice@developershub.jp", { from: ARCHIVE }, { from: `Archive <${ARCHIVE}>` }), { firstCopy: true });
    expect(out).toEqual({ status: "skipped", reason: "from_target" });
    expect(r.calls).toHaveLength(0);
  });

  it("skips a later recipient's copy of an already-archived Message-ID", async () => {
    const r = recorder();
    const out = await forwardToArchive(deps(), r.forwarder, rawFor("bob@developershub.jp"), { firstCopy: false });
    expect(out).toEqual({ status: "skipped", reason: "duplicate_recipient_copy" });
    expect(r.calls).toHaveLength(0);
  });
});
