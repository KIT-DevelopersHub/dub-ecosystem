// Client-side store for the Gmail-style mail UI. A useReducer + context pair
// (matching the codebase's provider style) that owns folder/label view, open thread,
// bulk selection, search, floating compose windows and an undo snapshot. The store
// starts EMPTY and is filled from the real gateway (see useMailSync): HYDRATE replaces
// threads from GET /mail/messages + GET /mail/sent, SET_THREAD_MESSAGES fills a thread's
// full bodies on open, and REQUEST_SYNC (bumped after a send) triggers a re-fetch so the
// Sent folder is server-backed and survives a reload. Star/archive/trash/label/reply
// mutations stay optimistic and in-memory (server persistence is a later slice).
import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import type { mail } from "@dub/types";
import { SELF, inFolder, matchesQuery, senderMatcher, threadBlocked, type FolderId, type Label, type MailMsg, type MailPerson, type MailThreadModel } from "./mailModel.ts";

export interface ComposeState {
  id: string;
  mode: "new" | "reply" | "replyAll" | "forward";
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  showCc: boolean;
  showBcc: boolean;
  minimized: boolean;
  maximized: boolean;
  /** RFC Message-Id this compose is replying to (reply/replyAll). Sent to the gateway as
   *  SendMailRequest.inReplyTo so In-Reply-To/References are stamped and the thread links.
   *  Undefined for a brand-new compose or a forward. */
  inReplyTo?: string;
}

/** One outbound send/schedule, kept until the gateway answers so a failure can restore
 *  the compose and retry the exact request. */
export interface PendingSend {
  kind: "send" | "schedule";
  req: mail.SendMailRequest | mail.ScheduleMailRequest;
  /** Compose snapshot reopened on failure (same id, so its draft key is reused). */
  compose: ComposeState;
  /** Optimistic Sent entry to drop on failure. */
  threadId?: string;
}

export interface SendNotice {
  status: "sending" | "sent" | "failed";
  pending: PendingSend;
}

export interface UndoState {
  label: string;
  prevThreads: MailThreadModel[];
}

/** Which server list a folder pages through: Sent pages GET /mail/sent, every other
 *  thread folder pages GET /mail/messages. */
export type PageSource = "inbox" | "sent";
export const PAGE_SIZE = 50;

/** Cursor pager for one server list. `stack` holds the cursors of pages after the first
 *  ([] = page 1), so "previous" is a pop. `next`/`count` come from the last fetch. */
export interface PagerState {
  stack: string[];
  next: string | null;
  count: number;
}
const FIRST_PAGE: PagerState = { stack: [], next: null, count: 0 };

export const pageSourceOf = (folder: FolderId): PageSource => (folder === "sent" ? "sent" : "inbox");

/** Server-side search (GET /mail/messages?q= + GET /mail/sent?q=). The list endpoints are
 *  paginated and carry only a snippet, so the client filter alone can't find older mail or
 *  body text; useMailSync fetches matches (debounced) and SEARCH_RESULTS merges them into
 *  `threads`. `ids` = threads the server matched for `query`; `added` = the subset that was
 *  NOT in the hydrated list (dropped again when the search is cleared/changed, and carried
 *  over a background HYDRATE while the search stays active). */
export interface SearchState {
  query: string;
  status: "idle" | "loading" | "loadingMore" | "done" | "failed";
  ids: Set<string>;
  added: Set<string>;
  next: Record<PageSource, string | null>;
}
const NO_SEARCH: SearchState = { query: "", status: "idle", ids: new Set(), added: new Set(), next: { inbox: null, sent: null } };

