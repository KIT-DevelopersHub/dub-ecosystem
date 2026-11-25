// Sent → conversation (Gmail parity): a send that got answered must carry its conversation
// summary in the Sent list, keyed by the same thread id the replies are stored under, so the
// client can open the whole thread from 送信済み.
import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { sendMail } from "../src/send";
import { handleInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { listSent, listThread, sentThreadKey } from "../src/repo";
import { fakeIdentityFetcher, inboundDeps, makeHarness, sendDeps } from "./helpers";

const ROSTER = { usr_alice: { email: "alice@developershub.jp" } };

const req = (over: Partial<mail.SendMailRequest> = {}): mail.SendMailRequest => ({
  to: [{ email: "client@outside.com", name: "Client" }],
  subject: "見積もりの件",
  textBody: "お世話になっております。",
  ...over,
});

function reply(messageId: string, inReplyTo: string, from = "Client <client@outside.com>"): RawInbound {
  return {
    from: from.replace(/.*</, "").replace(">", ""),
    to: "alice@developershub.jp",
    headers: {
      "message-id": `<${messageId}>`,
      from,
      to: "alice@developershub.jp",
      subject: "Re: 見積もりの件",
      date: "Sat, 09 Aug 2026 05:00:00 +0000",
      "in-reply-to": `<${inReplyTo}>`,
      references: `<${inReplyTo}>`,
    },
    rawText: `Message-ID: <${messageId}>\r\nSubject: Re\r\n\r\nありがとうございます。`,
    rawSize: 256,
  };
}

async function sendAsAlice(h: ReturnType<typeof makeHarness>, key: string, over: Partial<mail.SendMailRequest> = {}) {
  const deps = sendDeps(h, { fromAddress: "alice@developershub.jp" });
  return (await sendMail(deps, req(over), key, "usr_alice")).response.messageId;
}

describe("Sent list conversation summary", () => {
  it("a lone send has no conversation", async () => {
    const h = makeHarness();
    await sendAsAlice(h, "k1");
    const page = await listSent(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", inboundScope: "usr_alice", limit: 10 });
    expect(page.items[0]!.conversation).toBeUndefined();
  });

  it("a send with two replies reports the whole thread (3 messages), keyed like the replies", async () => {
    const h = makeHarness();
    const rootId = await sendAsAlice(h, "k1");
    const ideps = inboundDeps(h, { identity: fakeIdentityFetcher(true, ROSTER) });
    await handleInbound(ideps, reply("r1@outside.com", rootId));
    await handleInbound(ideps, reply("r2@outside.com", "r1@outside.com", "Boss <boss@outside.com>"));

    const page = await listSent(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", inboundScope: "usr_alice", limit: 10 });
    const conv = page.items[0]!.conversation!;
    expect(conv.id).toBe(rootId);
    expect(conv.messageCount).toBe(3);
    expect(conv.repliedBy.map((p) => p.email)).toEqual(["client@outside.com", "boss@outside.com"]);
    // The id opens the thread with both replies.
    const thread = await listThread(h.db, conv.id, "usr_alice", "usr_alice");
    expect(thread.map((m) => m.messageId)).toEqual(["r1@outside.com", "r2@outside.com"]);
  });

  it("our follow-up reply shares the root's conversation and both rows count it", async () => {
    const h = makeHarness();
    const rootId = await sendAsAlice(h, "k1");
    const ideps = inboundDeps(h, { identity: fakeIdentityFetcher(true, ROSTER) });
    await handleInbound(ideps, reply("r1@outside.com", rootId));
    await sendAsAlice(h, "k2", { inReplyTo: "r1@outside.com", subject: "Re: 見積もりの件" });

    const page = await listSent(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", inboundScope: "usr_alice", limit: 10 });
    expect(page.items.map((i) => i.conversation?.id)).toEqual([rootId, rootId]);
    expect(page.items.map((i) => i.conversation?.messageCount)).toEqual([3, 3]);
  });

  it("replies outside the viewer's inbound scope are not counted", async () => {
    const h = makeHarness();
    const rootId = await sendAsAlice(h, "k1");
    const ideps = inboundDeps(h, { identity: fakeIdentityFetcher(true, ROSTER) });
    await handleInbound(ideps, reply("r1@outside.com", rootId));
    const page = await listSent(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", inboundScope: "usr_bob", limit: 10 });
    expect(page.items[0]!.conversation).toBeUndefined();
  });

  it("without an inbound scope the list keeps its old shape", async () => {
    const h = makeHarness();
    const rootId = await sendAsAlice(h, "k1");
    await handleInbound(inboundDeps(h, { identity: fakeIdentityFetcher(true, ROSTER) }), reply("r1@outside.com", rootId));
    const page = await listSent(h.db, { ownerUserId: "usr_alice", viewer: "usr_alice", limit: 10 });
    expect(page.items[0]!.conversation).toBeUndefined();
  });

  it("sentThreadKey: reply -> thread id, root -> its RFC id, legacy row -> null", () => {
    expect(sentThreadKey({ id: "maillog_1", thread_id: "t@x", from_address: "a@d.jp" })).toBe("t@x");
    expect(sentThreadKey({ id: "maillog_1", thread_id: null, from_address: "a@d.jp" })).toBe("maillog_1@d.jp");
    expect(sentThreadKey({ id: "maillog_1", thread_id: null, from_address: null })).toBeNull();
  });
});
