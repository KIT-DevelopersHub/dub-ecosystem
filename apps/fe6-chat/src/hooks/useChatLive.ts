// React bindings for the display-only typing store, plus the demo "liveness"
// simulator that drives it when no real realtime backend is present (standalone mock
// + the VITE_DEMO shell transport — neither has a chat WS). In a live deployment the
// realtime channel feeds the store instead and the simulator stays off (enabled=false).
// Keeping the simulation here (not in the store) means the store is a clean seam a real
// RT adapter can replace. Read state is self-only (Slack-style) — no read watermark is
// ever broadcast to other members, so there is no read-receipt store here.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { common } from "@dub/types";
import type { ChannelMember } from "../api/contract";
import { getTypingUsers, getTypingVersion, setTyping, subscribeTyping } from "../lib/typing";

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

const TYPING_MIN_GAP_MS = 5500;
const TYPING_MAX_GAP_MS = 11000;
const TYPING_BURST_MS = 3200;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Demo simulator: makes seeded peers periodically "type" in the active channel so the
 * typing indicator appears live. No-op when `enabled` is false (i.e. a real RT backend
 * is wired). Read state is deliberately NOT simulated — it is self-only, so no peer
 * "既読" is ever shown.
 */
export function useChatDemoLiveness(opts: {
  enabled: boolean;
  channelId: common.ChannelId;
  currentUserId: common.UserId;
  members: ChannelMember[];
}): void {
  const { enabled, channelId, currentUserId, members } = opts;

  const peers = useMemo(
    () => members.map((m) => m.userId).filter((id) => id !== currentUserId),
    [members, currentUserId],
  );

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
}
