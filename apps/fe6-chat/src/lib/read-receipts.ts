// Client-side read receipts (既読) for the chat UI. DISPLAY-only, like presence.ts
// and typing.ts: production would feed each member's lastRead watermark from the
// realtime read-state fanout; here an in-memory pub/sub provider holds a per-channel
// map of userId -> lastReadMessageId so own messages can render "既読 / N人が既読".
// Message ids are ULIDs — lexical order is chronological, so a reader has "read" a
// message when their watermark id >= that message id. FE-only — no backend contract.
import type { common } from "@dub/types";

type Listener = () => void;

interface ChannelReceipts {
  watermarks: Map<common.UserId, common.MessageId>;
  version: number;
}

const byChannel = new Map<common.ChannelId, ChannelReceipts>();
const listeners = new Map<common.ChannelId, Set<Listener>>();

function slot(channelId: common.ChannelId): ChannelReceipts {
  let s = byChannel.get(channelId);
  if (!s) {
    s = { watermarks: new Map(), version: 0 };
    byChannel.set(channelId, s);
  }
  return s;
}

function notify(channelId: common.ChannelId): void {
  const set = listeners.get(channelId);
  if (set) for (const cb of set) cb();
}

/** Advance `userId`'s read watermark in `channelId` (never moves it backwards). */
export function setReader(channelId: common.ChannelId, userId: common.UserId, messageId: common.MessageId): void {
  const s = slot(channelId);
  const cur = s.watermarks.get(userId);
  if (cur !== undefined && cur >= messageId) return; // ULID ascending → no regress
  s.watermarks.set(userId, messageId);
  s.version++;
  notify(channelId);
}

/** User ids that have read up to (>=) `messageId`, excluding `exclude` (self/author). */
export function getReadersOf(
  channelId: common.ChannelId,
  messageId: common.MessageId,
  exclude: readonly common.UserId[] = [],
): common.UserId[] {
  const s = byChannel.get(channelId);
  if (!s) return [];
  const skip = new Set(exclude);
  const out: common.UserId[] = [];
  for (const [userId, watermark] of s.watermarks) {
    if (skip.has(userId)) continue;
    if (watermark >= messageId) out.push(userId);
  }
  return out;
}

/** Monotonic version — the useSyncExternalStore snapshot (a stable primitive). */
export function getReceiptsVersion(channelId: common.ChannelId): number {
  return byChannel.get(channelId)?.version ?? 0;
}

export function subscribeReceipts(channelId: common.ChannelId, cb: Listener): () => void {
  let set = listeners.get(channelId);
  if (!set) {
    set = new Set();
    listeners.set(channelId, set);
  }
  set.add(cb);
  return () => set.delete(cb);
}

/** Test/demo helper: clear all read-receipt state. */
export function resetReceipts(): void {
  byChannel.clear();
}
