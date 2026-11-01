// Bridges the Gmail-style store to the real gateway. On mount (and whenever a sync is
// requested — REQUEST_SYNC, bumped after a send) it loads the received inbox
// (GET /mail/messages) and the Sent folder (GET /mail/sent) and HYDRATEs the store, so
// the UI shows real mail and a sent message survives a reload. When a thread is opened
// it lazily fetches the full body (getThread / getSent) the list endpoints omit. Uses
// plain effects (no react-query) so it works anywhere the store is mounted, including
// unit tests that provide only a fake MailApi.
import { useEffect, useRef } from "react";
import type { MailApi } from "../mailApi.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { combineThreads, sentDetailToMessage, threadDetailToMessages } from "./hydrate.ts";
import { dedupeLoopback, type MailMsg } from "./mailModel.ts";
import { PAGE_SIZE, pageSourceOf, searchViewOf, selectVisible, serverViewOf, useMailStore } from "./useMailStore.tsx";

/** What the server last knew per thread. noReplyAt is compared as-is; the POST sends only the
 *  boolean `noReply` (the server stamps its own time). */
interface FlagState {
  starred: boolean;
  archived: boolean;
  trashed: boolean;
  purged: boolean;
  noReplyAt: string | null;
}
/** Background re-sync interval for new inbound mail. */
export const MAIL_POLL_MS = 60_000;
/** Delay after a scheduled send's due time before re-syncing (lets the drain run). */
export const SCHEDULED_DUE_GRACE_MS = 3_000;
/** Delay before re-fetching a page that a local action left short (see the refill effect). */
export const REFILL_DELAY_MS = 600;
/** Quiet period after the last keystroke before the server search fires. */
export const SEARCH_DEBOUNCE_MS = 300;

const NO_FLAGS: FlagState ={ starred: false, archived: false, trashed: false, purged: false, noReplyAt: null };

