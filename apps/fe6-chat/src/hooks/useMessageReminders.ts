/// <reference lib="dom" />
// Fires 「リマインダーを追加」 reminders while chat is open: a toast (plus an OS
// notification when the user already granted it — we never prompt here), and keeps
// prefs in sync across tabs. Due reminders are removed as they fire, so a reload
// never repeats one; anything that fell due while chat was closed fires on next open.
import { useEffect, useRef } from "react";
import { useToast } from "@dub/ui";
import type { common } from "@dub/types";
import { prefsStorageKey, useMessagePrefs } from "../lib/message-prefs";

export const REMINDER_TICK_MS = 15_000;

export function useMessageReminders(resolveChannelName: (id: common.ChannelId) => string | undefined): void {
  const { show } = useToast();
  const takeDueReminders = useMessagePrefs((s) => s.takeDueReminders);
  const reload = useMessagePrefs((s) => s.reload);
  const userId = useMessagePrefs((s) => s.userId);
  const nameRef = useRef(resolveChannelName);
  nameRef.current = resolveChannelName;

  useEffect(() => {
    if (!userId) return;
    const fire = () => {
      // Taken from storage, so with several tabs open each reminder fires in one tab.
      const due = takeDueReminders(new Date());
      for (const r of due) {
        const where = nameRef.current(r.channelId) ?? "チャット";
        const body = r.excerpt || "(添付ファイル)";
        show({ kind: "info", title: `リマインダー: ${where} のメッセージ`, description: body, durationMs: 15_000 });
        const N = globalThis.Notification;
        if (N && N.permission === "granted") {
          try {
            new N(`リマインダー: ${where}`, { body, tag: r.id });
          } catch {
            // some browsers only allow notifications from a service worker
          }
        }
      }
    };
    fire();
    const handle = globalThis.setInterval(fire, REMINDER_TICK_MS);
    // Another tab added/removed a bookmark, reminder, follow: show it here too.
    const onStorage = (e: StorageEvent) => e.key === prefsStorageKey(userId) && reload();
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      globalThis.clearInterval(handle);
      globalThis.removeEventListener?.("storage", onStorage);
    };
  }, [userId, takeDueReminders, reload, show]);
}
