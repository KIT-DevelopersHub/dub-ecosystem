// Top-level Gmail-style mail experience. Composes the full-width search bar, the
// left folder/label nav, the center list ↔ reading-pane swap, floating compose
// windows and an undo toast. Owns the keyboard shortcuts (shortcuts.ts; r / a / f sit in
// ReadingPane, which owns the addressing). State lives in the client
// MailStore, hydrated from the real gateway by useMailSync (inbox + Sent are live data).
import { useEffect, useRef, useState } from "react";
import { COARSE_POINTER_QUERY, Drawer, IconButton, Modal, NARROW_VIEWPORT_QUERY, useMediaQuery } from "@dub/ui";
import { MailSidebar } from "./MailSidebar.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { ScheduledList } from "./ScheduledList.tsx";
import { DraftList } from "./DraftList.tsx";
import { ReadingPane } from "./ReadingPane.tsx";
import { BlockNoticeBar, BlockedSendersPanel } from "./BlockedSenders.tsx";
import blockStyles from "./blocks.module.css";
import { ComposeWindow, COMPOSE_WINDOW_DRAFT_PREFIX } from "./ComposeWindow.tsx";
import { MailIcon } from "./icons.tsx";
import { SHARED_FOLDERS } from "./mailModel.ts";
import { MailStoreProvider, composing, folderUnread, selectOrdered, showSharedFolders, useMailStore, type ComposeState } from "./useMailStore.tsx";
import { useMailSync } from "./useMailSync.tsx";
import { useReadState } from "./useReadState.tsx";
import { deliver } from "./sendMail.ts";
import { SHORTCUTS, isTyping, modalOpen, shortcutsBlocked } from "./shortcuts.ts";
import { useCanCompose, useMailApi } from "../MailProvider.tsx";

/** P1-2 follow-up: floating compose windows are pure client state (useMailStore starts
 *  with composes: [] on every mount/reload) — a reload while typing loses the OPEN
 *  window entirely, so there is nothing left for ComposeWindow's own restore notice to
 *  attach to. This re-opens one window per leftover draft found in storage (each under
 *  its original compose.id, keyed via composeWindowDraftKey) so the restore notice and
 *  ongoing leave-guard are reachable again after an accidental reload/crash. Runs once
 *  per GmailApp mount; a deliberate send/discard already clears its own key (see
 *  ComposeWindow), so a normal close never resurrects here. */
