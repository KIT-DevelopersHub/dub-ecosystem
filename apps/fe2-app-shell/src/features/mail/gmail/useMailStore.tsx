// Client-side store for the Gmail-style mail UI. A useReducer + context pair
// (matching the codebase's provider style) that owns folder/label view, open thread,
// bulk selection, search, floating compose windows and an undo snapshot. The store
// starts EMPTY and is filled from the real gateway (see useMailSync): HYDRATE replaces
// threads from GET /mail/messages + GET /mail/sent, SET_THREAD_MESSAGES fills a thread's
// full bodies on open, and REQUEST_SYNC (bumped after a send) triggers a re-fetch so the
// Sent folder is server-backed and survives a reload. Star/archive/trash/label/reply
// mutations stay optimistic and in-memory (server persistence is a later slice).
import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import { SELF, type FolderId, type Label, type MailMsg, type MailPerson, type MailThreadModel } from "./mailModel.ts";

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

export interface UndoState {
  label: string;
  prevThreads: MailThreadModel[];
}

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
  /** Transient error toast (e.g. a read/unread persist that failed and rolled back). Plain
   *  message, no undo action — auto-dismissed by the UI. Null = nothing showing. */
  toast: string | null;
  /** Bumped to ask the hydration hook to re-fetch inbox+sent (e.g. after a send). */
  syncNonce: number;
}

export type MailAction =
  | { type: "SET_FOLDER"; folder: FolderId }
  | { type: "SET_LABEL"; label: string }
  | { type: "SET_SEARCH"; search: string }
  | { type: "OPEN_THREAD"; id: string }
  | { type: "CLOSE_THREAD" }
  | { type: "TOGGLE_STAR"; id: string }
  | { type: "SET_READ"; ids: string[]; read: boolean }
  | { type: "ARCHIVE"; ids: string[] }
  | { type: "TRASH"; ids: string[] }
  | { type: "TOGGLE_LABEL"; id: string; label: string }
  | { type: "TOGGLE_CHECK"; id: string }
  | { type: "CHECK_ALL"; ids: string[] }
  | { type: "CLEAR_CHECKS" }
  | { type: "ADD_MESSAGE"; threadId: string; body: string; to: MailPerson[]; subject: string }
  | { type: "SEND"; to: MailPerson[]; cc: MailPerson[]; subject: string; body: string }
  | { type: "OPEN_COMPOSE"; compose: Partial<ComposeState> }
  | { type: "UPDATE_COMPOSE"; id: string; patch: Partial<ComposeState> }
  | { type: "CLOSE_COMPOSE"; id: string }
  | { type: "UNDO" }
  | { type: "DISMISS_UNDO" }
  | { type: "SHOW_TOAST"; message: string }
  | { type: "DISMISS_TOAST" }
  // ---- server sync ----
  | { type: "HYDRATE"; threads: MailThreadModel[]; me?: MailPerson } // replace threads from the gateway
  | { type: "SET_THREAD_MESSAGES"; threadId: string; messages: MailMsg[] } // fill full bodies on open
  | { type: "APPLY_FLAGS"; flags: { threadId: string; starred: boolean; archived: boolean; trashed: boolean }[] } // restore server-persisted star/archive/trash
  | { type: "REQUEST_SYNC" }; // ask the hydration hook to re-fetch (post-send)

let seq = 0;
const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function setRead(threads: MailThreadModel[], ids: Set<string>, read: boolean): MailThreadModel[] {
  return threads.map((t) =>
    ids.has(t.id) ? { ...t, messages: t.messages.map((m) => ({ ...m, read })) } : t,
  );
}

export function reducer(state: MailState, action: MailAction): MailState {
  switch (action.type) {
    case "SET_FOLDER":
      return { ...state, folder: action.folder, labelFilter: null, openThreadId: null, search: "", checked: new Set() };
    case "SET_LABEL":
      return { ...state, labelFilter: action.label, openThreadId: null, search: "", checked: new Set() };
    case "SET_SEARCH":
      return { ...state, search: action.search, openThreadId: null };
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
        id: uid("thread"),
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
            date: new Date().toISOString(),
            body: action.body,
            read: true,
            outbound: true,
          },
        ],
      };
      return { ...state, threads: [thread, ...state.threads] };
    }
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
    case "SHOW_TOAST":
      return { ...state, toast: action.message };
    case "DISMISS_TOAST":
      return { ...state, toast: null };
    case "HYDRATE":
      // Replace threads with the server view. Drop selections/undo that referenced the
      // now-stale set; keep the open thread if it still exists (so an open reading pane
      // survives a post-send re-hydrate) and its body-load is preserved.
      return {
        ...state,
        threads: action.threads,
        ...(action.me ? { me: action.me } : {}),
        checked: new Set(),
        undo: null,
        openThreadId: action.threads.some((t) => t.id === state.openThreadId) ? state.openThreadId : null,
      };
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
          return { ...t, starred: f.starred, folder };
        }),
      };
    }
    case "REQUEST_SYNC":
      return { ...state, syncNonce: state.syncNonce + 1 };
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
  toast: null,
  syncNonce: 0,
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
