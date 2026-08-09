// Pure timeline reducer — the heart of FE6. No React, no I/O; fully unit-tested.
// Invariant: `messages` is ULID-ascending and deduped by id at all times.
import type { common } from "@dub/types";
import type { ChatRealtimeEvent, Message } from "../api/contract";
import type { ChannelViewState, PendingMessage } from "../types";

/** Binary-search insert position for a ULID id in an ascending array. */
function lowerBound(messages: Message[], id: string): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid]!.id < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Insert or replace a message keeping ULID order. Returns a new array. */
export function upsertMessage(messages: Message[], msg: Message): Message[] {
  const at = lowerBound(messages, msg.id);
  const existing = messages[at];
  const next = messages.slice();
  if (existing && existing.id === msg.id) {
    next[at] = msg; // replace (updated/deleted/reaction change or RT echo)
  } else {
    next.splice(at, 0, msg);
  }
  return next;
}

/** Merge an older-history page (any order) without duplicates or gaps. */
export function mergeMessages(messages: Message[], page: Message[]): Message[] {
  let out = messages;
  for (const m of page) out = upsertMessage(out, m);
  return out;
}

/** Tombstone a message in place (kept in timeline, rendered redacted). */
export function markDeleted(messages: Message[], id: common.MessageId, at: common.ISODateTime): Message[] {
  const idx = lowerBound(messages, id);
  const existing = messages[idx];
  if (!existing || existing.id !== id) return messages;
  const next = messages.slice();
  next[idx] = { ...existing, deletedAt: at, body: "", attachments: [] };
  return next;
}

/** Add an optimistic pending message (design §2-5). */
export function addPending(state: ChannelViewState, pending: PendingMessage): ChannelViewState {
  return { ...state, pending: [...state.pending, pending] };
}

/** Server ack: drop the pending entry and insert the real message. */
export function ackPending(state: ChannelViewState, clientTempId: string, message: Message): ChannelViewState {
  return {
    ...state,
    pending: state.pending.filter((p) => p.clientTempId !== clientTempId),
    messages: upsertMessage(state.messages, message),
  };
}

/** Mark a pending entry failed (offers resend/discard in the UI). */
export function failPending(state: ChannelViewState, clientTempId: string): ChannelViewState {
  return {
    ...state,
    pending: state.pending.map((p) => (p.clientTempId === clientTempId ? { ...p, state: "failed" } : p)),
  };
}

/** Discard a failed/pending entry entirely. */
export function discardPending(state: ChannelViewState, clientTempId: string): ChannelViewState {
  return { ...state, pending: state.pending.filter((p) => p.clientTempId !== clientTempId) };
}

/**
 * Apply a frozen ChatRealtimeEvent to the *currently viewed* channel.
 * - message.created: insert at ULID position; if it echoes one of my own pending
 *   sends (same author + identical body) drop that pending to prevent doubles.
 * - message.deleted: tombstone.
 * - member.added/removed: not a timeline mutation here (memberCount handled by the
 *   channel query); returned state is unchanged for those kinds.
 *
 * `currentUserId` enables the self-echo dedupe. Events for other channels must be
 * routed to unread aggregation (store/unread.ts), not here.
 */
export function applyRealtimeEvent(
  state: ChannelViewState,
  event: ChatRealtimeEvent,
  currentUserId: common.UserId,
): ChannelViewState {
  if (event.channelId !== state.channelId) return state;
  switch (event.kind) {
    case "message.created": {
      const echoed =
        event.authorId === currentUserId &&
        state.pending.find((p) => p.state !== "failed" && p.request.body === event.body);
      const message: Message = {
        id: event.messageId,
        channelId: event.channelId,
        authorId: event.authorId,
        body: event.body,
        threadRootId: null,
        replyCount: 0,
        reactions: [],
        attachments: [],
        editedAt: null,
        deletedAt: null,
        version: 1,
        createdAt: event.at,
      };
      const pending = echoed
        ? state.pending.filter((p) => p.clientTempId !== echoed.clientTempId)
        : state.pending;
      return { ...state, pending, messages: upsertMessage(state.messages, message) };
    }
    case "message.deleted":
      return { ...state, messages: markDeleted(state.messages, event.messageId, event.at) };
    case "member.added":
    case "member.removed":
      return state;
    default: {
      // exhaustiveness guard over the frozen union
      const _never: never = event;
      return _never;
    }
  }
}

/** Toggle a reaction locally for optimistic UI (author-agnostic). */
export function toggleReactionLocal(
  messages: Message[],
  id: common.MessageId,
  emoji: string,
  userId: common.UserId,
): Message[] {
  const idx = lowerBound(messages, id);
  const m = messages[idx];
  if (!m || m.id !== id) return messages;
  const reactions = m.reactions.slice();
  const ri = reactions.findIndex((r) => r.emoji === emoji);
  if (ri < 0) {
    reactions.push({ emoji, userIds: [userId] });
  } else {
    const r = reactions[ri]!;
    const has = r.userIds.includes(userId);
    const userIds = has ? r.userIds.filter((u) => u !== userId) : [...r.userIds, userId];
    if (userIds.length === 0) reactions.splice(ri, 1);
    else reactions[ri] = { ...r, userIds };
  }
  const next = messages.slice();
  next[idx] = { ...m, reactions };
  return next;
}