export interface MailState {
  me: MailPerson;
  threads: MailThreadModel[];
  labels: Label[];
  folder: FolderId;
  labelFilter: string | null; // active user-label filter (mutually exclusive-ish with folder)
  openThreadId: string | null;
  checked: Set<string>;
  search: string;
  composes: ComposeState[];
  undo: UndoState | null;
  /** Bottom-left send status bar (送信中… / 送信しました / 送信できませんでした). */
  sendNotice: SendNotice | null;
  /** Bumped to ask the hydration hook to re-fetch inbox+sent (e.g. after a send). */
  syncNonce: number;
  /** Parked future sends (予約送信) — the Scheduled folder's list, loaded from the gateway
   *  (GET /mail/scheduled) by useMailSync. Not thread-backed: rendered by ScheduledList. */
  scheduled: mail.ScheduledSendListItem[];
  pager: Record<PageSource, PagerState>;
  /** True while the list is (re)loading for a page change or the first load — shows the
   *  skeleton. Background refetches leave it false so the list never flickers. */
  listLoading: boolean;
  searchResults: SearchState;
  /** The viewer's sender block list (GET /mail/blocks), newest first. Mutated optimistically
   *  by useSenderBlocks; `threads[].blocked` is re-derived from it on every change. */
  blocks: mail.MailSenderBlock[];
  /** "loading" until the first GET /mail/blocks answers (management list shows a skeleton);
   *  until then thread placement falls back to the server's per-message `blocked` flag. */
  blocksStatus: "loading" | "ready" | "failed";
  /** Bottom-left notice for block/unblock (success with 元に戻す, or a rollback error). */
  blockNotice: BlockNotice | null;
}

export interface BlockNotice {
  status: "blocked" | "unblocked" | "failed";
  text: string;
  /** The entry the notice is about — 元に戻す reverses it. */
  block?: mail.MailSenderBlock;
}

export type MailAction =
  | { type: "SET_FOLDER"; folder: FolderId }
  | { type: "SET_LABEL"; label: string }
  | { type: "SET_SEARCH"; search: string }
  | { type: "SEARCH_RESULTS"; query: string; threads: MailThreadModel[]; next: Record<PageSource, string | null>; append?: boolean }
  | { type: "SEARCH_FAILED"; query: string }
  | { type: "SEARCH_MORE" } // ask useMailSync for the next page of search results
  | { type: "OPEN_THREAD"; id: string }
  | { type: "CLOSE_THREAD" }
  | { type: "TOGGLE_STAR"; id: string }
  | { type: "SET_READ"; ids: string[]; read: boolean }
  | { type: "ARCHIVE"; ids: string[] }
  | { type: "TRASH"; ids: string[] }
  | { type: "PURGE"; ids: string[] } // 完全に削除: per-user permanent hide (no undo/restore)
  | { type: "RESTORE"; ids: string[] }
  | { type: "DISMISS_NUDGE"; ids: string[] } // 返信不要: drop from the reply nudge (undoable)
  | { type: "TOGGLE_LABEL"; id: string; label: string }
  | { type: "TOGGLE_CHECK"; id: string }
  | { type: "CHECK_ALL"; ids: string[] }
  | { type: "CLEAR_CHECKS" }
  | { type: "ADD_MESSAGE"; threadId: string; body: string; to: MailPerson[]; cc?: MailPerson[]; bcc?: MailPerson[]; subject: string }
  | { type: "SEND"; to: MailPerson[]; cc: MailPerson[]; bcc?: MailPerson[]; subject: string; body: string; threadId?: string }
  | { type: "SEND_STARTED"; pending: PendingSend }
  | { type: "SEND_OK"; pending: PendingSend }
  | { type: "SEND_FAILED"; pending: PendingSend }
  | { type: "DISMISS_SEND_NOTICE" }
  | { type: "OPEN_COMPOSE"; compose: Partial<ComposeState> }
  | { type: "UPDATE_COMPOSE"; id: string; patch: Partial<ComposeState> }
  | { type: "CLOSE_COMPOSE"; id: string }
  | { type: "UNDO" }
  | { type: "DISMISS_UNDO" }
  // ---- server sync ----
  | { type: "HYDRATE"; threads: MailThreadModel[]; me?: MailPerson; pages?: Record<PageSource, { next: string | null; count: number }> } // replace threads from the gateway
  | { type: "PAGE_NEXT"; source: PageSource }
  | { type: "PAGE_PREV"; source: PageSource }
  | { type: "LIST_FAILED" } // a list fetch failed: drop the skeleton, keep current threads
  | { type: "SET_THREAD_MESSAGES"; threadId: string; messages: MailMsg[] } // fill full bodies on open
  | { type: "APPLY_FLAGS"; flags: { threadId: string; starred: boolean; archived: boolean; trashed: boolean; purged: boolean; noReplyAt?: string | null }[] } // restore server-persisted star/archive/trash/purge/返信不要
  | { type: "HYDRATE_SCHEDULED"; scheduled: mail.ScheduledSendListItem[] } // replace the Scheduled folder list
  | { type: "REQUEST_SYNC" } // ask the hydration hook to re-fetch (post-send)
  // ---- sender block list ----
  | { type: "HYDRATE_BLOCKS"; blocks: mail.MailSenderBlock[] }
  | { type: "BLOCKS_FAILED" }
  | { type: "SET_BLOCKS"; blocks: mail.MailSenderBlock[] } // optimistic apply / reconcile / rollback
  | { type: "BLOCK_NOTICE"; notice: BlockNotice | null };

