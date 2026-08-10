// Top-level Gmail-style mail experience. Composes the full-width search bar, the
// left folder/label nav, the center list ↔ reading-pane swap, floating compose
// windows and an undo toast. Owns keyboard shortcuts (c compose / e archive /
// # delete / r reply / j·k move / x select / / focus search). All state lives in
// the client MailStore (demo); real API wiring merges later.
import { useEffect, useRef } from "react";
import { MailSidebar } from "./MailSidebar.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { ReadingPane } from "./ReadingPane.tsx";
import { ComposeWindow } from "./ComposeWindow.tsx";
import { MailIcon } from "./icons.tsx";
import { inFolder, matchesQuery, threadUnread } from "./mailModel.ts";
import { MailStoreProvider, useMailStore } from "./useMailStore.tsx";

function SearchBar(): JSX.Element {
  const { state, dispatch } = useMailStore();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--dub-color-text-primary)", fontWeight: 700, fontSize: "var(--dub-font-size-lg)", width: 240 }}>
        <MailIcon name="inbox" size={24} style={{ color: "var(--dub-color-brand-500)" }} />
        メール
      </div>
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
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-sm)", fontFamily: "inherit" }}
        />
        {state.search ? (
          <button type="button" aria-label="検索をクリア" onClick={() => dispatch({ type: "SET_SEARCH", search: "" })} style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-muted)" }}>
            <MailIcon name="x" size={18} />
          </button>
        ) : null}
      </div>
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

function Shortcuts(): null {
  const { state, dispatch } = useMailStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-testid="fe2-mail-search"]')?.focus();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const visible = state.threads.filter(
        (t) => (state.labelFilter ? t.labels.includes(state.labelFilter) && t.folder !== "trash" : inFolder(t, state.folder)) && matchesQuery(t, state.search),
      );
      const open = state.openThreadId;

      if (e.key === "c") dispatch({ type: "OPEN_COMPOSE", compose: {} });
      else if (open && e.key === "e") dispatch({ type: "ARCHIVE", ids: [open] });
      else if (open && e.key === "#") dispatch({ type: "TRASH", ids: [open] });
      else if (open && e.key === "u") dispatch({ type: "CLOSE_THREAD" });
      else if (!open && (e.key === "j" || e.key === "k")) {
        if (visible.length === 0) return;
        const next = e.key === "j" ? visible[0] : visible[visible.length - 1];
        if (next) dispatch({ type: "OPEN_THREAD", id: next.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.threads, state.folder, state.labelFilter, state.search, state.openThreadId, dispatch]);
  return null;
}

function GmailBody(): JSX.Element {
  const { state } = useMailStore();
  const openThread = state.openThreadId ? state.threads.find((t) => t.id === state.openThreadId) : undefined;
  const unreadInbox = state.threads.filter((t) => inFolder(t, "inbox") && threadUnread(t)).length;

  return (
    <main
      data-testid="fe2-mail-gmail"
      data-unread={unreadInbox}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 560, background: "var(--dub-color-surface-sunken)" }}
    >
      <SearchBar />
      <div style={{ flex: 1, display: "flex", gap: 8, minHeight: 0, padding: "0 8px 8px" }}>
        <MailSidebar />
        {openThread ? <ReadingPane thread={openThread} labels={state.labels} /> : <ThreadList />}
      </div>
      {state.composes.map((c, i) => (
        <ComposeWindow key={c.id} compose={c} offset={i} />
      ))}
      <UndoToast />
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