function useRestoreComposeDraftsOnMount(): void {
  const { dispatch } = useMailStore();
  useEffect(() => {
    let store: Storage | null;
    try {
      store = globalThis.localStorage ?? null;
    } catch {
      store = null;
    }
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(COMPOSE_WINDOW_DRAFT_PREFIX)) keys.push(k);
    }
    for (const key of keys) {
      const id = key.slice(COMPOSE_WINDOW_DRAFT_PREFIX.length);
      try {
        const raw = store.getItem(key);
        if (!raw) continue;
        const draft = JSON.parse(raw) as { to?: string; cc?: string; bcc?: string; showCc?: boolean; showBcc?: boolean; subject?: string; body?: string; mode?: ComposeState["mode"]; inReplyTo?: string };
        dispatch({
          type: "OPEN_COMPOSE",
          compose: {
            id,
            to: draft.to ?? "",
            cc: draft.cc ?? "",
            bcc: draft.bcc ?? "",
            showCc: draft.showCc ?? false,
            showBcc: draft.showBcc ?? false,
            subject: draft.subject ?? "",
            body: draft.body ?? "",
            ...(draft.mode ? { mode: draft.mode } : {}),
            ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
            restored: true,
          },
        });
      } catch {
        /* corrupt draft — leave it; ComposeWindow's own peekDraft will no-op on it too */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Phones: the folder nav moves into a drawer opened from the search row, and the
 *  fixed 240px title column gives its width to the search box. */
function SearchBar({ narrow, onOpenNav }: { narrow: boolean; onOpenNav: () => void }): JSX.Element {
  const { state, dispatch } = useMailStore();
  const ref = useRef<HTMLInputElement>(null);
  // iOS zooms the page when focusing an input under 16px.
  const coarse = useMediaQuery(COARSE_POINTER_QUERY);
  const canCompose = useCanCompose();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: narrow ? 4 : 12, padding: narrow ? "8px 4px" : "8px 16px", flexShrink: 0 }}>
      {narrow ? (
        <IconButton name="menu" aria-label="フォルダを開く" testId="fe2-mail-nav-open" onClick={onOpenNav} />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--dub-color-text-primary)", fontWeight: 700, fontSize: "var(--dub-font-size-lg)", width: 240 }}>
          <MailIcon name="inbox" size={24} style={{ color: "var(--dub-color-brand-500)" }} />
          メール
        </div>
      )}
      <div
        data-focus-search
        style={{
          flex: 1,
          maxWidth: 720,
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 44,
          padding: "0 16px",
          borderRadius: "var(--dub-radius-lg)",
          background: "var(--dub-color-surface-sunken)",
          border: "1px solid transparent",
        }}
      >
        <MailIcon name="search" size={20} style={{ color: "var(--dub-color-text-muted)" }} />
        <input
          ref={ref}
          data-testid="fe2-mail-search"
          value={state.search}
          onChange={(e) => dispatch({ type: "SET_SEARCH", search: e.target.value })}
          placeholder="メールを検索"
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--dub-color-text-primary)", fontSize: coarse ? "var(--dub-font-size-md)" : "var(--dub-font-size-sm)", fontFamily: "inherit", minWidth: 0 }}
        />
        {state.search ? (
          <button type="button" aria-label="検索をクリア" onClick={() => dispatch({ type: "SET_SEARCH", search: "" })} style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-muted)" }}>
            <MailIcon name="x" size={18} />
          </button>
        ) : null}
      </div>
      {narrow && canCompose ? (
        <IconButton
          name="edit"
          aria-label="作成"
          testId="fe2-mail-compose-open-mobile"
          onClick={() => dispatch({ type: "OPEN_COMPOSE", compose: {} })}
        />
      ) : null}
    </div>
  );
}

function UndoToast(): JSX.Element | null {
  const { state, dispatch } = useMailStore();
  useEffect(() => {
    if (!state.undo) return;
    const t = setTimeout(() => dispatch({ type: "DISMISS_UNDO" }), 6000);
    return () => clearTimeout(t);
  }, [state.undo, dispatch]);
  if (!state.undo) return null;
  return (
    <div
      data-testid="fe2-mail-undo"
      style={{
        position: "fixed",
        left: 24,
        bottom: 24,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 16px",
        borderRadius: "var(--dub-radius-md)",
        background: "var(--dub-color-text-primary)",
        color: "var(--dub-color-surface-base)",
        boxShadow: "var(--dub-shadow-lg)",
        zIndex: 1400,
        fontSize: "var(--dub-font-size-sm)",
      }}
    >
      <span>{state.undo.label}</span>
      <button type="button" onClick={() => dispatch({ type: "UNDO" })} style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-info-300)", fontWeight: 700 }}>
        元に戻す
      </button>
    </div>
  );
}

const SEND_LABELS = {
  send: { sending: "送信中…", sent: "送信しました", failed: "送信できませんでした" },
  schedule: { sending: "予約中…", sent: "送信を予約しました", failed: "予約できませんでした" },
} as const;

/** Gmail-style send status bar. A failure stays until retried/closed; the compose is
 *  already restored by SEND_FAILED so the text is never lost. */
