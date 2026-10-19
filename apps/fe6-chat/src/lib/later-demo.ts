// VITE_DEMO helpers for 「後で」 + message link cards: the demo transport seeds a few
// saved items / reminders for its signed-in account (same localStorage format as
// message-prefs, written once — the user's own edits are never overwritten) and
// builds message permalinks on the page's origin so the seeded links unfurl.
import type { common } from "@dub/types";
import { buildForwardBody, messagePermalink } from "./forward";
import { emptyPrefs, prefsStorageKey, type MessagePrefsData, type SavedMessageRef } from "./message-prefs";

/** Permalink on the current page origin (the demo SPA serves /chat at the root). */
export function demoMessageLink(channelId: string, messageId: string): string {
  const origin = globalThis.location?.origin ?? "https://app.developershub.jp";
  return messagePermalink({ origin, pathname: "/chat" }, channelId as common.ChannelId, messageId as common.MessageId);
}

export { buildForwardBody };

export interface LaterDemoSeed {
  saved: SavedMessageRef[];
  /** Reminder due `inMinutes` after the seed time. */
  reminders: (SavedMessageRef & { inMinutes: number })[];
  completed: SavedMessageRef[];
}

/** Writes the demo prefs for `userId` unless that user already has any. */
export function seedLaterDemoPrefs(userId: string, seed: LaterDemoSeed, now = new Date()): void {
  const store = globalThis.localStorage;
  if (!store || store.getItem(prefsStorageKey(userId)) !== null) return;
  const iso = (offsetMin: number) => new Date(now.getTime() + offsetMin * 60_000).toISOString();
  const data: MessagePrefsData = {
    ...emptyPrefs(),
    bookmarks: seed.saved.map((r, i) => ({ ...r, savedAt: iso(-60 * (i + 1)) })),
    reminders: seed.reminders.map(({ inMinutes, ...r }) => ({ ...r, id: `${r.messageId}:demo`, dueAt: iso(inMinutes) })),
    completed: seed.completed.map((r) => ({ ...r, completedAt: iso(-24 * 60) })),
  };
  try {
    store.setItem(prefsStorageKey(userId), JSON.stringify(data));
  } catch {
    // private mode / quota: the demo just starts empty
  }
}
