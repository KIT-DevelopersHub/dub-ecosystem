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
  /** Set for thread replies (the jump opens the thread). */
  threadRootId?: common.MessageId | null;
}

export interface Bookmark extends SavedMessageRef {
  savedAt: string;
}

export interface Reminder extends SavedMessageRef {
  id: string;
  dueAt: string;
}

/** 「後で」 の 「完了」 タブ: saved items / reminders the user checked off. */
export interface CompletedItem extends SavedMessageRef {
  completedAt: string;
}

export interface MessagePrefsData {
  reactionUsage: Record<string, number>;
  bookmarks: Bookmark[];
  reminders: Reminder[];
  follows: common.MessageId[];
  completed: CompletedItem[];
}

export const MAX_COMPLETED = 50;

export const emptyPrefs = (): MessagePrefsData => ({ reactionUsage: {}, bookmarks: [], reminders: [], follows: [], completed: [] });

/** Sidebar 「後で」 badge: distinct messages that are saved or have a pending reminder. */
export function laterCount(p: Pick<MessagePrefsData, "bookmarks" | "reminders">): number {
  return new Set([...p.bookmarks.map((b) => b.messageId), ...p.reminders.map((r) => r.messageId)]).size;
}

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
  { id: "tomorrow", label: "明日" },
  { id: "nextWeek", label: "来週" },
];

/** Hint shown next to a preset (Slack shows the resolved time on the right). */
export function reminderPresetHint(preset: ReminderPreset, now: Date): string {
  const d = reminderDueAt(preset, now);
  return preset === "nextWeek" ? `${WEEKDAYS[d.getDay()]} ${hm(d)}` : hm(d);
}

const WEEKDAYS = ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"];
const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 「今日 15:00」 / 「明日 9:00」 / 「10月26日 9:00」 — reminder due label. */
export function formatDue(due: Date, now: Date): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(due) - day(now)) / 86_400_000);
  if (diff === 0) return `今日 ${hm(due)}`;
  if (diff === 1) return `明日 ${hm(due)}`;
  return `${due.getMonth() + 1}月${due.getDate()}日 ${hm(due)}`;
}

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
      completed: Array.isArray(p.completed) ? p.completed : [],
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
  /** 「リマインダーを変更」: same message, new due time. */
  rescheduleReminder: (id: string, dueAt: Date) => void;
  removeReminder: (id: string) => void;
  /**
   * Removes due reminders and returns only those this call removed (one tab fires each).
   * A fired reminder stays in 「後で」 as a saved item until the user completes it (Slack).
   */
  takeDueReminders: (now: Date) => Reminder[];
  toggleFollow: (messageId: common.MessageId) => boolean; // true = now following
  /** 「完了にする」: drop the message's saved item + reminders into the 完了 tab. */
  complete: (messageId: common.MessageId) => void;
  /** 「後で に戻す」 from 完了. */
  restore: (messageId: common.MessageId) => void;
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
          ? [{ ...toRef(ref), savedAt: new Date().toISOString() }, ...c.bookmarks]
          : c.bookmarks.filter((b) => b.messageId !== ref.messageId);
        // Saving again takes it back out of 完了 (one item, one tab).
        const completed = on ? (c.completed ?? []).filter((x) => x.messageId !== ref.messageId) : c.completed;
        return { next: { ...c, bookmarks, completed }, result: on };
      }),
    addReminder: (ref, dueAt) =>
      update((c) => {
        const id = `${ref.messageId}:${dueAt.getTime()}`;
        const reminders = [...c.reminders.filter((r) => r.id !== id), { ...toRef(ref), id, dueAt: dueAt.toISOString() }];
        const completed = (c.completed ?? []).filter((x) => x.messageId !== ref.messageId);
        return { next: { ...c, reminders, completed }, result: undefined };
      }),
    rescheduleReminder: (id, dueAt) =>
      update((c) => ({
        next: { ...c, reminders: c.reminders.map((r) => (r.id === id ? { ...r, dueAt: dueAt.toISOString() } : r)) },
        result: undefined,
      })),
    removeReminder: (id) => update((c) => ({ next: { ...c, reminders: c.reminders.filter((r) => r.id !== id) }, result: undefined })),
    takeDueReminders: (now) =>
      update((c) => {
        const { due, rest } = partitionDue(c.reminders, now);
        if (due.length === 0) return { next: c, result: due };
        const saved = new Set(c.bookmarks.map((b) => b.messageId));
        const keep: Bookmark[] = [];
        for (const { id: _id, dueAt, ...ref } of due) {
          if (saved.has(ref.messageId)) continue;
          saved.add(ref.messageId);
          keep.push({ ...ref, savedAt: dueAt });
        }
        return { next: { ...c, reminders: rest, bookmarks: [...keep, ...c.bookmarks] }, result: due };
      }),
    complete: (messageId) =>
      update((c) => {
        const ref: SavedMessageRef | undefined =
          c.bookmarks.find((b) => b.messageId === messageId) ?? c.reminders.find((r) => r.messageId === messageId);
        if (!ref) return { next: c, result: undefined };
        const done: CompletedItem = { ...toRef(ref), completedAt: new Date().toISOString() };
        return {
          next: {
            ...c,
            bookmarks: c.bookmarks.filter((b) => b.messageId !== messageId),
            reminders: c.reminders.filter((r) => r.messageId !== messageId),
            completed: [done, ...c.completed.filter((x) => x.messageId !== messageId)].slice(0, MAX_COMPLETED),
          },
          result: undefined,
        };
      }),
    restore: (messageId) =>
      update((c) => {
        const done = c.completed.find((x) => x.messageId === messageId);
        if (!done) return { next: c, result: undefined };
        const bookmarks = c.bookmarks.some((b) => b.messageId === messageId)
          ? c.bookmarks
          : [{ ...toRef(done), savedAt: new Date().toISOString() }, ...c.bookmarks];
        return { next: { ...c, bookmarks, completed: c.completed.filter((x) => x.messageId !== messageId) }, result: undefined };
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
  return { reactionUsage: s.reactionUsage, bookmarks: s.bookmarks, reminders: s.reminders, follows: s.follows, completed: s.completed ?? [] };
}

function toRef(r: SavedMessageRef): SavedMessageRef {
  return {
    messageId: r.messageId,
    channelId: r.channelId,
    authorId: r.authorId,
    excerpt: r.excerpt,
    ...(r.threadRootId ? { threadRootId: r.threadRootId } : {}),
  };
}

/** localStorage key for a user's prefs (the `storage` event filter). */
export const prefsStorageKey = (userId: string): string => STORAGE_PREFIX + userId;
