import { describe, it, expect } from "vitest";
import { handleInbound, parseInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { getInboundById, getInboundDetail, listInbound } from "../src/repo";
import { makeHarness, inboundDeps, fakeIdentityFetcher } from "./helpers";

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

// The production owner-address policy (buildInboundDeps): archive@ is auto-CC'd on every
// outbound send so it must never own a message; info@ is a real shared inbox but must not
// outrank an individually-addressed recipient.
const POLICY = { archiveAddress: "archive@developershub.jp", sharedAddress: "info@developershub.jp" };

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

  it("lists owner candidates envelope-first, then the To: header", () => {
    const parsed = parseInbound(
      rawMessage({ to: "makoto.yoshioka@developershub.jp" }, { to: "client@outside.com, other@outside.com" }),
      POLICY,
    );
    expect(parsed.ownerCandidates.map((a) => a.email)).toEqual([
      "makoto.yoshioka@developershub.jp", // envelope recipient wins the first lookup
      "client@outside.com",
      "other@outside.com",
    ]);
  });

  it("never offers the archive address as an owner candidate (read_all 専用の控え)", () => {
    const parsed = parseInbound(
      rawMessage(
        { to: "archive@developershub.jp" },
        { to: "client@outside.com", cc: "archive@developershub.jp" },
      ),
      POLICY,
    );
    expect(parsed.ownerCandidates.map((a) => a.email)).toEqual(["client@outside.com"]);
  });

  it("demotes the shared system address below the To: header", () => {
    const parsed = parseInbound(
      rawMessage({ to: "info@developershub.jp" }, { to: "makoto.yoshioka@developershub.jp" }),
      POLICY,
    );
    expect(parsed.ownerCandidates.map((a) => a.email)).toEqual([
      "makoto.yoshioka@developershub.jp", // the real addressee wins
      "info@developershub.jp", // shared alias only as a last resort
    ]);
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

  it("normalizes a trimmed References chain onto the known root thread (改善#3, 3通以上)", async () => {
    const h = makeHarness();
    const deps = inboundDeps(h);
    // 1) root inbound A opens thread A.
    await handleInbound(deps, rawMessage({}, { "message-id": "<A@x.com>" }));
    // 2) reply B references A (full chain) -> thread A.
    await handleInbound(deps, rawMessage({}, { "message-id": "<B@x.com>", references: "<A@x.com>" }));
    // 3) reply C references ONLY its immediate parent B (client trimmed the chain). Naive
    //    firstRef would fork a new thread "B"; normalization must resolve B -> its thread A.
    await handleInbound(deps, rawMessage({}, { "message-id": "<C@x.com>", "in-reply-to": "<B@x.com>", references: "<B@x.com>" }));
    const thread = await listInbound(h.db, { ownerUserId: "usr_info", threadId: "A@x.com", limit: 10 });
    expect(thread.items.map((m) => m.messageId).sort()).toEqual(["A@x.com", "B@x.com", "C@x.com"]);
    // No stray thread got created under the parent id.
    const stray = await listInbound(h.db, { ownerUserId: "usr_info", threadId: "B@x.com", limit: 10 });
    expect(stray.items).toHaveLength(0);
  });
});

// Owner resolution drives per-account Inbox visibility, so it is pinned behaviourally:
// the ENVELOPE recipient (what Email Routing delivered to) must win over the To: header,
// which names an external address whenever we are only in CC/BCC.
describe("handleInbound owner resolution (envelope-first)", () => {
  // The roster: these addresses map to a user; everything else is non-roster. archive@ and
  // info@ ARE real roster users in prod — identity-roster provisions one active user per
  // Email-Routing literal address — which is exactly why the policy must exclude/demote
  // them rather than trust that a lookup will miss.
  const roster = {
    usr_makoto: { email: "makoto.yoshioka@developershub.jp" },
    usr_info: { email: "info@developershub.jp" },
    usr_archive: { email: "archive@developershub.jp" },
  };
  function ownerOf(h: ReturnType<typeof makeHarness>): string | null {
    const row = h.raw.prepare(`SELECT owner_user_id FROM mail_inbound`).get() as
      | { owner_user_id: string | null }
      | undefined;
    return row?.owner_user_id ?? null;
  }
  function depsWithRoster(h: ReturnType<typeof makeHarness>) {
    return inboundDeps(h, { identity: fakeIdentityFetcher(true, roster) });
  }

  it("resolves the owner from the envelope recipient when To: is an external address (CC/BCC 受信)", async () => {
    const h = makeHarness();
    await handleInbound(
      depsWithRoster(h),
      rawMessage({ to: "makoto.yoshioka@developershub.jp" }, { to: "client@outside.com" }),
    );
    expect(ownerOf(h)).toBe("usr_makoto");
  });

  it("still resolves the owner from the To: header when the envelope address is non-roster (非回帰)", async () => {
    const h = makeHarness();
    await handleInbound(
      depsWithRoster(h),
      rawMessage({ to: "shared-alias@developershub.jp" }, { to: "Info <info@developershub.jp>" }),
    );
    expect(ownerOf(h)).toBe("usr_info");
  });

  it("leaves the owner NULL when neither the envelope nor To: is a roster user (fail-closed)", async () => {
    const h = makeHarness();
    await handleInbound(
      depsWithRoster(h),
      rawMessage({ to: "nobody@developershub.jp" }, { to: "client@outside.com" }),
    );
    expect(ownerOf(h)).toBeNull();
    // and it is invisible to every account, including the two real roster users.
    for (const uid of Object.keys(roster)) {
      expect((await listInbound(h.db, { ownerUserId: uid, limit: 10 })).items).toHaveLength(0);
    }
  });

  it("tries the envelope recipient first even when To: carries more addresses than MAX_LOOKUPS", async () => {
    const h = makeHarness();
    // 6 non-roster To: addresses > MAX_LOOKUPS (5): a To:-first order would burn every
    // lookup slot before reaching the envelope address and leave the message ownerless.
    const crowd = Array.from({ length: 6 }, (_, i) => `bulk${i}@outside.com`).join(", ");
    await handleInbound(
      depsWithRoster(h),
      rawMessage({ to: "makoto.yoshioka@developershub.jp" }, { to: crowd }),
    );
    expect(ownerOf(h)).toBe("usr_makoto");
  });

  it("keeps the archive copy ownerless so it stays mail:read_all-only (全社員の送信控えを個人受信箱にしない)", async () => {
    const h = makeHarness();
    // Every outbound send auto-CCs archive@, and that copy is routed back into this
    // Worker: envelope = archive@, To: = the original external recipient. archive@ is a
    // real roster user, so only the policy keeps this out of an ordinary Inbox.
    await handleInbound(
      depsWithRoster(h),
      rawMessage({ to: "archive@developershub.jp" }, { to: "client@outside.com", cc: "archive@developershub.jp" }),
    );
    expect(ownerOf(h)).toBeNull();
    expect((await listInbound(h.db, { ownerUserId: "usr_archive", limit: 10 })).items).toHaveLength(0);
  });

  it("gives an individually-addressed message to the individual, not the shared alias", async () => {
    const h = makeHarness();
    // Routed through the shared info@ alias but addressed To: a person: the person must
    // keep it (and it must not surface in the shared account's Inbox).
    await handleInbound(
      depsWithRoster(h),
      rawMessage({ to: "info@developershub.jp" }, { to: "makoto.yoshioka@developershub.jp" }),
    );
    expect(ownerOf(h)).toBe("usr_makoto");
    expect((await listInbound(h.db, { ownerUserId: "usr_info", limit: 10 })).items).toHaveLength(0);
  });

  it("still lets the shared alias own a message nobody else claims (CC/BCC で info@ に届いた分)", async () => {
    const h = makeHarness();
    await handleInbound(
      depsWithRoster(h),
      rawMessage({ to: "info@developershub.jp" }, { to: "client@outside.com" }),
    );
    expect(ownerOf(h)).toBe("usr_info");
  });

  it("does not let the envelope candidate shrink the To: lookup budget", async () => {
    const h = makeHarness();
    // A distinct (non-roster) envelope address plus the full 5-address To: budget, with
    // the legitimate recipient last. If the envelope candidate ate a slot from the old
    // 5-lookup cap, info@ would fall out of range and the message would go ownerless.
    const to = [...Array.from({ length: 4 }, (_, i) => `bulk${i}@outside.com`), "info@developershub.jp"].join(", ");
    await handleInbound(depsWithRoster(h), rawMessage({ to: "catch-all@developershub.jp" }, { to }));
    expect(ownerOf(h)).toBe("usr_info");
  });

  it("does not let repeated addresses consume lookup slots", async () => {
    const h = makeHarness();
    // The envelope alias repeats 5x (envelope + 4 To: copies) before the roster user.
    // Deduped that is 2 lookups; if each repeat burned a slot the cap would be hit and
    // info@ would never be tried.
    const to = [...Array.from({ length: 4 }, () => "shared-alias@developershub.jp"), "info@developershub.jp"].join(", ");
    await handleInbound(depsWithRoster(h), rawMessage({ to: "shared-alias@developershub.jp" }, { to }));
    expect(ownerOf(h)).toBe("usr_info");
  });
});
