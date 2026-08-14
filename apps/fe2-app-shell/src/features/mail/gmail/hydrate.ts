// Pure mappers: gateway DTOs (@dub/types mail) -> the client MailThreadModel the
// Gmail-style store renders. Kept side-effect free so they can be unit-tested and
// reused by the hydration hook. The list endpoints carry only a snippet (no body),
// so list-derived threads seed body=snippet; opening a thread later fetches the full
// message(s) (getThread / getSent) to fill real bodies (threadDetailToMessages /
// sentDetailToMessage).
import type { mail } from "@dub/types";
import type { MailMsg, MailPerson, MailThreadModel } from "./mailModel.ts";

/** Received messages -> inbox threads, grouped by threadId, messages oldest→newest. */
export function inboxItemsToThreads(items: mail.MailMessageListItem[]): MailThreadModel[] {
  const byThread = new Map<string, MailThreadModel>();
  const order: string[] = [];
  for (const it of items) {
    const msg: MailMsg = { id: it.id, messageId: it.messageId, from: it.from, to: it.to, date: it.receivedAt, body: it.snippet, read: it.read };
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

/** Combine received + sent into the thread list the store renders. A sent REPLY (its
 *  threadId matches a received thread) is folded INTO that conversation so it stays
 *  visible in the thread instead of showing as a detached Sent row; every other sent
 *  message becomes its own Sent thread as before. Mirrors the server-side union in
 *  GET /threads/:id, so the list view and the opened conversation agree. */
export function combineThreads(
  inboxItems: mail.MailMessageListItem[],
  sentItems: mail.MailSentListItem[],
  me: MailPerson,
): MailThreadModel[] {
  const inboxThreads = inboxItemsToThreads(inboxItems);
  const byId = new Map(inboxThreads.map((t) => [t.id, t]));
  const standalone: mail.MailSentListItem[] = [];
  for (const s of sentItems) {
    const parent = s.threadId ? byId.get(s.threadId) : undefined;
    if (parent) {
      parent.messages.push({
        id: s.id,
        messageId: s.id,
        from: s.from ?? me,
        to: s.to,
        ...(s.cc && s.cc.length > 0 ? { cc: s.cc } : {}),
        date: s.sentAt,
        body: s.snippet,
        read: true,
        outbound: true,
      });
      parent.messages.sort((a, b) => a.date.localeCompare(b.date));
    } else {
      standalone.push(s);
    }
  }
  return [...inboxThreads, ...sentItemsToThreads(standalone, me)];
}

/** Sent messages -> sent threads (one message each; the send-log has no thread grouping). */
export function sentItemsToThreads(items: mail.MailSentListItem[], me: MailPerson): MailThreadModel[] {
  return items.map((it) => ({
    id: it.id,
    subject: it.subject,
    folder: "sent" as const,
    starred: false,
    labels: [],
    messages: [
      {
        id: it.id,
        from: it.from ?? me,
        to: it.to,
        ...(it.cc && it.cc.length > 0 ? { cc: it.cc } : {}),
        date: it.sentAt,
        body: it.snippet,
        read: true,
        outbound: true,
      },
    ],
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
    date: m.receivedAt,
    body: m.textBody,
    read: m.read,
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
  }));
}

/** Full sent detail -> the single message with its real body (sent reading pane). Carries
 *  attachment metadata so a sent message's files are listable + downloadable in the pane. */
export function sentDetailToMessage(detail: mail.MailSentDetail, me: MailPerson): MailMsg {
  return {
    id: detail.id,
    from: detail.from ?? me,
    to: detail.to,
    ...(detail.cc && detail.cc.length > 0 ? { cc: detail.cc } : {}),
    date: detail.sentAt,
    body: detail.textBody,
    read: true,
    outbound: true,
    ...(detail.attachments && detail.attachments.length > 0 ? { attachments: detail.attachments } : {}),
  };
}