function SendNoticeBar(): JSX.Element | null {
  const { state, dispatch } = useMailStore();
  const mailApi = useMailApi();
  const notice = state.sendNotice;
  useEffect(() => {
    if (notice?.status !== "sent") return;
    const t = setTimeout(() => dispatch({ type: "DISMISS_SEND_NOTICE" }), 5000);
    return () => clearTimeout(t);
  }, [notice, dispatch]);
  if (!notice) return null;
  const failed = notice.status === "failed";
  return (
    <div
      data-testid="fe2-mail-send-notice"
      data-status={notice.status}
      role={failed ? "alert" : "status"}
      style={{
        position: "fixed",
        left: 24,
        bottom: state.undo ? 80 : 24,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 16px",
        borderRadius: "var(--dub-radius-md)",
        background: "var(--dub-color-text-primary)",
        color: "var(--dub-color-surface-base)",
        boxShadow: "var(--dub-shadow-lg)",
        zIndex: 1400,
        fontSize: "var(--dub-font-size-sm)",
      }}
    >
      <span>{notice.reason ?? SEND_LABELS[notice.pending.kind][notice.status]}</span>
      {failed ? (
        <>
          <button
            type="button"
            data-testid="fe2-mail-send-retry"
            onClick={() => void deliver(mailApi, dispatch, notice.pending)}
            style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-info-300)", fontWeight: 700 }}
          >
            再試行
          </button>
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => dispatch({ type: "DISMISS_SEND_NOTICE" })}
            style={{ all: "unset", cursor: "pointer", display: "inline-flex" }}
          >
            <MailIcon name="x" size={16} />
          </button>
        </>
      ) : null}
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Modal open onClose={onClose} title="キーボード ショートカット" testId="fe2-mail-shortcuts">
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--dub-space-2) var(--dub-space-5)", margin: 0, fontSize: "var(--dub-font-size-sm)" }}>
        {SHORTCUTS.map((s) => (
          <div key={s.keys} style={{ display: "contents" }}>
            <dt style={{ fontWeight: 600, color: "var(--dub-color-text-primary)" }}>{s.keys}</dt>
            <dd style={{ margin: 0, color: "var(--dub-color-text-secondary)" }}>{s.label}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

/** Gmail's keyboard map (SHORTCUTS). `open` and the cursor are the subject of a key; a bulk
 *  selection takes over for the keys that act on many, as it does in Gmail. */
function Shortcuts(): JSX.Element | null {
  const { state, dispatch } = useMailStore();
  const setRead = useReadState();
  const canCompose = useCanCompose();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (modalOpen(e.target)) return;
      if (e.key === "/" && !isTyping(e)) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-testid="fe2-mail-search"]')?.focus();
        return;
      }
      if (shortcutsBlocked(e) || composing(state)) return;

      const rows = selectOrdered(state);
      const onScreen = (id: string | null): id is string => rows.some((t) => t.id === id);
      const open = state.openThreadId;
      // The cursor may be on a row that has since left the view; nothing acts on that.
      const cursor = onScreen(state.cursorId) ? state.cursorId : null;
      const focus = open ?? cursor;
      const checked = [...state.checked].filter(onScreen);
      const targets = !open && checked.length > 0 ? checked : focus ? [focus] : [];

      if (e.key === "c" && canCompose) dispatch({ type: "OPEN_COMPOSE", compose: {} });
      else if (e.key === "?") setHelp(true);
      else if (e.key === "z") dispatch({ type: "UNDO" });
      else if (e.key === "u" && open) dispatch({ type: "CLOSE_THREAD" });
      else if (e.key === "j" || e.key === "k") {
        if (rows.length === 0) return;
        const at = rows.findIndex((t) => t.id === focus);
        const step = e.key === "j" ? 1 : -1;
        const next = at < 0 ? rows[0] : rows[Math.min(rows.length - 1, Math.max(0, at + step))];
        if (!next || next.id === focus) return;
        dispatch(open ? { type: "OPEN_THREAD", id: next.id } : { type: "SET_CURSOR", id: next.id });
      } else if ((e.key === "o" || e.key === "Enter") && !open && cursor) {
        // Enter on a focused control belongs to that control.
        if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("button, a")) return;
        dispatch({ type: "OPEN_THREAD", id: cursor });
      } else if (e.key === "x" && !open && cursor) dispatch({ type: "TOGGLE_CHECK", id: cursor });
      else if (e.key === "s" && focus) dispatch({ type: "TOGGLE_STAR", id: focus });
      else if (targets.length === 0 || state.allInView) return; // 全件選択 confirms in the toolbar first
      else if (e.key === "e") dispatch({ type: "ARCHIVE", ids: targets });
      else if (e.key === "#") dispatch({ type: "TRASH", ids: targets });
      else if (e.key === "I") setRead(targets, true);
      else if (e.key === "U") setRead(targets, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, dispatch, setRead, canCompose]);
  return help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null;
}

