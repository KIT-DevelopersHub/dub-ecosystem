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

// Non-hook accessor for the nav badgeSource (FeatureModule.nav.badgeSource).
export function getUnreadCount(): number {
  return useUnreadStore.getState().count;
}
