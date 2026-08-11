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
    const msg: MailMsg = { id: it.id, from: it.from, to: it.to, date: it.receivedAt, body: it.snippet, read: it.read };
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
      },
    ],
  }));
}

/** Full thread detail -> messages with real bodies (received thread reading pane). */
export function threadDetailToMessages(thread: mail.MailThread): MailMsg[] {
  return thread.messages.map((m) => ({
    id: m.id,
    from: m.from,
    to: m.to,
    date: m.receivedAt,
    body: m.textBody,
    read: m.read,
  }));
}

/** Full sent detail -> the single message with its real body (sent reading pane). */
export function sentDetailToMessage(detail: mail.MailSentDetail, me: MailPerson): MailMsg {
  return {
    id: detail.id,
    from: detail.from ?? me,
    to: detail.to,
    ...(detail.cc && detail.cc.length > 0 ? { cc: detail.cc } : {}),
    date: detail.sentAt,
    body: detail.textBody,
    read: true,
  };
}
