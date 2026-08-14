// Unit tests for the gateway-DTO -> client-model mappers.
import { describe, expect, it } from "vitest";
import type { mail } from "@dub/types";
import { combineThreads, inboxItemsToThreads, sentDetailToMessage, sentItemsToThreads, threadDetailToMessages } from "./hydrate.ts";
import { SELF } from "./mailModel.ts";

const inbox: mail.MailMessageListItem[] = [
  { id: "a1", messageId: "<a1>", threadId: "T", from: { email: "a@x.jp" }, to: [{ email: "me@developershub.jp" }], subject: "Hello", snippet: "older", receivedAt: "2026-08-01T00:00:00.000Z", read: true },
  { id: "a2", messageId: "<a2>", threadId: "T", from: { email: "b@x.jp" }, to: [{ email: "me@developershub.jp" }], subject: "Hello", snippet: "newer", receivedAt: "2026-08-02T00:00:00.000Z", read: false },
  { id: "b1", messageId: "<b1>", threadId: "U", from: { email: "c@x.jp" }, to: [{ email: "me@developershub.jp" }], subject: "Other", snippet: "solo", receivedAt: "2026-08-03T00:00:00.000Z", read: false },
];

describe("inboxItemsToThreads", () => {
  it("groups by threadId, oldest→newest, preserving first-seen order", () => {
    const threads = inboxItemsToThreads(inbox);
    expect(threads.map((t) => t.id)).toEqual(["T", "U"]);
    expect(threads[0]!.messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(threads[0]!.folder).toBe("inbox");
    // body seeds from the snippet (list endpoints carry no body).
    expect(threads[0]!.messages[0]!.body).toBe("older");
    expect(threads[1]!.messages).toHaveLength(1);
  });
});

describe("sentItemsToThreads", () => {
  it("maps each sent item to a one-message sent thread with its recorded From", () => {
    const items: mail.MailSentListItem[] = [
      { id: "s1", from: { email: "alice@developershub.jp" }, to: [{ email: "x@y.z" }], subject: "Hi", snippet: "hey", sentAt: "2026-08-05T00:00:00.000Z", provider: "resend", status: "sent" },
    ];
    const threads = sentItemsToThreads(items, SELF);
    expect(threads[0]!.folder).toBe("sent");
    expect(threads[0]!.messages[0]!.from.email).toBe("alice@developershub.jp");
    expect(threads[0]!.messages[0]!.read).toBe(true);
  });

  it("falls back to `me` when a sent item has no recorded From", () => {
    const items: mail.MailSentListItem[] = [
      { id: "s2", to: [{ email: "x@y.z" }], subject: "Hi", snippet: "hey", sentAt: "2026-08-05T00:00:00.000Z", provider: "resend", status: "sent" },
    ];
    expect(sentItemsToThreads(items, SELF)[0]!.messages[0]!.from).toEqual(SELF);
  });
});

describe("combineThreads", () => {
  it("folds a sent REPLY into its received conversation (outbound=true), keeps other sends as Sent threads", () => {
    const sent: mail.MailSentListItem[] = [
      // reply to thread T — must fold into it, not appear as its own thread.
      { id: "r1", from: { email: "info@developershub.jp" }, to: [{ email: "a@x.jp" }], subject: "Re: Hello", snippet: "our reply", sentAt: "2026-08-04T00:00:00.000Z", provider: "resend", status: "sent", threadId: "T" },
      // standalone send (no matching inbox thread) — stays its own Sent thread.
      { id: "s9", from: { email: "info@developershub.jp" }, to: [{ email: "z@z.z" }], subject: "Solo", snippet: "solo send", sentAt: "2026-08-06T00:00:00.000Z", provider: "resend", status: "sent", threadId: "Z" },
    ];
    const threads = combineThreads(inbox, sent, SELF);
    const t = threads.find((x) => x.id === "T")!;
    expect(t.messages.map((m) => m.id)).toEqual(["a1", "a2", "r1"]); // reply appended, date-ordered
    expect(t.messages.at(-1)!.outbound).toBe(true);
    expect(t.folder).toBe("inbox");
    // the standalone send is still its own Sent thread.
    expect(threads.find((x) => x.id === "s9")?.folder).toBe("sent");
  });

  it("folds MULTIPLE sent replies into one 3+ message conversation once the gateway normalizes threadId (改善#4)", () => {
    // With the backend storing the ROOT thread id on every reply, several of our sends
    // share threadId "T" and all fold into the single conversation, interleaved by date —
    // no reply is orphaned as its own Sent thread.
    const sent: mail.MailSentListItem[] = [
      { id: "r1", from: { email: "info@developershub.jp" }, to: [{ email: "a@x.jp" }], subject: "Re: Hello", snippet: "reply 1", sentAt: "2026-08-01T12:00:00.000Z", provider: "resend", status: "sent", threadId: "T" },
      { id: "r2", from: { email: "info@developershub.jp" }, to: [{ email: "b@x.jp" }], subject: "Re: Hello", snippet: "reply 2", sentAt: "2026-08-02T12:00:00.000Z", provider: "resend", status: "sent", threadId: "T" },
    ];
    const threads = combineThreads(inbox, sent, SELF);
    const t = threads.find((x) => x.id === "T")!;
    expect(t.messages.map((m) => m.id)).toEqual(["a1", "r1", "a2", "r2"]); // date-interleaved
    expect(threads.filter((x) => x.folder === "sent")).toHaveLength(0); // neither reply orphaned
  });
});

describe("full-body mappers", () => {
  it("threadDetailToMessages uses textBody", () => {
    const thread: mail.MailThread = { id: "T", messages: [{ ...inbox[0]!, textBody: "the full body" }] };
    expect(threadDetailToMessages(thread)[0]!.body).toBe("the full body");
  });

  it("sentDetailToMessage uses textBody", () => {
    const detail: mail.MailSentDetail = { id: "s1", from: { email: "a@b.jp" }, to: [{ email: "x@y.z" }], subject: "Hi", snippet: "hey", sentAt: "2026-08-05T00:00:00.000Z", provider: "resend", status: "sent", textBody: "full sent body" };
    expect(sentDetailToMessage(detail, SELF).body).toBe("full sent body");
  });

  it("threadDetailToMessages carries attachment metadata (改善#1: 3-pane list/download)", () => {
    const att: mail.MailAttachment[] = [{ id: "att1", filename: "spec.pdf", contentType: "application/pdf", sizeBytes: 2048 }];
    const thread: mail.MailThread = { id: "T", messages: [{ ...inbox[0]!, textBody: "b", attachments: att }] };
    expect(threadDetailToMessages(thread)[0]!.attachments).toEqual(att);
  });

  it("threadDetailToMessages omits attachments when none (byte-identical to prior shape)", () => {
    const thread: mail.MailThread = { id: "T", messages: [{ ...inbox[0]!, textBody: "b" }] };
    expect("attachments" in threadDetailToMessages(thread)[0]!).toBe(false);
  });

  it("sentDetailToMessage carries attachment metadata", () => {
    const att: mail.MailAttachment[] = [{ id: "a9", filename: "img.png", contentType: "image/png", sizeBytes: 500 }];
    const detail: mail.MailSentDetail = { id: "s1", to: [{ email: "x@y.z" }], subject: "Hi", snippet: "hey", sentAt: "2026-08-05T00:00:00.000Z", provider: "resend", status: "sent", textBody: "b", attachments: att };
    expect(sentDetailToMessage(detail, SELF).attachments).toEqual(att);
  });
});
