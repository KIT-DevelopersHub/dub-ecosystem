// useInbox — inbox list state: cursor paging (LoadMore, no auto-fire), optimistic
// read / mark-all-read with rollback, 404 -> row drop (FE5 §2-2, tests 1-8).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../contracts/fe2";
import { isApiError } from "../contracts/fe2";
import type { InboxItem } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";
import { toInboxQuery, type InboxFilter } from "../lib/inbox-filter";
import {
  EMPTY_INBOX,
  appendPage,
  hasMore as hasMoreOf,
  markAllReadLocally,
  markReadLocally,
  markUnreadLocally,
  removeItem,
  replaceFirstPage,
  type InboxState,
} from "../lib/inbox-reducer";
import { keepOnNotFound, runOptimistic } from "../lib/optimistic";
import { useUnreadStore } from "../store/unread-store";

export interface UseInboxOptions {
  filter: InboxFilter;
  pageSize?: number; // default 50 (max 200)
}

export interface UseInboxResult {
  items: InboxItem[];
  hasMore: boolean;
  loading: boolean;
  error: ApiError | null;
  loadMore(): Promise<void>;
  markRead(id: string): Promise<void>;
  markUnread(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  reload(): Promise<void>;
}

export function useInbox(options: UseInboxOptions): UseInboxResult {
  const { api, toast } = useNotificationDeps();
  const decrement = useUnreadStore((s) => s.decrement);
  const [state, setState] = useState<InboxState>(EMPTY_INBOX);
  const [error, setError] = useState<ApiError | null>(null);
  const pageSize = options.pageSize ?? 50;
  const { unreadOnly, type, sort } = options.filter;

  // Load first page whenever the filter changes.
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    setError(null);
    try {
      const page = await api.listInbox(
        toInboxQuery({ unreadOnly, type, sort }, { limit: pageSize }),
      );
      setState((s) => replaceFirstPage(s, page));
    } catch (err) {
      if (isApiError(err)) setError(err);
      setState((s) => ({ ...s, loading: false }));
    }
  }, [api, unreadOnly, type, sort, pageSize]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadingMoreRef = useRef(false);
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (state.nextCursor === null) return; //打止め (test 2)
    loadingMoreRef.current = true;
    setState((s) => ({ ...s, loading: true }));
    try {
      const page = await api.listInbox(
        toInboxQuery({ unreadOnly, type, sort }, { cursor: state.nextCursor, limit: pageSize }),
      );
      setState((s) => appendPage(s, page));
    } catch (err) {
      if (isApiError(err)) setError(err);
      setState((s) => ({ ...s, loading: false }));
    } finally {
      loadingMoreRef.current = false;
    }
  }, [api, state.nextCursor, unreadOnly, type, sort, pageSize]);

  const markRead = useCallback(
    async (id: string) => {
      const wasUnread = state.items.some((i) => i.id === id && i.readAt === null);
      await runOptimistic<string>(
        {
          optimistic: (targetId) => {
            let prev: InboxState = state;
            setState((s) => {
              const [next, snapshot] = markReadLocally(s, targetId, new Date().toISOString());
              prev = snapshot;
              return next;
            });
            if (wasUnread) decrement(1);
            return () => {
              setState(prev);
              if (wasUnread) useUnreadStore.getState().setCount(useUnreadStore.getState().count + 1);
            };
          },
          commit: (targetId) => api.markRead(targetId),
          onError: (err, rollback) =>
            keepOnNotFound(err, rollback, () => {
              setState((s) => removeItem(s, id)); // 404 -> drop the row (test 6)
              toast.show("info", "This notification is no longer available.");
            }),
        },
        id,
      ).catch((err) => {
        if (isApiError(err) && err.status !== 404 && !err.code.endsWith("_NOT_FOUND")) {
          toast.show("error", "Could not mark as read. Please try again.");
        }
      });
    },
    [api, state, decrement, toast],
  );

  const markUnread = useCallback(
    async (id: string) => {
      const wasRead = state.items.some((i) => i.id === id && i.readAt !== null);
      await runOptimistic<string>(
        {
          optimistic: (targetId) => {
            let prev: InboxState = state;
            setState((s) => {
              const [next, snapshot] = markUnreadLocally(s, targetId);
              prev = snapshot;
              return next;
            });
            // Restoring to unread bumps the shared badge back up.
            if (wasRead) useUnreadStore.getState().setCount(useUnreadStore.getState().count + 1);
            return () => {
              setState(prev);
              if (wasRead) decrement(1);
            };
          },
          commit: (targetId) => api.markUnread(targetId),
          onError: (err, rollback) =>
            keepOnNotFound(err, rollback, () => {
              setState((s) => removeItem(s, id)); // 404 -> drop the row
              toast.show("info", "This notification is no longer available.");
            }),
        },
        id,
      ).catch((err) => {
        if (isApiError(err) && err.status !== 404 && !err.code.endsWith("_NOT_FOUND")) {
          toast.show("error", "Could not mark as unread. Please try again.");
        }
      });
    },
    [api, state, decrement, toast],
  );

  const markAllRead = useCallback(async () => {
    const unreadBefore = state.items.filter(
      (i) => i.readAt === null && (!type || i.type.startsWith(type)),
    ).length;
    await runOptimistic<void>(
      {
        optimistic: () => {
          let prev: InboxState = state;
          setState((s) => {
            const [next, snapshot] = markAllReadLocally(
              s,
              new Date().toISOString(),
              type || undefined,
            );
            prev = snapshot;
            return next;
          });
          decrement(unreadBefore);
          return () => {
            setState(prev);
            useUnreadStore.getState().setCount(useUnreadStore.getState().count + unreadBefore);
          };
        },
        commit: () => api.markAllRead(type ? { type } : {}),
      },
      undefined,
    ).catch(() => {
      toast.show("error", "Could not mark all as read. Please try again.");
    });
  }, [api, state, type, decrement, toast]);

  return {
    items: state.items,
    hasMore: hasMoreOf(state),
    loading: state.loading,
    error,
    loadMore,
    markRead,
    markUnread,
    markAllRead,
    reload,
  };
}
