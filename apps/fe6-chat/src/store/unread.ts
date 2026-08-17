// Unread aggregation (design §2-5, §6). chat unread is owned by FE6 (chat /unread);
// FE5 owns everything else (theme4 1-5). Pure map operations.
import type { common } from "@dub/types";
import type { ChatRealtimeEvent, UnreadSummary } from "../api/contract";

export type UnreadMap = Record<common.ChannelId, UnreadSummary>;

export function toUnreadMap(summaries: UnreadSummary[]): UnreadMap {
  const map: UnreadMap = {};
  // Guard against a non-array (e.g. a Paginated envelope) so unread aggregation
  // never throws "not iterable" (chat error-fix).
  for (const s of Array.isArray(summaries) ? summaries : []) map[s.channelId] = s;
  return map;
}

/** Total unread across all channels — feeds useChatUnreadTotal / nav badge. */
export function unreadTotal(map: UnreadMap): number {
  let total = 0;
  for (const k in map) total += map[k]!.unreadCount;
  return total;
}

/**
 * A message.created in a channel the user is NOT actively viewing increments its
 * unread count. `activeChannelId` is the open channel (its unread stays 0), and
 * `currentUserId` prevents counting the user's own messages.
 */
export function applyUnreadEvent(
  map: UnreadMap,
  event: ChatRealtimeEvent,
  activeChannelId: common.ChannelId | null,
  currentUserId: common.UserId,
): UnreadMap {
  if (event.kind !== "message.created") return map;
  if (event.channelId === activeChannelId) return map;
  if (event.authorId === currentUserId) return map;
  const prev = map[event.channelId];
  const mentioned = /<@([A-Za-z0-9_]+)>/.test(event.body) && event.body.includes(`<@${currentUserId}>`);
  const next: UnreadSummary = prev
    ? { ...prev, unreadCount: prev.unreadCount + 1, mentioned: prev.mentioned || mentioned }
    : { channelId: event.channelId, unreadCount: 1, lastReadMessageId: null, mentioned };
  return { ...map, [event.channelId]: next };
}

/** Clear unread for a channel once the user reads to `lastReadMessageId`. */
export function clearUnread(map: UnreadMap, channelId: common.ChannelId, lastReadMessageId: common.MessageId): UnreadMap {
  const prev = map[channelId];
  if (!prev) return map;
  return { ...map, [channelId]: { ...prev, unreadCount: 0, lastReadMessageId, mentioned: false } };
}
