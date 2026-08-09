// useUnreadCount — the single source of truth for the unread badge.
// Polls unread-count (60s, paused when tab hidden), seeds from the BFF hint,
// and exposes an optimistic decrement via the shared store (FE5 §1, test 10).

import { useCallback, useEffect, useRef } from "react";
import { useNotificationDeps } from "../context";
import { createUnreadPoller, type Poller } from "../lib/poller";
import { useUnreadStore } from "../store/unread-store";

export interface UseUnreadCountResult {
  count: number; // optimistic display value (the one source of truth)
  refresh(): Promise<void>; // manual re-fetch
}

export function useUnreadCount(): UseUnreadCountResult {
  const { api, initialUnreadHint, pollIntervalMs } = useNotificationDeps();
  const count = useUnreadStore((s) => s.count);
  const initialized = useUnreadStore((s) => s.initialized);
  const setCount = useUnreadStore((s) => s.setCount);
  const pollerRef = useRef<Poller | null>(null);

  // Seed from the BFF hint once, before the first poll resolves.
  useEffect(() => {
    if (!initialized && typeof initialUnreadHint === "number") {
      setCount(initialUnreadHint);
    }
  }, [initialized, initialUnreadHint, setCount]);

  const refresh = useCallback(async () => {
    const res = await api.getUnreadCount();
    setCount(res.count);
  }, [api, setCount]);

  useEffect(() => {
    const poller = createUnreadPoller({
      fetchCount: async () => (await api.getUnreadCount()).count,
      onValue: (c) => setCount(c),
      // onError omitted -> silent, keep last value (test 10).
      ...(pollIntervalMs !== undefined ? { intervalMs: pollIntervalMs } : {}),
    });
    pollerRef.current = poller;
    poller.start();

    const onVisibility = (): void => {
      if (typeof document !== "undefined" && !document.hidden) void poller.poll();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      poller.stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [api, setCount, pollIntervalMs]);

  return { count, refresh };
}
