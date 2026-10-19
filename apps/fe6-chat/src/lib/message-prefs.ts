// Per-user message preferences behind the Slack-style message menu: reaction
// frequency (よく使うリアクション), bookmarks, reminders and followed threads.
// Persisted to localStorage under one key per user (this device only — chat-service
// has no table for these yet). Pure helpers are exported for unit tests.
import { create } from "zustand";
import type { common } from "@dub/types";

export const DEFAULT_QUICK_REACTIONS = ["👍", "🎉", "✅"];
const STORAGE_PREFIX = "dub.chat.prefs.";

export interface SavedMessageRef {
  messageId: common.MessageId;
  channelId: common.ChannelId;
  authorId: common.UserId | null;
  excerpt: string;
}

export interface Bookmark extends SavedMessageRef {
  savedAt: string;
}

export interface Reminder extends SavedMessageRef {
  id: string;
  dueAt: string;
}

export interface MessagePrefsData {
  reactionUsage: Record<string, number>;
  bookmarks: Bookmark[];
  reminders: Reminder[];
  follows: common.MessageId[];
}

export const emptyPrefs = (): MessagePrefsData => ({ reactionUsage: {}, bookmarks: [], reminders: [], follows: [] });

/** Most used reactions first; ties and gaps fall back to the defaults. */
export function topReactions(usage: Record<string, number>, n = 3): string[] {
  const used = Object.entries(usage)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e);
  const out: string[] = [];
  for (const e of [...used, ...DEFAULT_QUICK_REACTIONS]) {
    if (!out.includes(e)) out.push(e);
    if (out.length === n) break;
  }
  return out;
}

export type ReminderPreset = "20m" | "1h" | "3h" | "tomorrow" | "nextWeek";

export const REMINDER_PRESETS: { id: ReminderPreset; label: string }[] = [
  { id: "20m", label: "20分後" },
  { id: "1h", label: "1時間後" },
  { id: "3h", label: "3時間後" },
  { id: "tomorrow", label: "明日 9:00" },
  { id: "nextWeek", label: "来週の月曜 9:00" },
];

export function reminderDueAt(preset: ReminderPreset, now: Date): Date {
  const d = new Date(now);
  switch (preset) {
    case "20m":
      return new Date(now.getTime() + 20 * 60_000);
    case "1h":
      return new Date(now.getTime() + 60 * 60_000);
    case "3h":
      return new Date(now.getTime() + 3 * 60 * 60_000);
    case "tomorrow":
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    case "nextWeek": {
      const days = ((8 - d.getDay()) % 7) || 7; // next Monday, never today
      d.setDate(d.getDate() + days);
      d.setHours(9, 0, 0, 0);
      return d;
    }
  }
}

/** Splits reminders into due (to fire now) and the rest. */
export function partitionDue(reminders: Reminder[], now: Date): { due: Reminder[]; rest: Reminder[] } {
  const due: Reminder[] = [];
  const rest: Reminder[] = [];
  for (const r of reminders) (new Date(r.dueAt).getTime() <= now.getTime() ? due : rest).push(r);
  return { due, rest };
}

function load(userId: string): MessagePrefsData {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + userId);
    if (!raw) return emptyPrefs();
    const p = JSON.parse(raw) as Partial<MessagePrefsData>;
    return {
      reactionUsage: p.reactionUsage && typeof p.reactionUsage === "object" ? p.reactionUsage : {},
      bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [],
      reminders: Array.isArray(p.reminders) ? p.reminders : [],
      follows: Array.isArray(p.follows) ? p.follows : [],
    };
  } catch {
    return emptyPrefs();
  }
}

function save(userId: string | null, data: MessagePrefsData): void {
  if (!userId) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + userId, JSON.stringify(data));
  } catch {
    // quota / private mode: keep the in-memory state only
  }
}

interface MessagePrefsStore extends MessagePrefsData {
  userId: string | null;
  hydrate: (userId: string) => void;
  /** Re-read storage (another tab wrote it). */
  reload: () => void;
  recordReaction: (emoji: string) => void;
  toggleBookmark: (ref: SavedMessageRef) => boolean; // true = now bookmarked
  addReminder: (ref: SavedMessageRef, dueAt: Date) => void;
  /** Removes due reminders and returns only those this call removed (one tab fires each). */
  takeDueReminders: (now: Date) => Reminder[];
  toggleFollow: (messageId: common.MessageId) => boolean; // true = now following
}

export const useMessagePrefs = create<MessagePrefsStore>((set, get) => {
  // Read-modify-write against storage, not memory: another tab may have written since
  // this one loaded, and saving a stale snapshot would drop its bookmarks/reminders.
  const update = <T>(fn: (cur: MessagePrefsData) => { next: MessagePrefsData; result: T }): T => {
    const userId = get().userId;
    const cur = userId ? load(userId) : pick(get());
    const { next, result } = fn(cur);
    save(userId, next);
    set(next);
    return result;
  };
  return {
    ...emptyPrefs(),
    userId: null,
    hydrate: (userId) => {
      if (get().userId === userId) return;
      set({ userId, ...load(userId) });
    },
    reload: () => {
      const userId = get().userId;
      if (userId) set(load(userId));
    },
    recordReaction: (emoji) =>
      update((c) => ({
        next: { ...c, reactionUsage: { ...c.reactionUsage, [emoji]: (c.reactionUsage[emoji] ?? 0) + 1 } },
        result: undefined,
      })),
    toggleBookmark: (ref) =>
      update((c) => {
        const on = !c.bookmarks.some((b) => b.messageId === ref.messageId);
        const bookmarks = on
          ? [{ ...ref, savedAt: new Date().toISOString() }, ...c.bookmarks]
          : c.bookmarks.filter((b) => b.messageId !== ref.messageId);
        return { next: { ...c, bookmarks }, result: on };
      }),
    addReminder: (ref, dueAt) =>
      update((c) => {
        const id = `${ref.messageId}:${dueAt.getTime()}`;
        const reminders = [...c.reminders.filter((r) => r.id !== id), { ...ref, id, dueAt: dueAt.toISOString() }];
        return { next: { ...c, reminders }, result: undefined };
      }),
    takeDueReminders: (now) =>
      update((c) => {
        const { due, rest } = partitionDue(c.reminders, now);
        return { next: { ...c, reminders: rest }, result: due };
      }),
    toggleFollow: (messageId) =>
      update((c) => {
        const on = !c.follows.includes(messageId);
        const follows = on ? [...c.follows, messageId] : c.follows.filter((id) => id !== messageId);
        return { next: { ...c, follows }, result: on };
      }),
  };
});

function pick(s: MessagePrefsData): MessagePrefsData {
  return { reactionUsage: s.reactionUsage, bookmarks: s.bookmarks, reminders: s.reminders, follows: s.follows };
}

/** localStorage key for a user's prefs (the `storage` event filter). */
export const prefsStorageKey = (userId: string): string => STORAGE_PREFIX + userId;
