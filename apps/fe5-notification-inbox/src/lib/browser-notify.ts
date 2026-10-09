// Browser (OS) notifications for chat @mentions. The in-app inbox already gets a
// `chat.mention` row per mention; this layer mirrors NEW ones to the Web Notification
// API while the app is open but not focused. Opt-in per device: the user enables it in
// アカウント設定 (stored in localStorage) AND the browser permission must be "granted".
// No push subscription / service worker — only works while a tab is open.

import type { InboxItem } from "../contracts/notification-api";

export const BROWSER_NOTIFY_PREF_KEY = "dub.browserNotify.enabled";
export const CHAT_MENTION_TYPE = "chat.mention";
/** Fired on window when the setting flips, so an already-mounted notifier can re-baseline. */
export const BROWSER_NOTIFY_CHANGE_EVENT = "dub:browser-notify-change";

export type BrowserNotifyPermission = NotificationPermission | "unsupported";

export function isBrowserNotifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getBrowserNotifyPermission(): BrowserNotifyPermission {
  return isBrowserNotifySupported() ? Notification.permission : "unsupported";
}

export function getBrowserNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(BROWSER_NOTIFY_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBrowserNotifyEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(BROWSER_NOTIFY_PREF_KEY, "1");
    else localStorage.removeItem(BROWSER_NOTIFY_PREF_KEY);
  } catch {
    // storage unavailable (private mode) -> setting just doesn't persist
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BROWSER_NOTIFY_CHANGE_EVENT));
}

/** Setting on AND permission granted — the only state in which we show anything. */
export function isBrowserNotifyActive(): boolean {
  return getBrowserNotifyEnabled() && getBrowserNotifyPermission() === "granted";
}

/** Ask the browser for permission (must run inside a user gesture). */
export async function requestBrowserNotifyPermission(): Promise<BrowserNotifyPermission> {
  if (!isBrowserNotifySupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export interface BrowserNotice {
  title: string;
  body: string;
  tag: string; // same tag across tabs -> the OS shows it once
  onClick?: () => void;
}

export function showBrowserNotice(notice: BrowserNotice): void {
  if (!isBrowserNotifySupported()) return;
  try {
    const n = new Notification(notice.title, { body: notice.body, tag: notice.tag });
    n.onclick = () => {
      window.focus();
      notice.onClick?.();
      n.close();
    };
  } catch {
    // Some browsers (Android Chrome) only allow notifications via a service worker.
  }
}

export function mentionNotice(item: InboxItem): Omit<BrowserNotice, "onClick"> {
  const who = item.actorName?.trim();
  return {
    title: who ? `${who} さんがあなたをメンションしました` : item.title || "メンションされました",
    body: "クリックしてチャットを開く",
    tag: `dub-notif-${item.id}`,
  };
}

export interface MentionNotifierDeps {
  fetchUnread: () => Promise<InboxItem[]>;
  notify: (item: InboxItem) => void;
  isActive?: () => boolean;
  /** True when the user is NOT looking at the app (then the bell alone isn't enough). */
  isAway?: () => boolean;
}

export interface MentionNotifier {
  /** Re-read unread mentions and notify the ones not seen before. */
  check(): Promise<void>;
}

/**
 * Diff-based notifier. The first successful check only records a baseline, so mentions
 * that were already unread when the app opened never fire. Later checks notify ids that
 * weren't in the seen set. Ids are remembered even while inactive/focused, so turning
 * the setting on (or leaving the tab) never replays old mentions.
 */
export function createMentionNotifier(deps: MentionNotifierDeps): MentionNotifier {
  const isActive = deps.isActive ?? isBrowserNotifyActive;
  const isAway =
    deps.isAway ?? (() => typeof document !== "undefined" && (document.hidden || !document.hasFocus()));
  const seen = new Set<string>();
  let baselined = false;
  let inFlight: Promise<void> | null = null;

  async function run(): Promise<void> {
    const items = (await deps.fetchUnread()).filter((i) => i.type === CHAT_MENTION_TYPE && !i.readAt);
    const fresh = items.filter((i) => !seen.has(i.id));
    for (const i of items) seen.add(i.id);
    if (!baselined) {
      baselined = true;
      return;
    }
    if (fresh.length === 0 || !isActive() || !isAway()) return;
    for (const i of fresh) deps.notify(i);
  }

  return {
    check() {
      // Serialise: overlapping checks would both see the same id as fresh.
      inFlight = (inFlight ?? Promise.resolve()).then(run).catch(() => undefined);
      return inFlight;
    },
  };
}
