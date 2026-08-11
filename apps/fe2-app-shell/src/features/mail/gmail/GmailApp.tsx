// Top-level Gmail-style mail experience. Composes the full-width search bar, the
// left folder/label nav, the center list ↔ reading-pane swap, floating compose
// windows and an undo toast. Owns keyboard shortcuts (c compose / e archive /
// # delete / r reply / j·k move / x select / / focus search). All state lives in
// the client MailStore (demo); real API wiring merges later.
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { mail } from "@dub/types";
import { queryKeys } from "../../../lib/queryKeys.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { MailSidebar } from "./MailSidebar.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { ReadingPane } from "./ReadingPane.tsx";
import { ComposeWindow } from "./ComposeWindow.tsx";
import { MailIcon } from "./icons.tsx";
import { inFolder, matchesQuery, threadUnread, type MailMsg, type MailPerson, type MailThreadModel } from "./mailModel.ts";
import { MailStoreProvider, useMailStore } from "./useMailStore.tsx";

// ---- gateway ↔ store mapping (the live app's data flow) ----
function toPerson(a: mail.MailAddress): MailPerson {
  return a.name ? { email: a.email, name: a.name } : { email: a.email };
}
function inboxToThread(item: mail.MailMessageListItem): MailThreadModel {
  return {
    id: item.id,
    apiThreadId: item.threadId,
    subject: item.subject,
    folder: "inbox",
    starred: false,
    labels: [],
    hydrated: false,
    messages: [{ id: item.id, from: toPerson(item.from), to: item.to.map(toPerson), date: item.receivedAt, body: item.snippet, read: item.read }],
  };
}
function sentToThread(item: mail.MailSentListItem, me: MailPerson): MailThreadModel {
  const cc = item.cc?.map(toPerson);
  return {
    id: item.id,
    subject: item.subject,
    folder: "sent",
    starred: false,
    labels: [],
    hydrated: false,
    messages: [
      {
        id: item.id,
        from: item.from ? toPerson(item.from) : me,
        to: item.to.map(toPerson),
        ...(cc && cc.length > 0 ? { cc } : {}),
        date: item.sentAt,
        body: item.snippet,
        read: true,
      },
    ],
  };
}
function inboxDetailToMsg(d: mail.MailMessageDetail): MailMsg {
  return { id: d.id, from: toPerson(d.from), to: d.to.map(toPerson), date: d.receivedAt, body: d.textBody || d.snippet, read: true };
}
function sentDetailToMsgs(d: mail.MailSentDetail, me: MailPerson): MailMsg[] {
  const cc = d.cc?.map(toPerson);
  return [
    {
      id: d.id,
      from: d.from ? toPerson(d.from) : me,
      to: d.to.map(toPerson),
      ...(cc && cc.length > 0 ? { cc } : {}),
      date: d.sentAt,
      body: d.textBody || d.snippet,
      read: true,
    },
  ];
}

/** Hydrates the client store from the gateway: Inbox ← GET /mail/messages, Sent ← GET
 *  /mail/sent (source of truth). Bodies are fetched lazily on open (getThread/getSent),
 *  and opening an unread inbox message marks it read via the API. Compose persists via
 *  POST /outbox and invalidates the Sent query, so a sent mail survives a reload. */
function useGatewaySync(): void {
  const mailApi = useMailApi();
  const { state, dispatch } = useMailStore();
  const me = state.me;

  const inboxQ = useQuery({ queryKey: queryKeys.feature("mail", "inbox"), queryFn: () => mailApi.listInbox({ limit: 50 }) });
  const sentQ = useQuery({ queryKey: queryKeys.feature("mail", "sent-list"), queryFn: () => mailApi.listSent({ limit: 50 }) });

  const inboxData = inboxQ.data;
  const sentData = sentQ.data;
  useEffect(() => {
    if (!inboxData && !sentData) return;
    const threads = [
      ...(inboxData?.items ?? []).map(inboxToThread),
      ...(sentData?.items ?? []).map((s) => sentToThread(s, me)),
    ];
    dispatch({ type: "SET_THREADS", threads });
  }, [inboxData, sentData, me, dispatch]);

  // Lazy body load + mark-read on open.
  const openId = state.openThreadId;
  useEffect(() => {
    if (!openId) return;
    const t = state.threads.find((x) => x.id === openId);
    if (!t || t.hydrated) return;
    let cancelled = false;
    if (t.folder === "sent") {
      void mailApi
        .getSent(t.id)
        .then((d) => !cancelled && dispatch({ type: "HYDRATE_THREAD", id: t.id, messages: sentDetailToMsgs(d, me) }))
        .catch(() => undefined);
    } else {
      const tid = t.apiThreadId ?? t.id;
      void mailApi
        .getThread(tid)
        .then((thr) => !cancelled && dispatch({ type: "HYDRATE_THREAD", id: t.id, messages: thr.messages.map(inboxDetailToMsg) }))
        .catch(() => undefined);
      if (t.messages.some((m) => !m.read)) void mailApi.markRead(t.messages[0]!.id).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // Fire once per opened thread; store reads use the current closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);
}

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
  useGatewaySync();
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
