// Bridges the Gmail-style store to the real gateway. On mount (and whenever a sync is
// requested — REQUEST_SYNC, bumped after a send) it loads the received inbox
// (GET /mail/messages) and the Sent folder (GET /mail/sent) and HYDRATEs the store, so
// the UI shows real mail and a sent message survives a reload. When a thread is opened
// it lazily fetches the full body (getThread / getSent) the list endpoints omit. Uses
// plain effects (no react-query) so it works anywhere the store is mounted, including
// unit tests that provide only a fake MailApi.
import { useEffect, useRef } from "react";
import { useMailApi } from "../MailProvider.tsx";
import { combineThreads, sentDetailToMessage, threadDetailToMessages } from "./hydrate.ts";
import { useMailStore } from "./useMailStore.tsx";

export function useMailSync(): void {
  const api = useMailApi();
  const { state, dispatch } = useMailStore();
  const { syncNonce, me, openThreadId, threads } = state;

  // Tracks which threads have had their full bodies fetched (list APIs carry only a
  // snippet). Cleared on every sync so a post-send re-sync re-fetches the OPEN thread —
  // otherwise a just-sent reply (now in GET /threads/:id) would never load and the reply
  // would appear to vanish from the conversation.
  const loaded = useRef<Set<string>>(new Set());

  // Load inbox + sent on mount and on every requested sync (post-send). A failure leaves
  // the current threads in place (empty on first load) rather than blowing up the pane.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [inbox, sent] = await Promise.all([api.listInbox({ limit: 50 }), api.listSent({ limit: 50 })]);
        if (!alive) return;
        dispatch({ type: "HYDRATE", threads: combineThreads(inbox.items, sent.items, me) });
        loaded.current.clear(); // force the open thread to re-fetch its full body (+ any new reply)
      } catch {
        /* keep existing state; the list simply stays as-is */
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, dispatch, syncNonce, me]);

  // Lazily fill the full body when a thread is opened (list APIs carry only a snippet).
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
          // we mark every received message read server-side (markRead is idempotent, and a
          // maillog id would 404). Best-effort — a failure never blocks opening the thread.
          const known = thread.messages;
          for (const m of known) if (!m.outbound) void api.markRead(m.id).catch(() => undefined);
          const full = await api.getThread(thread.id);
          // getThread returns RECEIVED messages only. Preserve our own replies (folded Sent
          // rows, outbound=true) that it omits, so a sent reply stays visible in the thread
          // instead of vanishing on refresh. Dedup by id, order by date. Force read=true so a
          // racing getThread (server not yet reflecting markRead) can't revert to unread.
          const inbound = threadDetailToMessages(full).map((m) => ({ ...m, read: true }));
          const ours = known.filter((m) => m.outbound && !inbound.some((i) => i.id === m.id));
          const messages = [...inbound, ...ours].sort((a, b) => a.date.localeCompare(b.date));
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
