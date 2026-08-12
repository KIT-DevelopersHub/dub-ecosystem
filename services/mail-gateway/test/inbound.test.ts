import { describe, it, expect } from "vitest";
import { handleInbound, parseInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { getInboundById, getInboundDetail, listInbound } from "../src/repo";
import { makeHarness, inboundDeps } from "./helpers";

function rawMessage(over: Partial<RawInbound> = {}, headers: Record<string, string> = {}): RawInbound {
  return {
    from: "sender@outside.com",
    to: "info@developershub.jp",
    headers: {
      "message-id": "<inbound-1@outside.com>",
      from: "Sender Name <sender@outside.com>",
      to: "info@developershub.jp",
      subject: "Question",
      date: "Sat, 09 Aug 2026 05:00:00 +0000",
      ...headers,
    },
    rawText: "Message-ID: <inbound-1@outside.com>\r\nSubject: Question\r\n\r\nHi, I have a question.",
    rawSize: 512,
    ...over,
  };
}

describe("parseInbound", () => {
  it("normalizes into the frozen MailMessage DTO", () => {
    const parsed = parseInbound(rawMessage());
    expect(parsed.message.messageId).toBe("inbound-1@outside.com");
    expect(parsed.message.threadId).toBe("inbound-1@outside.com"); // new thread
    expect(parsed.message.from).toEqual({ email: "sender@outside.com", name: "Sender Name" });
    expect(parsed.message.subject).toBe("Question");
    expect(parsed.message.snippet).toContain("I have a question");
    expect(parsed.mailbox).toBe("info");
  });

  it("derives threadId from References, then In-Reply-To", () => {
    const withRefs = parseInbound(rawMessage({}, { references: "<root@x.com> <mid2@x.com>" }));
    expect(withRefs.message.threadId).toBe("root@x.com");
    const withInReplyTo = parseInbound(rawMessage({}, { "in-reply-to": "<parent@x.com>" }));
    expect(withInReplyTo.message.threadId).toBe("parent@x.com");
  });

  it("decodes an RFC2047 Japanese subject", () => {
    const parsed = parseInbound(rawMessage({}, { subject: "=?UTF-8?B?6LOq5ZWP?=" }));
    expect(parsed.message.subject).toBe("質問");
  });

  it("captures loop-prevention headers as passthrough (no logic here)", () => {
    const parsed = parseInbound(rawMessage({}, { "auto-submitted": "auto-replied", "x-dub-mail-loop": "1" }));
    expect(parsed.loop["auto-submitted"]).toBe("auto-replied");
    expect(parsed.loop["x-dub-mail-loop"]).toBe("1");
  });
});

describe("handleInbound", () => {
  it("persists + publishes mail.message.received exactly once", async () => {
    const h = makeHarness();
    const deps = inboundDeps(h);
    const res = await handleInbound(deps, rawMessage());
    expect(res.processed).toBe(true);

    expect(h.mailAuto.sends).toHaveLength(1);
    expect(h.mailAuto.sends[0]!.name).toBe("mail.message.received");
    expect(h.mailAuto.sends[0]!.payload).toEqual({ messageId: "inbound-1@outside.com", threadId: "inbound-1@outside.com" });
    expect(h.mailAuto.sends[0]!.actorId).toBeNull(); // system origin

    const page = await listInbound(h.db, { ownerUserId: "usr_info", limit: 10 });
    expect(page.items).toHaveLength(1);
    const stored = await getInboundById(h.db, page.items[0]!.id);
    expect(stored?.messageId).toBe("inbound-1@outside.com");
  });

  it("persists the plain-text body (unread) for the detail view", async () => {
    const h = makeHarness();
    await handleInbound(inboundDeps(h), rawMessage());
    const page = await listInbound(h.db, { ownerUserId: "usr_info", limit: 10 });
    const detail = await getInboundDetail(h.db, page.items[0]!.id, "usr_info");
    expect(detail?.textBody).toContain("I have a question");
    expect(detail?.read).toBe(false); // fresh inbound is unread
    expect(detail?.htmlBody).toBeUndefined(); // Email Routing text-only in this slice
  });

  it("dedups an Email-Routing redelivery — no second publish (受信取りこぼしゼロ, no double-process)", async () => {
    const h = makeHarness();
    const deps = inboundDeps(h);
    await handleInbound(deps, rawMessage());
    const second = await handleInbound(deps, rawMessage());
    expect(second.processed).toBe(false);
    expect(h.mailAuto.sends).toHaveLength(1);

    const page = await listInbound(h.db, { ownerUserId: "usr_info", limit: 10 });
    expect(page.items).toHaveLength(1);
  });

  it("keeps distinct messages in the same thread and lists them by thread", async () => {
    const h = makeHarness();
    const deps = inboundDeps(h);
    await handleInbound(deps, rawMessage({}, { "message-id": "<a@x.com>", references: "<root@x.com>" }));
    await handleInbound(deps, rawMessage({}, { "message-id": "<b@x.com>", references: "<root@x.com>" }));
    const thread = await listInbound(h.db, { ownerUserId: "usr_info", threadId: "root@x.com", limit: 10 });
    expect(thread.items).toHaveLength(2);
  });
});
