// Pure helpers for timeline presentation: date-divider boundaries and the unread
// divider position. Separated from the component so they are unit-testable.
import type { common } from "@dub/types";
import type { Message } from "../api/contract";

/** UTC date key (YYYY-MM-DD) for grouping day dividers. */
export function dateKey(iso: common.ISODateTime): string {
  return iso.slice(0, 10);
}

/** True when a day divider should render before messages[index]. */
export function needsDateDivider(messages: Message[], index: number): boolean {
  if (index === 0) return true;
  const prev = messages[index - 1];
  const cur = messages[index];
  if (!prev || !cur) return false;
  return dateKey(prev.createdAt) !== dateKey(cur.createdAt);
}

/**
 * Index of the first unread message (the unread divider renders before it), or -1
 * if everything is read. A message is unread when its ULID id is greater than
 * lastReadMessageId. Messages authored by the current user never count as unread.
 */
export function firstUnreadIndex(
  messages: Message[],
  lastReadMessageId: common.MessageId | null,
  currentUserId: common.UserId,
): number {
  if (lastReadMessageId === null) {
    const i = messages.findIndex((m) => m.authorId !== currentUserId);
    return i;
  }
  return messages.findIndex((m) => m.id > lastReadMessageId && m.authorId !== currentUserId);
}