let seq = 0;
export const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function setRead(threads: MailThreadModel[], ids: Set<string>, read: boolean): MailThreadModel[] {
  return threads.map((t) =>
    // Another account's mail is view-only: its read state belongs to its owner.
    ids.has(t.id) ? { ...t, messages: t.messages.map((m) => (m.mine === false ? m : { ...m, read })) } : t,
  );
}

/** Drop the threads a search merged in (not part of the hydrated list) and reset it. */
function clearSearch(state: MailState, next: SearchState = NO_SEARCH): Pick<MailState, "threads" | "searchResults"> {
  const added = state.searchResults.added;
  return { threads: added.size > 0 ? state.threads.filter((t) => !added.has(t.id)) : state.threads, searchResults: next };
}

const latest = (t: MailThreadModel): string => t.messages.reduce((m, x) => (x.date > m ? x.date : m), "");

/** Threads the list shows for the current view. With a search active it spans every folder
 *  except Trash (Gmail-style; inside Trash/a label it stays scoped there) and shows the
 *  client pre-filter (matchesQuery over loaded threads, instant) plus the server matches,
 *  newest first. Purged threads never show. */
export function selectVisible(state: MailState): MailThreadModel[] {
  const q = state.search.trim();
  const scoped = (t: MailThreadModel): boolean =>
    state.labelFilter ? t.labels.includes(state.labelFilter) && t.folder !== "trash" : inFolder(t, state.folder);
  if (q.length === 0) return state.threads.filter((t) => !t.purged && scoped(t));
  const ids = state.searchResults.query === q ? state.searchResults.ids : new Set<string>();
  // Search spans every folder except Trash and ブロック済み (each stays scoped to itself).
  const inScope = (t: MailThreadModel): boolean =>
    state.labelFilter
      ? scoped(t)
      : state.folder === "trash"
        ? t.folder === "trash"
        : state.folder === "blocked"
          ? inFolder(t, "blocked")
          : t.folder !== "trash" && !t.blocked;
  return state.threads
    .filter((t) => !t.purged && inScope(t) && (ids.has(t.id) || matchesQuery(t, q)))
    .sort((a, b) => latest(b).localeCompare(latest(a)));
}

/** Re-derive `threads[].blocked` after any change to the threads or the block list. Keeps
 *  thread identity when nothing changed so memoized consumers don't re-render needlessly. */
