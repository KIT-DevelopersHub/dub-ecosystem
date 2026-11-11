// Pure mappers: gateway DTOs (@dub/types mail) -> the client MailThreadModel the
// Gmail-style store renders. Kept side-effect free so they can be unit-tested and
// reused by the hydration hook. The list endpoints carry only a snippet (no body),
// so list-derived threads seed body=snippet; opening a thread later fetches the full
// message(s) (getThread / getSent) to fill real bodies (threadDetailToMessages /
// sentDetailToMessage).
import type { mail } from "@dub/types";
import { dedupeLoopback, type MailMsg, type MailPerson, type MailThreadModel } from "./mailModel.ts";

/** Received messages -> inbox threads, grouped by threadId, messages oldest→newest. */
export function inboxItemsToThreads(items: mail.MailMessageListItem[]): MailThreadModel[] {
  const byThread = new Map<string, MailThreadModel>();
  const order: string[] = [];
  for (const it of items) {
    const msg: MailMsg = {
      id: it.id,
      messageId: it.messageId,
      from: it.from,
      to: it.to,
      ...(it.cc && it.cc.length > 0 ? { cc: it.cc } : {}),
      date: it.receivedAt,
      body: it.snippet,
      read: it.read,
      ...(it.mine === false ? { mine: false } : {}),
      ...(it.blocked ? { blocked: true } : {}),
    };
    const existing = byThread.get(it.threadId);
    if (existing) {
      existing.messages.push(msg);
      // A thread's subject/star come from any of its items; keep the first non-empty subject.
      if (!existing.subject && it.subject) existing.subject = it.subject;
    } else {
      order.push(it.threadId);
      byThread.set(it.threadId, { id: it.threadId, subject: it.subject, folder: "inbox", starred: false, labels: [], messages: [msg] });
    }
  }
  for (const id of order) {
    const t = byThread.get(id)!;
    t.messages.sort((a, b) => a.date.localeCompare(b.date));
  }
  return order.map((id) => byThread.get(id)!);
}

/** Local part of a message id (`maillog_x@d` -> `maillog_x`). */
const localOf = (id: string): string => id.split("@")[0] ?? id;

/** One sent list row -> the outbound message it renders as. */
function sentItemToMessage(it: mail.MailSentListItem, me: MailPerson): MailMsg {
  return {
    id: it.id,
    messageId: it.id, // bare send-log id: replyPlan rebuilds the wire Message-Id from it
    from: it.from ?? me,
    to: it.to,
    ...(it.cc && it.cc.length > 0 ? { cc: it.cc } : {}),
    ...(it.bcc && it.bcc.length > 0 ? { bcc: it.bcc } : {}),
    date: it.sentAt,
    body: it.snippet,
    read: true,
    outbound: true,
    ...(it.mine === false ? { mine: false } : {}),
  };
}

/** Combine received + sent into ONE list of conversations (Gmail). Every send goes into its
 *  conversation: a received thread with the same id (our reply, or the send that the replies
 *  answer), else a Sent thread shared with our other sends in it. The conversation id is the
 *  server summary's (`conversation.id`), else the reply's `threadId`; a send that opened a
 *  thread with no summary (older gateway) still matches the received thread keyed by its own
 *  RFC id (`<send-log id>@domain`). A lone send stays its own thread, keyed by its id. */
export function combineThreads(
  inboxItems: mail.MailMessageListItem[],
  sentItems: mail.MailSentListItem[],
  me: MailPerson,
): MailThreadModel[] {
  const inboxThreads = inboxItemsToThreads(inboxItems);
  const byId = new Map(inboxThreads.map((t) => [t.id, t]));
  const byLocal = new Map(inboxThreads.filter((t) => t.id.startsWith("maillog_")).map((t) => [localOf(t.id), t]));
  const sentThreads = new Map<string, MailThreadModel>();
  const sentOrder: string[] = [];
  for (const s of sentItems) {
    const key = s.conversation?.id ?? s.threadId;
    const target = (key ? byId.get(key) : undefined) ?? byLocal.get(s.id) ?? (key ? sentThreads.get(key) : undefined);
    const msg = sentItemToMessage(s, me);
    if (target) {
      // A Sent-only conversation is titled by its first message (not a later "Re:").
      if (target.folder === "sent" && msg.date < (target.messages[0]?.date ?? "")) target.subject = s.subject;
      if (!target.messages.some((m) => m.id === s.id)) target.messages.push(msg);
      target.messages.sort((a, b) => a.date.localeCompare(b.date));
    } else {
      const id = key && s.conversation ? key : s.id;
      sentOrder.push(id);
      sentThreads.set(id, { id, subject: s.subject, folder: "sent", starred: false, labels: [], messages: [msg] });
    }
    const t = target ?? sentThreads.get(s.conversation && key ? key : s.id);
    if (t && s.conversation) {
      t.conversationSize = Math.max(t.conversationSize ?? 0, s.conversation.messageCount);
      if (s.conversation.repliedBy.length > 0) t.repliedBy = s.conversation.repliedBy;
    }
  }
  // A send to a Dub-routed mailbox also arrives as a received copy: show it once.
  for (const t of inboxThreads) t.messages = dedupeLoopback(t.messages);
  return [...inboxThreads, ...sentOrder.map((id) => sentThreads.get(id)!)];
}

/** Sent messages -> sent threads (one message each; the send-log has no thread grouping). */
export function sentItemsToThreads(items: mail.MailSentListItem[], me: MailPerson): MailThreadModel[] {
  return items.map((it) => ({
    id: it.id,
    subject: it.subject,
    folder: "sent" as const,
    starred: false,
    labels: [],
    messages: [sentItemToMessage(it, me)],
  }));
}

/** Full thread detail -> messages with real bodies (received thread reading pane). Carries
 *  each message's attachment metadata so the 3-pane reading view can list + download them
 *  (list endpoints omit attachments; only this detail fetch has them). */
export function threadDetailToMessages(thread: mail.MailThread): MailMsg[] {
  return thread.messages.map((m) => ({
    id: m.id,
    messageId: m.messageId,
    from: m.from,
    to: m.to,
    ...(m.cc && m.cc.length > 0 ? { cc: m.cc } : {}),
    date: m.receivedAt,
    body: m.textBody,
    ...(m.htmlBody ? { html: m.htmlBody } : {}),
    read: m.read,
    ...(m.mine === false ? { mine: false } : {}),
    ...(m.blocked ? { blocked: true } : {}),
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
    ...(m.headerMeta ? { headerMeta: m.headerMeta } : {}),
  }));
}

/** Full sent detail -> the single message with its real body (sent reading pane). Carries
 *  attachment metadata so a sent message's files are listable + downloadable in the pane. */
export function sentDetailToMessage(detail: mail.MailSentDetail, me: MailPerson): MailMsg {
  return {
    id: detail.id,
    messageId: detail.id,
    from: detail.from ?? me,
    to: detail.to,
    ...(detail.cc && detail.cc.length > 0 ? { cc: detail.cc } : {}),
    ...(detail.bcc && detail.bcc.length > 0 ? { bcc: detail.bcc } : {}),
    date: detail.sentAt,
    body: detail.textBody,
    read: true,
    outbound: true,
    ...(detail.mine === false ? { mine: false } : {}),
    ...(detail.attachments && detail.attachments.length > 0 ? { attachments: detail.attachments } : {}),
  };
}
