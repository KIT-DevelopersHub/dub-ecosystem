// useMentionBrowserNotify — mirrors new chat @mentions to OS notifications.
// Rides the existing unread-count pipeline (WS push + poller): whenever the count goes
// UP while browser notifications are active, re-read the unread inbox and notify the
// mentions not seen before. Mounted once by NotificationBell (every signed-in page).

import { useEffect, useMemo, useRef } from "react";
import { useNotificationDeps } from "../context";
import { useUnreadStore } from "../store/unread-store";
import { itemLinkUrl } from "../components/NotificationCard";
import {
  BROWSER_NOTIFY_CHANGE_EVENT,
  createMentionNotifier,
  isBrowserNotifyActive,
  mentionNotice,
  showBrowserNotice,
} from "../lib/browser-notify";

const FETCH_LIMIT = 20;

export function useMentionBrowserNotify(): void {
  const { api, navigate } = useNotificationDeps();
  const count = useUnreadStore((s) => s.count);
  const prevCount = useRef<number | null>(null);

  const notifier = useMemo(
    () =>
      createMentionNotifier({
        fetchUnread: async () => (await api.listInbox({ unreadOnly: true, limit: FETCH_LIMIT })).items ?? [],
        notify: (item) => {
          const link = itemLinkUrl(item);
          showBrowserNotice({ ...mentionNotice(item), ...(link ? { onClick: () => navigate(link) } : {}) });
        },
      }),
    [api, navigate],
  );

  // Baseline on mount and whenever the setting is switched on, so already-unread
  // mentions never fire as "new".
  useEffect(() => {
    const baseline = (): void => {
      if (isBrowserNotifyActive()) void notifier.check();
    };
    baseline();
    window.addEventListener(BROWSER_NOTIFY_CHANGE_EVENT, baseline);
    return () => window.removeEventListener(BROWSER_NOTIFY_CHANGE_EVENT, baseline);
  }, [notifier]);

  useEffect(() => {
    const prev = prevCount.current;
    prevCount.current = count;
    if (prev !== null && count > prev && isBrowserNotifyActive()) void notifier.check();
  }, [count, notifier]);
}
