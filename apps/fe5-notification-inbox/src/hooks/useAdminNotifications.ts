// useAdminNotifications — Notification management state: load the audience='admin'
// notification list, and publish one to all members with an OPTIMISTIC update (the row
// flips to "公開済み" instantly; a failed commit rolls it back). Admin-only surface (the
// shell gates the route on notif:broadcast_publish).

import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../contracts/fe2";
import { isApiError } from "../contracts/fe2";
import type { AdminNotificationItem } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";

// Placeholder id used while a publish is in flight so the badge/button reflect the
// pending state immediately (replaced by the server id on success).
export const PENDING_BROADCAST_ID = "__pending__";

export interface UseAdminNotificationsResult {
  items: AdminNotificationItem[];
  loading: boolean;
  error: ApiError | null;
  /** ids currently being published (button shows a spinner). */
  publishing: ReadonlySet<string>;
  publish(id: string): Promise<void>;
  reload(): Promise<void>;
}

export function useAdminNotifications(): UseAdminNotificationsResult {
  const { api, toast } = useNotificationDeps();
  const [items, setItems] = useState<AdminNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [publishing, setPublishing] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listAdminNotifications();
      setItems(page.items);
    } catch (err) {
      if (isApiError(err)) setError(err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setPublished = useCallback((id: string, broadcastId: string | null) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, publishedBroadcastId: broadcastId } : it)));
  }, []);

  const publish = useCallback(
    async (id: string) => {
      const current = items.find((it) => it.id === id);
      if (!current || current.publishedBroadcastId || publishing.has(id)) return;

      // Optimistic: flip to "公開済み" immediately + show the button spinner.
      setPublished(id, PENDING_BROADCAST_ID);
      setPublishing((s) => new Set(s).add(id));
      try {
        const res = await api.publishBroadcast(id);
        setPublished(id, res.publishedBroadcastId); // reconcile with the real id
        toast.show("success", res.deduplicated ? "このお知らせは既に配信済みです" : "メンバー全員に公開しました");
      } catch (err) {
        setPublished(id, null); // rollback the optimistic badge
        const msg = isApiError(err) ? `公開に失敗しました (${err.code})` : "公開に失敗しました";
        toast.show("error", msg);
      } finally {
        setPublishing((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
    },
    [api, items, publishing, setPublished, toast],
  );

  return { items, loading, error, publishing, publish, reload };
}