function withBlocked(prev: MailState, next: MailState): MailState {
  if (next.threads === prev.threads && next.blocks === prev.blocks && next.blocksStatus === prev.blocksStatus) return next;
  const match = next.blocksStatus === "ready" ? senderMatcher(next.blocks) : null;
  let changed = false;
  const threads = next.threads.map((t) => {
    const blocked = threadBlocked(t, match);
    if ((t.blocked === true) === blocked) return t;
    changed = true;
    return { ...t, blocked };
  });
  return changed ? { ...next, threads } : next;
}

export function reducer(state: MailState, action: MailAction): MailState {
  return withBlocked(state, baseReducer(state, action));
}

function baseReducer(state: MailState, action: MailAction): MailState {
  switch (action.type) {
    case "SET_FOLDER": {
      // Gmail resets to page 1 on a folder switch; only a non-first page needs a reload.
      const paged = state.pager.inbox.stack.length > 0 || state.pager.sent.stack.length > 0;
      return {
        ...state,
        ...clearSearch(state),
        folder: action.folder,
        labelFilter: null,
        openThreadId: null,
        search: "",
        checked: new Set(),
        ...(paged
          ? { pager: { inbox: { ...state.pager.inbox, stack: [] }, sent: { ...state.pager.sent, stack: [] } }, listLoading: true }
          : {}),
      };
    }
    case "PAGE_NEXT": {
      const p = state.pager[action.source];
      if (!p.next || state.listLoading) return state;
      return {
        ...state,
        pager: { ...state.pager, [action.source]: { ...p, stack: [...p.stack, p.next] } },
        listLoading: true,
        openThreadId: null,
        checked: new Set(),
      };
    }
    case "PAGE_PREV": {
      const p = state.pager[action.source];
      if (p.stack.length === 0 || state.listLoading) return state;
      return {
        ...state,
        pager: { ...state.pager, [action.source]: { ...p, stack: p.stack.slice(0, -1) } },
        listLoading: true,
        openThreadId: null,
        checked: new Set(),
      };
    }
    case "LIST_FAILED":
      return { ...state, listLoading: false };
    case "SET_LABEL":
      return { ...state, ...clearSearch(state), labelFilter: action.label, openThreadId: null, search: "", checked: new Set() };
    case "SET_SEARCH": {
      const q = action.search.trim();
      if (q === state.searchResults.query) return { ...state, search: action.search, openThreadId: null };
      // New (or cleared) query: forget the previous matches; useMailSync fetches the new ones.
      const next: SearchState = q.length === 0 ? NO_SEARCH : { ...NO_SEARCH, query: q, status: "loading" };
      return { ...state, ...clearSearch(state, next), search: action.search, openThreadId: null };
    }
    case "SEARCH_RESULTS": {
      const cur = state.searchResults;
      if (action.query !== state.search.trim() || action.query !== cur.query) return state; // stale response
      const base = action.append ? state : { ...state, ...clearSearch(state, cur) };
      const have = new Set(base.threads.map((t) => t.id));
      const fresh = action.threads.filter((t) => !have.has(t.id));
      const ids = new Set(action.append ? cur.ids : []);
      for (const t of action.threads) ids.add(t.id);
      const added = new Set(action.append ? cur.added : []);
      for (const t of fresh) added.add(t.id);
      return {
        ...base,
        threads: [...base.threads, ...fresh],
        searchResults: { query: cur.query, status: "done", ids, added, next: action.next },
      };
    }
    case "SEARCH_FAILED":
      return action.query === state.searchResults.query ? { ...state, searchResults: { ...state.searchResults, status: "failed" } } : state;
    case "SEARCH_MORE": {
      const cur = state.searchResults;
      if (cur.status !== "done" || (!cur.next.inbox && !cur.next.sent)) return state;
      return { ...state, searchResults: { ...cur, status: "loadingMore" } };
    }
    case "OPEN_THREAD":
      return {
        ...state,
        openThreadId: action.id,
        threads: setRead(state.threads, new Set([action.id]), true),
      };
    case "CLOSE_THREAD":
      return { ...state, openThreadId: null };
    case "TOGGLE_STAR":
      return {
        ...state,
        threads: state.threads.map((t) => (t.id === action.id ? { ...t, starred: !t.starred } : t)),
      };
    case "SET_READ":
      return { ...state, threads: setRead(state.threads, new Set(action.ids), action.read), checked: new Set() };
    case "ARCHIVE": {
      const ids = new Set(action.ids);
      return {
        ...state,
        undo: { label: `${ids.size}件のスレッドをアーカイブしました`, prevThreads: state.threads },
        threads: state.threads.map((t) => (ids.has(t.id) ? { ...t, folder: "archive" } : t)),
        checked: new Set(),
        openThreadId: state.openThreadId && ids.has(state.openThreadId) ? null : state.openThreadId,
      };
    }
    case "TRASH": {
      const ids = new Set(action.ids);
      return {
        ...state,
        undo: { label: `${ids.size}件のスレッドをゴミ箱に移動しました`, prevThreads: state.threads },
        threads: state.threads.map((t) => (ids.has(t.id) ? { ...t, folder: "trash" } : t)),
        checked: new Set(),
        openThreadId: state.openThreadId && ids.has(state.openThreadId) ? null : state.openThreadId,
      };
    }
    case "PURGE": {
      // 完全に削除 (Gmail "permanently delete" out of Trash). Marks the threads purged for
      // THIS user only; the persist effect (useMailSync) POSTs setFlags(purged:true) so it
      // survives a reload. One-way by design: NO undo snapshot (the requirement is that the
      // user cannot restore it — the row still lives on the server for admins/others). The
      // thread stays in the store but ThreadList/inFolder filter every purged thread out.
      const ids = new Set(action.ids);
      return {
        ...state,
        undo: null,
        threads: state.threads.map((t) => (ids.has(t.id) ? { ...t, purged: true } : t)),
        checked: new Set(),
        openThreadId: state.openThreadId && ids.has(state.openThreadId) ? null : state.openThreadId,
      };
    }
    case "RESTORE": {
      // Move threads OUT of Trash back to their home folder. A thread whose messages are
      // all our own sends returns to "sent"; anything with a received message returns to
      // the inbox. The persist effect (useMailSync) sees folder!=="trash" and POSTs
      // setFlags(trashed:false), so the restore survives a reload (改善#8 flag store). The
      // undo snapshot lets the toast bounce it straight back to Trash.
      const ids = new Set(action.ids);
      return {
        ...state,
        undo: { label: `${ids.size}件のスレッドを受信トレイに戻しました`, prevThreads: state.threads },
        threads: state.threads.map((t) =>
          ids.has(t.id) ? { ...t, folder: t.messages.every((m) => m.outbound) ? "sent" : "inbox" } : t,
        ),
        checked: new Set(),
        openThreadId: state.openThreadId && ids.has(state.openThreadId) ? null : state.openThreadId,
      };
    }
    case "DISMISS_NUDGE": {
      // 返信不要: stamp now so the nudge skips mail received up to this moment (a newer
      // received message brings it back). useMailSync POSTs setFlags(noReply:true); the undo
      // snapshot restores the old stamp, which the sync turns into noReply:false.
      const ids = new Set(action.ids);
      const at = new Date().toISOString();
      return {
        ...state,
        undo: { label: "返信不要にしました", prevThreads: state.threads },
        threads: state.threads.map((t) => (ids.has(t.id) ? { ...t, noReplyAt: at } : t)),
      };
    }
    case "TOGGLE_LABEL":
      return {
        ...state,
        threads: state.threads.map((t) =>
          t.id === action.id
            ? {
                ...t,
                labels: t.labels.includes(action.label)
                  ? t.labels.filter((l) => l !== action.label)
                  : [...t.labels, action.label],
              }
            : t,
        ),
      };
    case "TOGGLE_CHECK": {
      const checked = new Set(state.checked);
      if (checked.has(action.id)) checked.delete(action.id);
      else checked.add(action.id);
      return { ...state, checked };
    }
    case "CHECK_ALL":
      return { ...state, checked: new Set(action.ids) };
    case "CLEAR_CHECKS":
      return { ...state, checked: new Set() };
    case "ADD_MESSAGE": {
      return {
        ...state,
        threads: state.threads.map((t) =>
          t.id === action.threadId
            ? {
                ...t,
                messages: [
                  ...t.messages,
                  {
                    id: uid("msg"),
                    from: state.me,
                    to: action.to,
                    ...(action.cc && action.cc.length > 0 ? { cc: action.cc } : {}),
                    ...(action.bcc && action.bcc.length > 0 ? { bcc: action.bcc } : {}),
                    date: new Date().toISOString(),
                    body: action.body,
                    read: true,
                    outbound: true,
                  },
                ],
              }
            : t,
        ),
      };
    }
    case "SEND": {
      const thread: MailThreadModel = {
        id: action.threadId ?? uid("thread"),
        subject: action.subject || "(件名なし)",
        folder: "sent",
        starred: false,
        labels: [],
        messages: [
          {
            id: uid("msg"),
            from: state.me,
            to: action.to,
            ...(action.cc.length > 0 ? { cc: action.cc } : {}),
            ...(action.bcc && action.bcc.length > 0 ? { bcc: action.bcc } : {}),
            date: new Date().toISOString(),
            body: action.body,
            read: true,
            outbound: true,
          },
        ],
      };
      return { ...state, threads: [thread, ...state.threads] };
    }
    case "SEND_STARTED":
      return { ...state, sendNotice: { status: "sending", pending: action.pending } };
    case "SEND_OK":
      // A retry from the bar succeeded: close the restored compose too.
      return {
        ...state,
        composes: state.composes.filter((c) => c.id !== action.pending.compose.id),
        sendNotice: { status: "sent", pending: action.pending },
      };
    case "SEND_FAILED": {
      const { pending } = action;
      const reopened = state.composes.some((c) => c.id === pending.compose.id);
      return {
        ...state,
        threads: pending.threadId ? state.threads.filter((t) => t.id !== pending.threadId) : state.threads,
        composes: reopened ? state.composes : [...state.composes, { ...pending.compose, minimized: false }],
        sendNotice: { status: "failed", pending },
      };
    }
    case "DISMISS_SEND_NOTICE":
      return { ...state, sendNotice: null };
    case "OPEN_COMPOSE": {
      const base: ComposeState = {
        id: uid("compose"),
        mode: "new",
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        body: "",
        showCc: false,
        showBcc: false,
        minimized: false,
        maximized: false,
        ...action.compose,
      };
      // Only one maximized window at a time.
      const composes = base.maximized ? state.composes.map((c) => ({ ...c, maximized: false })) : state.composes;
      return { ...state, composes: [...composes, base] };
    }
    case "UPDATE_COMPOSE":
      return {
        ...state,
        composes: state.composes.map((c) =>
          c.id === action.id
            ? { ...c, ...action.patch, ...(action.patch.maximized ? { minimized: false } : {}) }
            : action.patch.maximized
              ? { ...c, maximized: false }
              : c,
        ),
      };
    case "CLOSE_COMPOSE":
      return { ...state, composes: state.composes.filter((c) => c.id !== action.id) };
    case "UNDO":
      return state.undo ? { ...state, threads: state.undo.prevThreads, undo: null } : state;
    case "DISMISS_UNDO":
      return { ...state, undo: null };
    case "HYDRATE": {
      // Replace threads with the server view. Drop selections/undo that referenced the
      // now-stale set; keep the open thread if it still exists (so an open reading pane
      // survives a post-send re-hydrate) and its body-load is preserved.
      // Search-merged threads outside the hydrated page survive a background re-sync while
      // the search is active (otherwise a poll would blank the results).
      const hydrated = new Set(action.threads.map((t) => t.id));
      const keep = state.threads.filter((t) => state.searchResults.added.has(t.id) && !hydrated.has(t.id));
      const threads = keep.length > 0 ? [...action.threads, ...keep] : action.threads;
      return {
        ...state,
        threads,
        searchResults: { ...state.searchResults, added: new Set(keep.map((t) => t.id)) },
        ...(action.me ? { me: action.me } : {}),
        ...(action.pages
          ? {
              pager: {
                inbox: { ...state.pager.inbox, ...action.pages.inbox },
                sent: { ...state.pager.sent, ...action.pages.sent },
              },
            }
          : {}),
        listLoading: false,
        checked: new Set(),
        undo: null,
        openThreadId: threads.some((t) => t.id === state.openThreadId) ? state.openThreadId : null,
      };
    }
    case "SET_THREAD_MESSAGES":
      return {
        ...state,
        threads: state.threads.map((t) => (t.id === action.threadId ? { ...t, messages: action.messages } : t)),
      };
    case "APPLY_FLAGS": {
      // Restore server-persisted flags after a hydrate (改善#8: star/archive/trash survive a
      // reload). starred maps straight through; archived/trashed move the thread into the
      // matching folder (trash wins over archive), mirroring the ARCHIVE/TRASH reducers. A
      // thread with no flag row keeps its hydrated (inbox/sent) placement.
      const byId = new Map(action.flags.map((f) => [f.threadId, f]));
      return {
        ...state,
        threads: state.threads.map((t) => {
          const f = byId.get(t.id);
          if (!f) return t;
          const folder = f.trashed ? "trash" : f.archived ? "archive" : t.folder;
          // purged (完全に削除) survives the reload: hidden from every folder for this viewer.
          return { ...t, starred: f.starred, folder, purged: f.purged, noReplyAt: f.noReplyAt ?? null };
        }),
      };
    }
    case "HYDRATE_SCHEDULED":
      return { ...state, scheduled: action.scheduled };
    case "REQUEST_SYNC":
      return { ...state, syncNonce: state.syncNonce + 1 };
    case "HYDRATE_BLOCKS":
      return { ...state, blocks: action.blocks, blocksStatus: "ready" };
    case "BLOCKS_FAILED":
      return state.blocksStatus === "ready" ? state : { ...state, blocksStatus: "failed" };
    case "SET_BLOCKS": {
      // An open blocked thread stays open (its banner offers ブロックを解除); the list views
      // re-filter through inFolder on the re-derived `blocked` flag.
      return { ...state, blocks: action.blocks, blocksStatus: "ready" };
    }
    case "BLOCK_NOTICE":
      return { ...state, blockNotice: action.notice };
    default:
      return state;
  }
}

