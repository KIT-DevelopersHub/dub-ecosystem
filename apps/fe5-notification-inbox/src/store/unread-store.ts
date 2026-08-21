// Single source of truth for the unread badge count (FE5 §1). The header bell,
// the nav badge (badgeSource), and optimistic read operations all read/write
// this one store — the SPA shell must NOT run its own poller.

import { create } from "zustand";

interface UnreadStore {
  count: number;
  initialized: boolean;
  setCount(count: number): void;
  // Optimistic decrement on read (never below 0).
  decrement(by?: number): void;
  reset(count: number): void;
}

export const useUnreadStore = create<UnreadStore>((set) => ({
  count: 0,
  initialized: false,
  setCount: (count) => set({ count: Math.max(0, count), initialized: true }),
  decrement: (by = 1) =>
    set((s) => ({ count: Math.max(0, s.count - by), initialized: true })),
  reset: (count) => set({ count: Math.max(0, count), initialized: true }),
}));

// Non-hook accessor: a one-shot getState read. Handy for imperative call sites,
// but it does NOT subscribe — a consumer that renders this value will not update
// when the store changes. The nav/launcher badge must stay live, so it uses the
// reactive hook below instead.
export function getUnreadCount(): number {
  return useUnreadStore.getState().count;
}

// Reactive badge selector for the nav / 9-dot launcher tile (FeatureModule.nav.
// badgeSource). Subscribes to the shared unread store so every consumer — the
// header bell AND the launcher tile — re-renders together when the count changes
// (A04: the launcher badge previously read getUnreadCount once and never updated).
// Mirrors FE6's useChatUnreadTotal, the established badgeSource-as-hook pattern.
export function useUnreadBadge(): number {
  return useUnreadStore((s) => s.count);
}
