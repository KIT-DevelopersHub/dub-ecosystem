// Client-side "typing…" presence for the chat UI (design §2-5). Like presence.ts
// this is a DISPLAY-only concern: in production it would be fed by the realtime
// channel (a `typing` fanout the frozen wire contract will grow later); for the
// standalone demo + shell mount a small in-memory pub/sub provider drives it so
// the "○○さんが入力中…" indicator is visible. FE-only — no backend contract.
import type { common } from "@dub/types";

type Listener = () => void;

interface ChannelTyping {
  ids: common.UserId[]; // stable reference — only replaced when the set changes
  timers: Map<common.UserId, ReturnType<typeof setTimeout>>;
  version: number;
}

const EMPTY: readonly common.UserId[] = Object.freeze([]);
const byChannel = new Map<common.ChannelId, ChannelTyping>();
const listeners = new Map<common.ChannelId, Set<Listener>>();

export const TYPING_TTL_MS = 4000;

function slot(channelId: common.ChannelId): ChannelTyping {
  let s = byChannel.get(channelId);
  if (!s) {
    s = { ids: [], timers: new Map(), version: 0 };
    byChannel.set(channelId, s);
  }
  return s;
}

function notify(channelId: common.ChannelId): void {
  const set = listeners.get(channelId);
  if (set) for (const cb of set) cb();
}

/** Mark `userId` as typing in `channelId` for `ttlMs` (auto-clears when it lapses). */
export function setTyping(channelId: common.ChannelId, userId: common.UserId, ttlMs = TYPING_TTL_MS): void {
  const s = slot(channelId);
  const existing = s.timers.get(userId);
  if (existing) clearTimeout(existing);
  s.timers.set(
    userId,
    setTimeout(() => clearTyping(channelId, userId), ttlMs),
  );
  if (!s.ids.includes(userId)) {
    s.ids = [...s.ids, userId]; // new reference → useSyncExternalStore re-renders
    s.version++;
    notify(channelId);
  }
}

/** Clear a single user's typing flag (called on TTL lapse or an explicit stop). */
export function clearTyping(channelId: common.ChannelId, userId: common.UserId): void {
  const s = byChannel.get(channelId);
  if (!s) return;
  const t = s.timers.get(userId);
  if (t) {
    clearTimeout(t);
    s.timers.delete(userId);
  }
  if (s.ids.includes(userId)) {
    s.ids = s.ids.filter((id) => id !== userId);
    s.version++;
    notify(channelId);
  }
}

/** Current typing users for a channel (stable reference until the set changes). */
export function getTypingUsers(channelId: common.ChannelId): readonly common.UserId[] {
  return byChannel.get(channelId)?.ids ?? EMPTY;
}

/** Monotonic version — the useSyncExternalStore snapshot (a stable primitive). */
export function getTypingVersion(channelId: common.ChannelId): number {
  return byChannel.get(channelId)?.version ?? 0;
}

export function subscribeTyping(channelId: common.ChannelId, cb: Listener): () => void {
  let set = listeners.get(channelId);
  if (!set) {
    set = new Set();
    listeners.set(channelId, set);
  }
  set.add(cb);
  return () => set.delete(cb);
}

/** Test/demo helper: clear all typing state (also releases pending timers). */
export function resetTyping(): void {
  for (const s of byChannel.values()) for (const t of s.timers.values()) clearTimeout(t);
  byChannel.clear();
}