// Starts EMPTY — the real inbox/sent are loaded by useMailSync on mount. No demo data
// ships in the bundle (that lived in mailModel.ts; it now belongs to tests only).
export const initialMailState: MailState = {
  me: SELF,
  threads: [],
  labels: [],
  folder: "inbox",
  labelFilter: null,
  openThreadId: null,
  checked: new Set(),
  search: "",
  composes: [],
  undo: null,
  sendNotice: null,
  syncNonce: 0,
  scheduled: [],
  pager: { inbox: FIRST_PAGE, sent: FIRST_PAGE },
  listLoading: true,
  searchResults: NO_SEARCH,
  blocks: [],
  blocksStatus: "loading",
  blockNotice: null,
};

const MailStoreCtx = createContext<{ state: MailState; dispatch: Dispatch<MailAction> } | null>(null);

export function MailStoreProvider({
  children,
  initial = initialMailState,
}: {
  children: ReactNode;
  initial?: MailState;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initial);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <MailStoreCtx.Provider value={value}>{children}</MailStoreCtx.Provider>;
}

export function useMailStore(): { state: MailState; dispatch: Dispatch<MailAction> } {
  const ctx = useContext(MailStoreCtx);
  if (!ctx) throw new Error("useMailStore must be used within <MailStoreProvider>");
  return ctx;
}
