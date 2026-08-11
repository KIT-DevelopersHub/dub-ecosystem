// Bridges the Gmail-style store to the real gateway. On mount (and whenever a sync is
// requested — REQUEST_SYNC, bumped after a send) it loads the received inbox
// (GET /mail/messages) and the Sent folder (GET /mail/sent) and HYDRATEs the store, so
// the UI shows real mail and a sent message survives a reload. When a thread is opened
// it lazily fetches the full body (getThread / getSent) the list endpoints omit. Uses
// plain effects (no react-query) so it works anywhere the store is mounted, including
// unit tests that provide only a fake MailApi.
import { useEffect, useRef } from "react";
import { useMailApi } from "../MailProvider.tsx";
import { inboxItemsToThreads, sentDetailToMessage, sentItemsToThreads, threadDetailToMessages } from "./hydrate.ts";
import { useMailStore } from "./useMailStore.tsx";

export function useMailSync(): void {
  const api = useMailApi();
  const { state, dispatch } = useMailStore();
  const { syncNonce, me, openThreadId, threads } = state;

  // Load inbox + sent on mount and on every requested sync (post-send). A failure leaves
  // the current threads in place (empty on first load) rather than blowing up the pane.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [inbox, sent] = await Promise.all([api.listInbox({ limit: 50 }), api.listSent({ limit: 50 })]);
        if (!alive) return;
        dispatch({ type: "HYDRATE", threads: [...inboxItemsToThreads(inbox.items), ...sentItemsToThreads(sent.items, me)] });
      } catch {
        /* keep existing state; the list simply stays as-is */
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, dispatch, syncNonce, me]);

  // Lazily fill the full body when a thread is opened (list APIs carry only a snippet).
  const loaded = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!openThreadId || loaded.current.has(openThreadId)) return;
    const thread = threads.find((t) => t.id === openThreadId);
    if (!thread) return;
    const id = openThreadId;
    loaded.current.add(id);
    let alive = true;
    void (async () => {
      try {
        if (thread.folder === "sent") {
          const detail = await api.getSent(thread.id);
          if (alive) dispatch({ type: "SET_THREAD_MESSAGES", threadId: thread.id, messages: [sentDetailToMessage(detail, me)] });
        } else {
          // Persist read-state on the server so it survives a reload (mirrors InboxScreen).
          // Opening reads the whole thread; OPEN_THREAD already flipped the local flags, so
          // we mark every message read server-side (markRead is idempotent). Best-effort —
          // a failure never blocks opening the thread.
          for (const m of thread.messages) void api.markRead(m.id).catch(() => undefined);
          const full = await api.getThread(thread.id);
          // The thread is now open → read; force it so a racing getThread (server not yet
          // reflecting the markRead above) can't revert the opened thread to unread.
          const messages = threadDetailToMessages(full).map((m) => ({ ...m, read: true }));
          if (alive) dispatch({ type: "SET_THREAD_MESSAGES", threadId: thread.id, messages });
        }
      } catch {
        loaded.current.delete(id); // allow a retry on the next open
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, dispatch, openThreadId, threads, me]);
}