export function useMailSync(): void {
  const api = useMailApi();
  const { state, dispatch } = useMailStore();
  const { syncNonce, me, openThreadId, threads } = state;
  // Current page cursor per list (undefined = page 1). A page change re-runs the load
  // below; a background/manual sync re-fetches the SAME page, so page 1 picks up new mail.
  const inboxCursor = state.pager.inbox.stack.at(-1);
  const sentCursor = state.pager.sent.stack.at(-1);
  // The server view backing the current folder (blocked senders + flags filtered in SQL
  // before the limit, so the page is already exactly this folder's conversations).
  const view = serverViewOf(state.folder, state.labelFilter);

  // Tracks which threads have had their full bodies fetched (list APIs carry only a
  // snippet). Cleared on every sync so a post-send re-sync re-fetches the OPEN thread —
  // otherwise a just-sent reply (now in GET /threads/:id) would never load and the reply
  // would appear to vanish from the conversation.
  const loaded = useRef<Set<string>>(new Set());

  // 改善#8: server-persisted star/archive/trash. `flagBaseline` is the last flag-state we
  // KNOW the server holds per thread; the persist effect below POSTs only the deltas. It is
  // seeded from GET /mail/flags right after a hydrate, and `flagsReady` gates persistence so
  // the reload itself (which momentarily shows un-flagged threads) never POSTs a spurious
  // "unstar" back to the server.
  const flagBaseline = useRef<Map<string, FlagState>>(new Map());
  const flagsReady = useRef(false);

  // Load inbox + sent on mount and on every requested sync (post-send). A failure leaves
  // the current threads in place (empty on first load) rather than blowing up the pane.
  useEffect(() => {
    let alive = true;
    flagsReady.current = false; // pause flag persistence while we (re)load
    void (async () => {
      try {
        const [inbox, sent, scheduled, flags] = await Promise.all([
          api.listInbox({ limit: PAGE_SIZE, folder: view, ...(inboxCursor ? { cursor: inboxCursor } : {}) }),
          api.listSent({ limit: PAGE_SIZE, ...(sentCursor ? { cursor: sentCursor } : {}) }),
          // Scheduled (予約送信) is best-effort: an older gateway without the endpoint yields
          // an empty list rather than blanking inbox+sent.
          api.listScheduled({ limit: 50 }).catch(() => ({ items: [], nextCursor: null })),
          // Fetched WITH the page and applied in the same tick, so a Trash / Archive page is
          // never momentarily filed under the inbox (which would blank the view).
          api.listFlags().catch(() => []),
        ]);
        if (!alive) return;
        dispatch({
          type: "HYDRATE",
          threads: combineThreads(inbox.items, sent.items, me),
          pages: {
            // A page is N conversations (the gateway pages by conversation), not N messages.
            inbox: { next: inbox.nextCursor, count: new Set(inbox.items.map((m) => m.threadId)).size, total: inbox.total ?? null },
            sent: { next: sent.nextCursor, count: sent.items.length },
          },
        });
        dispatch({ type: "HYDRATE_SCHEDULED", scheduled: scheduled.items });
        loaded.current.clear(); // force the open thread to re-fetch its full body (+ any new reply)
        // Restore persisted flags on top of the freshly hydrated threads, then arm the
        // persist effect with the server's flag-state as the baseline (so applying them is
        // not itself seen as a change to push back).
        dispatch({ type: "APPLY_FLAGS", flags });
        // Sidebar badges (exact, whole mailbox). Best-effort: without them the sidebar
        // falls back to the loaded threads.
        void api
          .counts()
          .then((counts) => alive && dispatch({ type: "HYDRATE_COUNTS", counts }))
          .catch(() => undefined);
        const base = new Map<string, FlagState>();
        for (const f of flags)
          base.set(f.threadId, { starred: f.starred, archived: f.archived, trashed: f.trashed, purged: f.purged, noReplyAt: f.noReplyAt ?? null });
        flagBaseline.current = base;
        flagsReady.current = true;
      } catch {
        // keep existing threads; just drop the skeleton
        if (alive) dispatch({ type: "LIST_FAILED" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, dispatch, syncNonce, me, inboxCursor, sentCursor, view]);

  // Sender block list: loaded once per mount (mutations are optimistic in the store and
  // persisted by useSenderBlocks, so a background re-sync must not clobber an in-flight one).
  useEffect(() => {
    let alive = true;
    api
      .listBlocks()
      .then((blocks) => alive && dispatch({ type: "HYDRATE_BLOCKS", blocks }))
      .catch(() => alive && dispatch({ type: "BLOCKS_FAILED" }));
    return () => {
      alive = false;
    };
  }, [api, dispatch]);

  // Server-side search: once the box settles (SEARCH_DEBOUNCE_MS) fetch matches from inbox +
  // Sent (the loaded page is only 50 rows with snippet bodies, so older mail and body text
  // need the server). Results merge into the store via SEARCH_RESULTS; a stale response
  // (query changed meanwhile) is dropped by the reducer. "さらに読み込む" (SEARCH_MORE) pages
  // both lists by their cursors.
  const search = state.searchResults;
  const searchView = searchViewOf(state.folder, state.labelFilter);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  useEffect(() => {
    const q = search.query;
    const more = search.status === "loadingMore";
    if (q.length === 0 || (search.status !== "loading" && !more)) return;
    let alive = true;
    const run = async (): Promise<void> => {
      try {
        const inboxCur = more ? search.next.inbox : undefined;
        const sentCur = more ? search.next.sent : undefined;
        const empty = { items: [], nextCursor: null };
        const [inbox, sent] = await Promise.all([
          !more || inboxCur ? api.listInbox({ q, folder: searchView, limit: PAGE_SIZE, ...(inboxCur ? { cursor: inboxCur } : {}) }) : Promise.resolve(empty),
          !more || sentCur ? api.listSent({ q, limit: PAGE_SIZE, ...(sentCur ? { cursor: sentCur } : {}) }) : Promise.resolve(empty),
        ]);
        if (!alive) return;
        const found = combineThreads(inbox.items, sent.items, me);
        const known = new Set(threadsRef.current.map((t) => t.id));
        dispatch({ type: "SEARCH_RESULTS", query: q, threads: found, next: { inbox: inbox.nextCursor, sent: sent.nextCursor }, append: more });
        // Merged-in threads come from outside the hydrated page, so they never got their
        // persisted flags (star/archive/trash/purge). Apply only to those — already-loaded
        // threads keep their optimistic local state.
        const fresh = new Set(found.filter((t) => !known.has(t.id)).map((t) => t.id));
        if (fresh.size === 0) return;
        const flags = await api.listFlags().catch(() => []);
        if (alive) dispatch({ type: "APPLY_FLAGS", flags: flags.filter((f) => fresh.has(f.threadId)) });
      } catch {
        if (alive) dispatch({ type: "SEARCH_FAILED", query: q });
      }
    };
    const timer = setTimeout(() => void run(), more ? 0 : SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // search.next is read only for "loadingMore", which is entered fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, dispatch, me, search.query, search.status]);

  // Pick up newly arrived mail without a full reload: re-sync on an interval while the tab
  // is visible and whenever it regains visibility. HYDRATE drops selections/undo, so a
  // background sync is skipped while either is active.
  const busy = useRef(false);
  busy.current = state.checked.size > 0 || state.undo !== null;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => {
      if (document.visibilityState === "visible" && !busy.current) dispatch({ type: "REQUEST_SYNC" });
    };
    const timer = setInterval(sync, MAIL_POLL_MS);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [dispatch]);

  // Keep the page full: the server returns exactly PAGE_SIZE conversations of this view, but
  // a local action (archive / trash / block / …) files one out of the view optimistically.
  // Once the viewer is idle (no undo toast / selection), re-fetch the same page so the next
  // conversation moves up and the page is full again. `fullAt` is the visible count right
  // after the last hydrate; it only fires on a DROP below it, once per hydrate (no loop).
  const visibleNow = state.search.trim() === "" && pageSourceOf(state.folder) === "inbox" ? selectVisible(state).length : -1;
  const fullAt = useRef(-1);
  const pagerInbox = state.pager.inbox;
  useEffect(() => {
    fullAt.current = state.listLoading ? -1 : visibleNow;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagerInbox, state.listLoading, state.folder, state.labelFilter]);
  const idle = state.checked.size === 0 && state.undo === null && !state.listLoading;
  useEffect(() => {
    if (visibleNow < 0 || fullAt.current < 0 || visibleNow >= fullAt.current || !idle) return;
    const t = setTimeout(() => {
      fullAt.current = visibleNow;
      dispatch({ type: "REQUEST_SYNC" });
    }, REFILL_DELAY_MS);
    return () => clearTimeout(t);
  }, [visibleNow, idle, dispatch]);

  // 予約送信: re-sync shortly after the soonest parked send falls due, so a scheduled
  // reply/compose moves 予約済み → 送信済み (and folds into its thread) without waiting for
  // the next poll. Capped so a far-future schedule never arms a huge timer.
  const nextDue = state.scheduled.reduce<number>((min, s) => {
    const t = s.status === "scheduled" ? Date.parse(s.scheduledAt) : NaN;
    return Number.isNaN(t) ? min : Math.min(min, t);
  }, Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!Number.isFinite(nextDue)) return;
    const wait = Math.max(0, nextDue - Date.now()) + SCHEDULED_DUE_GRACE_MS;
    if (wait > MAIL_POLL_MS * 10) return;
    const timer = setTimeout(() => {
      if (!busy.current) dispatch({ type: "REQUEST_SYNC" });
    }, wait);
    return () => clearTimeout(timer);
  }, [nextDue, dispatch]);

  // Persist flag changes (optimistic): whenever a thread's derived star/archive/trash state
  // diverges from what the server last knew, POST the new state and advance the baseline.
  // Covers EVERY mutation path uniformly (row/toolbar/reading-pane/keyboard/undo) with no
  // change to the dispatch sites. Best-effort — a failed POST leaves the optimistic UI as-is.
  useEffect(() => {
    if (!flagsReady.current) return;
    for (const t of threads) {
      const cur: FlagState = {
        starred: t.starred,
        archived: t.folder === "archive",
        trashed: t.folder === "trash",
        purged: t.purged === true,
        noReplyAt: t.noReplyAt ?? null,
      };
      const prev = flagBaseline.current.get(t.id) ?? NO_FLAGS;
      const noReplyChanged = cur.noReplyAt !== prev.noReplyAt;
      if (noReplyChanged || cur.starred !== prev.starred || cur.archived !== prev.archived || cur.trashed !== prev.trashed || cur.purged !== prev.purged) {
        flagBaseline.current.set(t.id, cur);
        const { noReplyAt, ...flags } = cur;
        // noReply only when it changed, so an unrelated star never re-stamps the dismissal. A
        // stamp moving BACKWARDS is an undo to an older dismissal that no longer covers the
        // newest mail (else the nudge could not have shown), so clearing it is equivalent —
        // re-stamping now would wrongly cover that newer mail after a reload.
        const noReply = noReplyAt !== null && (prev.noReplyAt === null || noReplyAt > prev.noReplyAt);
        void api.setFlags(t.id, noReplyChanged ? { ...flags, noReply } : flags).catch(() => undefined);
      }
    }
  }, [threads, api]);

  // Lazily fill the full body when a thread is opened (list APIs carry only a snippet).
  useEffect(() => {
    if (!openThreadId || loaded.current.has(openThreadId)) return;
    const thread = threads.find((t) => t.id === openThreadId);
    if (!thread) return;
    const id = openThreadId;
    loaded.current.add(id);
    let alive = true;
    let done = false;
    void (async () => {
      try {
        if (thread.folder === "sent") {
          const detail = await api.getSent(thread.id);
          if (alive) {
            done = true;
            dispatch({ type: "SET_THREAD_MESSAGES", threadId: thread.id, messages: [sentDetailToMessage(detail, me)] });
          }
        } else {
          // Persist read-state on the server so it survives a reload (mirrors InboxScreen).
          // Opening reads the whole thread; OPEN_THREAD already flipped the local flags, so
          // we mark every received message read server-side (markRead is idempotent, and a
          // maillog id would 404). Best-effort — a failure never blocks opening the thread.
          const known = thread.messages;
          for (const m of known) if (!m.outbound && m.mine !== false) void api.markRead(m.id).catch(() => undefined);
          const full = await api.getThread(thread.id);
          // getThread returns RECEIVED messages only. Preserve our own replies (folded Sent
          // rows, outbound=true) that it omits, so a sent reply stays visible in the thread
          // instead of vanishing on refresh. Dedup by id, order by date. Force read=true so a
          // racing getThread (server not yet reflecting markRead) can't revert to unread.
          const inbound = threadDetailToMessages(full).map((m) => (m.mine === false ? m : { ...m, read: true }));
          const ours = await Promise.all(
            known.filter((m) => m.outbound && !inbound.some((i) => i.id === m.id)).map((m) => withFullSentBody(api, m)),
          );
          const messages = dedupeLoopback([...inbound, ...ours].sort((a, b) => a.date.localeCompare(b.date)));
          if (alive) {
            done = true;
            dispatch({ type: "SET_THREAD_MESSAGES", threadId: thread.id, messages });
          }
        }
      } catch {
        loaded.current.delete(id); // allow a retry on the next open
      }
    })();
    return () => {
      alive = false;
      // Any `threads` change (e.g. APPLY_FLAGS right after a post-send HYDRATE) re-runs this
      // effect and cancels the in-flight fill. Un-mark it so the re-run fetches again;
      // otherwise the result was dropped and the thread kept list snippets for good.
      if (!done) loaded.current.delete(id);
    };
  }, [api, dispatch, openThreadId, threads, me]);
}

/** A folded Sent reply arrives from the list endpoint with body = snippet (whitespace
 *  collapsed to one line, cut at 140 chars), so a long reply rendered jumbled and truncated.
 *  Fetch its full detail to restore the real text (newlines intact). Optimistic local rows
 *  (no server id yet) and failures keep what we have. Attachment metadata rides along. */
async function withFullSentBody(api: MailApi, m: MailMsg): Promise<MailMsg> {
  if (m.id.startsWith("msg-")) return m;
  try {
    const detail = await api.getSent(m.id);
    if (detail.id !== m.id) return m;
    // Carry the reply's files too (list rows omit them), so a reply sent — or scheduled and
    // later delivered — with attachments shows them inside the conversation.
    return { ...m, body: detail.textBody, ...(detail.attachments && detail.attachments.length > 0 ? { attachments: detail.attachments } : {}) };
  } catch {
    return m;
  }
}
