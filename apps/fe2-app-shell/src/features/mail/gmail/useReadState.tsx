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

/** すべて既読にする for the current folder. The loaded rows flip immediately; the server covers
 *  the pages not loaded, so the sync after it (either way) is what settles the badges. */
export function useMarkFolderRead(): () => void {
  const api = useMailApi();
  const { state, dispatch } = useMailStore();
  return useCallback(() => {
    dispatch({ type: "SET_READ", ids: selectVisible(state).map((t) => t.id), read: true });
    void api
      .markFolderRead(serverViewOf(state.folder, null))
      .catch(() => dispatch({ type: "BLOCK_NOTICE", notice: { status: "failed", text: "すべて既読にできませんでした" } }))
      .finally(() => dispatch({ type: "REQUEST_SYNC" }));
  }, [api, dispatch, state]);
}
