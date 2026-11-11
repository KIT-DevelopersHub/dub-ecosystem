// 送信済み → conversation (Gmail parity): a send that got answered folds into one thread with
// its replies, and the Sent row is counted and named like Gmail ("自分, 相手 3").
import { describe, expect, it } from "vitest";
import type { mail } from "@dub/types";
import { combineThreads } from "./hydrate.ts";
import { SELF, hasUnloadedReplies, inFolder, sentRowPeople, threadSize } from "./mailModel.ts";

const ME = { email: "alice@developershub.jp", name: "Alice" };
const root: mail.MailSentListItem = {
  id: "maillog_ROOT",
  from: ME,
  to: [{ email: "client@outside.com", name: "Client" }],
  subject: "見積もりの件",
  snippet: "お世話になっております",
  sentAt: "2026-08-01T00:00:00.000Z",
  provider: "resend",
  status: "sent",
};
const reply = (id: string, from: mail.MailAddress, at: string, threadId = "maillog_ROOT@developershub.jp"): mail.MailMessageListItem => ({
  id,
  messageId: `${id}@outside.com`,
  threadId,
  from,
  to: [ME],
  subject: "Re: 見積もりの件",
  snippet: "返信",
  receivedAt: at,
  read: false,
});
const CLIENT = { email: "client@outside.com", name: "Client" };
const BOSS = { email: "boss@outside.com", name: "Boss" };
const conversation: mail.MailSentConversation = {
  id: "maillog_ROOT@developershub.jp",
  messageCount: 3,
  latestAt: "2026-08-03T00:00:00.000Z",
  repliedBy: [CLIENT, BOSS],
};

describe("combineThreads: a send and its replies are one conversation", () => {
  it("folds the opening send into the received replies' thread (summary id)", () => {
    const inbox = [reply("r1", CLIENT, "2026-08-02T00:00:00.000Z"), reply("r2", BOSS, "2026-08-03T00:00:00.000Z")];
    const threads = combineThreads(inbox, [{ ...root, conversation }], SELF);
    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t.id).toBe("maillog_ROOT@developershub.jp");
    expect(t.messages.map((m) => m.id)).toEqual(["maillog_ROOT", "r1", "r2"]); // chronological
    expect(inFolder(t, "sent")).toBe(true);
    expect(sentRowPeople(t, SELF).label).toBe("自分, Boss");
    expect(threadSize(t)).toBe(3);
  });

  it("folds it even without the summary (older gateway): RFC id local part = send id", () => {
    const threads = combineThreads([reply("r1", CLIENT, "2026-08-02T00:00:00.000Z")], [root], SELF);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages.map((m) => m.id)).toEqual(["maillog_ROOT", "r1"]);
  });

  it("replies not loaded (other page / archived): a Sent thread keyed by the conversation, counted from the summary", () => {
    const threads = combineThreads([], [{ ...root, conversation }], SELF);
    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t.id).toBe(conversation.id);
    expect(t.folder).toBe("sent");
    expect(threadSize(t)).toBe(3);
    expect(hasUnloadedReplies(t)).toBe(true);
    expect(sentRowPeople(t, SELF)).toEqual({ label: "自分, Boss", avatar: BOSS });
  });

  it("our follow-up send joins the same Sent thread, titled by the first message", () => {
    const follow: mail.MailSentListItem = {
      ...root,
      id: "maillog_FOLLOW",
      subject: "Re: 見積もりの件",
      sentAt: "2026-08-04T00:00:00.000Z",
      threadId: conversation.id,
      conversation: { ...conversation, messageCount: 4 },
    };
    // Sent list is newest first.
    const threads = combineThreads([], [follow, { ...root, conversation: { ...conversation, messageCount: 4 } }], SELF);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages.map((m) => m.id)).toEqual(["maillog_ROOT", "maillog_FOLLOW"]);
    expect(threads[0]!.subject).toBe("見積もりの件");
    expect(threadSize(threads[0]!)).toBe(4);
  });

  it("a lone send keeps its own id and is named after the recipient", () => {
    const threads = combineThreads([], [root], SELF);
    expect(threads[0]!.id).toBe("maillog_ROOT");
    expect(hasUnloadedReplies(threads[0]!)).toBe(false);
    expect(sentRowPeople(threads[0]!, SELF).label).toBe("Client");
    expect(threadSize(threads[0]!)).toBe(1);
  });
});
