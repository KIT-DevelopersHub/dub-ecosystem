// React bindings for the display-only typing / read-receipt stores, plus the demo
// "liveness" simulator that drives them when no real realtime backend is present
// (standalone mock + the VITE_DEMO shell transport — neither has a chat WS). In a
// live deployment the realtime channel feeds these stores instead and the simulator
// stays off (enabled=false). Keeping the simulation here (not in the stores) means
// the stores are a clean seam a real RT adapter can replace.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { common } from "@dub/types";
import type { ChannelMember, Message } from "../api/contract";
import { getTypingUsers, getTypingVersion, setTyping, subscribeTyping } from "../lib/typing";
import { getReceiptsVersion, setReader, subscribeReceipts } from "../lib/read-receipts";

/** Subscribe to the typing set for a channel (re-renders when it changes). */
export function useTypingUsers(channelId: common.ChannelId): readonly common.UserId[] {
  const subscribe = useCallback((cb: () => void) => subscribeTyping(channelId, cb), [channelId]);
  const version = useSyncExternalStore(
    subscribe,
    () => getTypingVersion(channelId),
    () => 0,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getTypingUsers(channelId), [channelId, version]);
}

/** Subscribe to the read-receipt version for a channel (bumps on every watermark move). */
export function useReceiptsVersion(channelId: common.ChannelId): number {
  const subscribe = useCallback((cb: () => void) => subscribeReceipts(channelId, cb), [channelId]);
  return useSyncExternalStore(
    subscribe,
    () => getReceiptsVersion(channelId),
    () => 0,
  );
}

const TYPING_MIN_GAP_MS = 5500;
const TYPING_MAX_GAP_MS = 11000;
const TYPING_BURST_MS = 3200;
const READ_AFTER_SEND_MS = 1800;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Demo simulator: makes seeded peers periodically "type" in the active channel and
 * advances their read watermarks so 既読 appears live. No-op when `enabled` is false
 * (i.e. a real RT backend is wired). Seeds every peer's watermark to the second-newest
 * message on entry so existing own messages already read realistically, then advances
 * all peers onto each new message the current user sends shortly after they send it.
 */
export function useChatDemoLiveness(opts: {
  enabled: boolean;
  channelId: common.ChannelId;
  currentUserId: common.UserId;
  members: ChannelMember[];
  messages: Message[];
}): void {
  const { enabled, channelId, currentUserId, members, messages } = opts;

  const peers = useMemo(
    () => members.map((m) => m.userId).filter((id) => id !== currentUserId),
    [members, currentUserId],
  );

  // Seed each peer's read watermark to the second-newest message so older own messages
  // render 既読 immediately, while the very latest stays "not yet read by everyone".
  const seededRef = useRef<common.ChannelId | null>(null);
  useEffect(() => {
    if (!enabled || peers.length === 0 || messages.length === 0) return;
    if (seededRef.current === channelId) return;
    seededRef.current = channelId;
    const anchor = messages[messages.length - 2] ?? messages[messages.length - 1];
    if (!anchor) return;
    for (const p of peers) setReader(channelId, p, anchor.id);
  }, [enabled, channelId, peers, messages]);

  // Typing loop: a random peer types for a short burst on a jittered interval.
  useEffect(() => {
    if (!enabled || peers.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const who = peers[Math.floor(Math.random() * peers.length)];
      if (who) setTyping(channelId, who, TYPING_BURST_MS);
      timer = setTimeout(tick, rand(TYPING_MIN_GAP_MS, TYPING_MAX_GAP_MS));
    };
    timer = setTimeout(tick, rand(1500, 3500));
    return () => clearTimeout(timer);
  }, [enabled, channelId, peers]);

  // When the current user sends a new message, peers "read" it after a short delay.
  const newest = messages[messages.length - 1];
  const newestOwnId = newest && newest.authorId === currentUserId ? newest.id : null;
  useEffect(() => {
    if (!enabled || !newestOwnId || peers.length === 0) return;
    const t = setTimeout(() => {
      for (const p of peers) setReader(channelId, p, newestOwnId);
    }, READ_AFTER_SEND_MS);
    return () => clearTimeout(t);
  }, [enabled, channelId, newestOwnId, peers]);
}
