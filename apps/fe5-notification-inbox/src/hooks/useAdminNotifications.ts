// useAdminNotifications — Notification management state: load the audience='admin'
// notification list, and publish one to all members with an OPTIMISTIC update (the row
// flips to "公開済み" instantly; a failed commit rolls it back). Admin-only surface (the
// shell gates the route on notif:broadcast_publish).

import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../contracts/fe2";
import { isApiError } from "../contracts/fe2";
import type { AdminNotificationItem, PublishBroadcastBatchResponse } from "../contracts/notification-api";
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
  /** Bulk publish many ids in ONE request; optimistic + per-item reconcile. Returns the
   *  batch outcome (null when nothing was eligible) so the caller can clear its selection. */
  publishMany(ids: string[]): Promise<PublishBroadcastBatchResponse | null>;
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

  const publishMany = useCallback(
    async (ids: string[]): Promise<PublishBroadcastBatchResponse | null> => {
      // Only eligible ids: exist, not already published, not mid-flight. Dedupe.
      const byId = new Map(items.map((it) => [it.id, it]));
      const eligible = [...new Set(ids)].filter((id) => {
        const it = byId.get(id);
        return it && it.publishedBroadcastId === null && !publishing.has(id);
      });
      if (eligible.length === 0) return null;

      // Optimistic: flip every eligible row to 公開済み + mark them publishing — ONE state
      // update each (not per-id churn), so a large selection stays responsive.
      setItems((prev) => prev.map((it) => (eligible.includes(it.id) ? { ...it, publishedBroadcastId: PENDING_BROADCAST_ID } : it)));
      setPublishing((s) => {
        const next = new Set(s);
        for (const id of eligible) next.add(id);
        return next;
      });

      try {
        const res = await api.publishBroadcastBatch(eligible);
        // Reconcile per item in a single pass: ok → real id, failed → rollback to null.
        const outcome = new Map(res.results.map((r) => [r.id, r]));
        setItems((prev) =>
          prev.map((it) => {
            const r = outcome.get(it.id);
            if (!r) return it;
            return { ...it, publishedBroadcastId: r.ok ? (r.publishedBroadcastId ?? PENDING_BROADCAST_ID) : null };
          }),
        );
        const parts = [`${res.publishedCount}件を公開`];
        if (res.deduplicatedCount > 0) parts.push(`${res.deduplicatedCount}件は既公開`);
        if (res.failedCount > 0) parts.push(`${res.failedCount}件失敗`);
        toast.show(res.failedCount > 0 ? "error" : "success", parts.join(" / "));
        return res;
      } catch (err) {
        // Whole request failed → roll back every optimistic flip.
        setItems((prev) => prev.map((it) => (eligible.includes(it.id) ? { ...it, publishedBroadcastId: null } : it)));
        toast.show("error", isApiError(err) ? `一括公開に失敗しました (${err.code})` : "一括公開に失敗しました");
        return null;
      } finally {
        setPublishing((s) => {
          const next = new Set(s);
          for (const id of eligible) next.delete(id);
          return next;
        });
      }
    },
    [api, items, publishing, toast],
  );

  return { items, loading, error, publishing, publish, publishMany, reload };
}