function GmailBody(): JSX.Element {
  const { state, dispatch } = useMailStore();
  useMailSync(); // hydrate inbox + Sent from the gateway; lazy-load bodies on open
  useRestoreComposeDraftsOnMount(); // re-open any compose window left dirty by a reload/crash
  // A purged (完全に削除) thread is never shown, even if it was the open one when a reload's
  // APPLY_FLAGS marked it purged — fall back to the list.
  const openThread = state.openThreadId ? state.threads.find((t) => t.id === state.openThreadId && !t.purged) : undefined;
  const unreadInbox = folderUnread(state, "inbox");
  // The sidebar hides 自分宛て / 自分宛て以外 once no shared mail remains — don't strand the view on one.
  // Only once the server counts are in: a 自分宛て page alone never contains shared mail.
  const sharedHidden = state.counts !== null && state.labelFilter === null && SHARED_FOLDERS.has(state.folder) && !showSharedFolders(state);
  useEffect(() => {
    if (sharedHidden) dispatch({ type: "SET_FOLDER", folder: "inbox" });
  }, [sharedHidden, dispatch]);
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const canCompose = useCanCompose();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);

  return (
    <main
      data-testid="fe2-mail-gmail"
      data-unread={unreadInbox}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: narrow ? 0 : 560, background: "var(--dub-color-surface-sunken)" }}
    >
      <SearchBar narrow={narrow} onOpenNav={() => setNavOpen(true)} />
      {canCompose ? null : (
        <div role="status" data-testid="fe2-mail-readonly" style={{ margin: "0 16px 8px", fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)" }}>
          メールは閲覧のみの権限です。送信が必要なら管理者に編集権限を依頼してください。
        </div>
      )}
      <div style={{ flex: 1, display: "flex", gap: 8, minHeight: 0, padding: "0 8px 8px" }}>
        {narrow ? (
          <Drawer open={navOpen} onClose={() => setNavOpen(false)} side="left" title="メール" testId="fe2-mail-nav-drawer">
            <MailSidebar inDrawer onNavigate={() => setNavOpen(false)} />
          </Drawer>
        ) : (
          <MailSidebar />
        )}
        {state.folder === "scheduled" && !state.labelFilter && state.search.trim() === "" ? (
          <ScheduledList />
        ) : state.folder === "drafts" && !state.labelFilter && state.search.trim() === "" ? (
          <DraftList />
        ) : openThread ? (
          // Keyed: j / k moves between conversations, and a half-typed reply must stay with its own.
          <ReadingPane key={openThread.id} thread={openThread} labels={state.labels} />
        ) : state.folder === "blocked" && !state.labelFilter ? (
          <div className={blockStyles.blockedColumn}>
            <BlockedSendersPanel />
            <ThreadList />
          </div>
        ) : (
          <ThreadList />
        )}
      </div>
      {state.composes.map((c, i) => (
        <ComposeWindow key={c.id} compose={c} offset={i} />
      ))}
      <UndoToast />
      <SendNoticeBar />
      <BlockNoticeBar />
      <Shortcuts />
    </main>
  );
}

export function GmailApp(): JSX.Element {
  return (
    <MailStoreProvider>
      <GmailBody />
    </MailStoreProvider>
  );
}
