// 既読にする / 未読にする. The store flips immediately; the server call makes it survive the next
// sync. A failed call re-syncs, which puts the true state back on screen.
import { useCallback } from "react";
import { mail } from "@dub/types";
import { useMailApi } from "../MailProvider.tsx";
import { selectVisible, serverViewOf, useMailStore } from "./useMailStore.tsx";

export function useReadState(): (threadIds: string[], read: boolean) => void {
  const api = useMailApi();
  const { state, dispatch } = useMailStore();
  const { threads } = state;
  return useCallback(
    (threadIds, read) => {
      const wanted = new Set(threadIds);
      // Received mail of the viewer's own only: sent rows have no read state, and another
      // account's mail seen through oversight keeps its owner's.
      const ids = threads.filter((t) => wanted.has(t.id)).flatMap((t) => t.messages.filter((m) => !m.outbound && m.mine !== false).map((m) => m.id));
      dispatch({ type: "SET_READ", ids: threadIds, read });
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += mail.MAIL_READ_STATE_LIMIT) batches.push(ids.slice(i, i + mail.MAIL_READ_STATE_LIMIT));
      void Promise.all(batches.map((b) => api.setReadState(b, read))).catch(() => dispatch({ type: "REQUEST_SYNC" }));
    },
    [api, dispatch, threads],
  );
}

/** Apply one action to the whole folder (全件選択). The loaded rows move immediately; the
 *  server covers the pages not loaded, and the sync after it, either way, settles the rest.
 *  No undo: the snapshot would only cover the loaded page, so the toolbar confirms first. */
export function useBulkAction(): (action: mail.MailBulkAction) => void {
  const api = useMailApi();
  const { state, dispatch } = useMailStore();
  return useCallback(
    (action) => {
      const ids = selectVisible(state).map((t) => t.id);
      if (action === "read" || action === "unread") dispatch({ type: "SET_READ", ids, read: action === "read" });
      else {
        dispatch({ type: action === "archive" ? "ARCHIVE" : "TRASH", ids });
        dispatch({ type: "DISMISS_UNDO" });
        // The rows leave the view, so a page cursor past the first would point at nothing.
        dispatch({ type: "SET_FOLDER", folder: state.folder });
      }
      void api
        .bulkAction(serverViewOf(state.folder, null), action)
        .catch(() => dispatch({ type: "BLOCK_NOTICE", notice: { status: "failed", text: "全件への操作を完了できませんでした" } }))
        .finally(() => dispatch({ type: "REQUEST_SYNC" }));
    },
    [api, dispatch, state],
  );
}
