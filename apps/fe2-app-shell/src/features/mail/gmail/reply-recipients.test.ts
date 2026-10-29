// Reply addressing for the production report "Re: テストメール": a reply / reply-all must
// follow Gmail — answer the sender of a received mail, re-address the original recipients
// of our own mail — and a Dub send that loops back as a received copy shows once.
import { describe, expect, it } from "vitest";
import { dedupeLoopback, replyPlan, sentByMe, type MailMsg, type MailPerson, type MailThreadModel } from "./mailModel.ts";
import { ownAddresses, recipientSummary } from "./MessageDetails.tsx";

const GMAIL = { email: "kotaro.personal@gmail.com", name: "Kotaro Takaoka" };
const INFO = { email: "info@developershub.jp" };
const KOTARO = { email: "kotaro.takaoka@developershub.jp" };
const ADMIN = { email: "admin@developershub.jp" };
const ME_EMPTY: MailPerson = { email: "", name: "自分" };

const msg = (p: Partial<MailMsg> & Pick<MailMsg, "id" | "from" | "to">): MailMsg => ({ date: "2026-10-29T18:09:03.000Z", body: "こんにちは", read: true, ...p });
const thread = (messages: MailMsg[]): MailThreadModel => ({ id: "t", subject: "Re: テストメール", folder: "inbox", starred: false, labels: [], messages });
const emails = (ps: MailPerson[]): string[] => ps.map((p) => p.email);

// 03:09 info@ -> To personal Gmail, Cc kotaro@: our Sent row + the copy delivered to kotaro@.
const sentRow = (mine: boolean): MailMsg =>
  msg({ id: "maillog_abc", messageId: "maillog_abc", from: INFO, to: [GMAIL], cc: [KOTARO], outbound: true, ...(mine ? {} : { mine: false }) });
const kotaroCopy = (mine: boolean): MailMsg =>
  msg({
    id: "mailin_copy",
    messageId: "maillog_abc@developershub.jp",
    from: INFO,
    to: [GMAIL],
    cc: [KOTARO],
    date: "2026-10-29T18:09:03.600Z",
    ...(mine ? { headerMeta: { deliveredTo: KOTARO.email } } : { mine: false }),
  });
const received = msg({ id: "mailin_1", messageId: "ext-1@gmail.com", from: GMAIL, to: [INFO], body: "こんばんわ", date: "2026-10-29T12:19:00.000Z", mine: false });

describe("replyPlan (Gmail addressing)", () => {
  it("received mail: 返信 goes to its sender, 全員に返信 adds every To/Cc minus me", () => {
    const own = new Set([KOTARO.email]);
    const p = replyPlan([received, kotaroCopy(true)], own);
    expect(emails(p.reply)).toEqual([INFO.email]);
    expect(emails(p.all.to)).toEqual([INFO.email, GMAIL.email]);
    expect(p.all.cc).toEqual([]); // kotaro@ (me) dropped
    expect(p.parentId).toBe("maillog_abc@developershub.jp");
  });

  it("Reply-To wins over From", () => {
    const m = msg({ id: "x", messageId: "x@y", from: GMAIL, to: [KOTARO], headerMeta: { replyTo: [{ email: "list@example.com" }] } });
    expect(emails(replyPlan([m], new Set([KOTARO.email])).reply)).toEqual(["list@example.com"]);
  });

  it("our own sent mail: re-addresses its original recipients (To stays To, Cc stays Cc), never ourselves", () => {
    const own = new Set([INFO.email]);
    const p = replyPlan([received, sentRow(true)], own);
    expect(emails(p.reply)).toEqual([GMAIL.email]);
    expect(emails(p.all.to)).toEqual([GMAIL.email]);
    expect(emails(p.all.cc)).toEqual([KOTARO.email]);
    // A folded Sent row carries the bare log id: reply against the stamped RFC form.
    expect(p.parentId).toBe("maillog_abc@developershub.jp");
  });

  it("the looped-back received copy of OUR send is treated as ours (bug: replied to info@ = ourselves)", () => {
    const own = new Set([INFO.email, KOTARO.email]);
    const last = kotaroCopy(true);
    expect(sentByMe(last, own)).toBe(true);
    expect(emails(replyPlan([received, last], own).reply)).toEqual([GMAIL.email]);
  });

  it("another account's Sent row seen via oversight is NOT ours: reply goes to its sender", () => {
    const own = ownAddresses(thread([received, sentRow(false)]), ME_EMPTY);
    expect(own.has(INFO.email)).toBe(false);
    expect(emails(replyPlan([received, sentRow(false)], own).reply)).toEqual([INFO.email]);
  });

  it("mail I sent only to myself still has a recipient", () => {
    const m = msg({ id: "maillog_s", messageId: "maillog_s", from: ADMIN, to: [ADMIN], outbound: true });
    expect(emails(replyPlan([m], new Set([ADMIN.email])).reply)).toEqual([ADMIN.email]);
  });
});

describe("ownAddresses / recipientSummary", () => {
  it("oversight viewer: someone else's From (info@) is not labelled 自分 (bug: 宛先: 自分 on a mail to info@)", () => {
    const adminReply = msg({ id: "maillog_adm", messageId: "maillog_adm", from: ADMIN, to: [INFO], outbound: true, body: "え、大丈夫？" });
    const t = thread([received, sentRow(false), kotaroCopy(false), adminReply]);
    const own = ownAddresses(t, ME_EMPTY);
    expect([...own]).toEqual([ADMIN.email]);
    expect(recipientSummary(adminReply, own)).toBe("info@developershub.jp");
  });

  it("Cc is labelled, not merged into the To list", () => {
    expect(recipientSummary(kotaroCopy(false), new Set())).toBe("Kotaro Takaoka　Cc: kotaro.takaoka@developershub.jp");
    expect(recipientSummary(kotaroCopy(true), new Set([KOTARO.email]))).toBe("Kotaro Takaoka　Cc: 自分");
  });
});

describe("dedupeLoopback", () => {
  it("a send to a Dub-routed mailbox shows once (bug: same mail listed twice, a second apart)", () => {
    expect(dedupeLoopback([received, sentRow(true), kotaroCopy(true)]).map((m) => m.id)).toEqual(["mailin_1", "maillog_abc"]);
    // Someone else's send: keep the received copy (it carries delivery details / mine).
    expect(dedupeLoopback([received, sentRow(false), kotaroCopy(false)]).map((m) => m.id)).toEqual(["mailin_1", "mailin_copy"]);
  });

  it("matches by content when the provider replaced our Message-Id", () => {
    const copy = { ...kotaroCopy(true), messageId: "0100018f-resend@amazonses.com" };
    expect(dedupeLoopback([sentRow(true), copy]).map((m) => m.id)).toEqual(["maillog_abc"]);
  });

  it("keeps genuinely different messages", () => {
    const other = { ...kotaroCopy(true), messageId: "other@x", body: "別の本文" };
    const late = { ...kotaroCopy(true), messageId: "late@x", date: "2026-10-29T19:30:00.000Z" };
    expect(dedupeLoopback([sentRow(true), other, late])).toHaveLength(3);
  });
});
