// Shared UI for the multi-session chat consoles: a session sidebar (list / new / delete),
// a composer whose draft is persisted PER SESSION in localStorage (survives tab round-trips
// and reloads — Task 3), and a message bubble. "Dubに聞く" and "Dubを操作" both compose these.
import { useEffect, useRef, useState } from "react";
import type { ChatKind, ChatMessage, ChatSession } from "./lib/commanderApi.ts";
import { loadDraft, saveDraft, useChat } from "./lib/chatStore.tsx";
import { btnGhost, btnPrimary, card, input, t } from "./lib/theme.ts";
import { isSubmitEnter } from "./lib/keyboard.ts";

export function SessionSidebar({ kind }: { kind: ChatKind }) {
  const chat = useChat();
  const sessions = chat.sessions(kind);
  const active = chat.activeId(kind);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: t.space2, width: 200, flexShrink: 0 }}
      data-testid="chat-sidebar"
    >
      <button
        type="button"
        style={{ ...btnPrimary, width: "100%" }}
        data-testid="chat-new-session"
        onClick={() => void chat.create(kind)}
      >
        ＋ 新しいチャット
      </button>
      <div style={{ display: "flex", flexDirection: "column", gap: t.space1, overflowY: "auto", maxHeight: "60vh" }}>
        {sessions.length === 0 && (
          <p style={{ fontSize: 12, color: t.textMuted, padding: t.space2 }}>まだチャットがありません。</p>
        )}
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} active={s.id === active} kind={kind} running={chat.isRunning(s.id)} />
        ))}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  kind,
  running,
}: {
  session: ChatSession;
  active: boolean;
  kind: ChatKind;
  running: boolean;
}) {
  const chat = useChat();
  return (
    <div
      data-testid="chat-session"
      data-active={active ? "1" : "0"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: t.space1,
        borderRadius: "var(--dub-radius-sm, 8px)",
        border: `1px solid ${active ? t.primary : t.border}`,
        background: active ? t.overlay : "transparent",
        padding: `${t.space1} ${t.space2}`,
      }}
    >
      <button
        type="button"
        data-testid="chat-select-session"
        onClick={() => chat.select(kind, session.id)}
        title={session.title || "新しいチャット"}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          background: "transparent",
          border: 0,
          color: active ? t.text : t.textMuted,
          fontSize: 13,
          fontWeight: active ? 600 : 400,
          cursor: "pointer",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontFamily: "inherit",
          padding: t.space1,
        }}
      >
        {running && <span style={{ color: t.warning }}>● </span>}
        {session.title || "新しいチャット"}
      </button>
      <button
        type="button"
        data-testid="chat-delete-session"
        title="このチャットを削除（履歴も物理削除）"
        onClick={() => {
          if (typeof window !== "undefined" && !window.confirm("このチャットの履歴を削除します。よろしいですか？")) return;
          void chat.remove(kind, session.id);
        }}
        style={{ background: "transparent", border: 0, color: t.textMuted, cursor: "pointer", fontSize: 14, padding: "0 4px" }}
      >
        ×
      </button>
    </div>
  );
}

/** A composer whose draft is stored per session in localStorage. Remounts (via `key`)
 *  and a sessionId effect both re-seed it, so navigating away and back keeps the text. */
export function ChatComposer({
  sessionId,
  placeholder,
  disabled,
  busy,
  sendLabel,
  onSend,
}: {
  sessionId: string;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  sendLabel: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState(() => loadDraft(sessionId));
  const sidRef = useRef(sessionId);

  // Re-seed when the active session changes (component may stay mounted across switches).
  useEffect(() => {
    if (sidRef.current !== sessionId) {
      sidRef.current = sessionId;
      setDraft(loadDraft(sessionId));
    }
  }, [sessionId]);

  const update = (text: string) => {
    setDraft(text);
    saveDraft(sessionId, text);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    update("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ display: "flex", gap: t.space3, alignItems: "flex-end" }}
    >
      <textarea
        data-testid="chat-input"
        value={draft}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitEnter(e)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        rows={2}
        style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
        disabled={disabled}
      />
      <button
        type="submit"
        style={{ ...btnPrimary, whiteSpace: "nowrap", opacity: disabled || !draft.trim() ? 0.5 : 1 }}
        disabled={disabled || !draft.trim()}
        data-testid="chat-send"
      >
        {busy ? "実行中…" : sendLabel}
      </button>
    </form>
  );
}

export function MessageBubble({
  msg,
  bodyOverride,
  children,
}: {
  msg: ChatMessage;
  /** When provided (e.g. an operate plan), render this INSTEAD of the raw text bubble. */
  bodyOverride?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const isUser = msg.role === "user";
  const wide = children != null || bodyOverride != null;
  return (
    <div
      data-testid={`chat-msg-${msg.role}`}
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: wide ? "100%" : "88%",
        width: wide ? "100%" : undefined,
        display: "flex",
        flexDirection: "column",
        gap: t.space2,
      }}
    >
      {bodyOverride ?? (
        <div
          style={{
            background: isUser ? t.primary : t.surface,
            color: isUser ? "#fff" : t.text,
            border: isUser ? "none" : `1px solid ${t.border}`,
            borderRadius: t.radius,
            padding: `${t.space3} ${t.space4}`,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.6,
            fontSize: 14,
          }}
        >
          {msg.text ? (
            msg.text
          ) : msg.status === "streaming" ? (
            <span style={{ color: t.textMuted }}>実行中…</span>
          ) : msg.status === "error" ? (
            <span style={{ color: t.danger }}>取得できませんでした。</span>
          ) : (
            ""
          )}
          {msg.status === "streaming" && msg.text && <span style={{ color: t.textMuted }}> ▍</span>}
        </div>
      )}

      {children}

      {!isUser && msg.tools.length > 0 && (
        <details style={{ fontSize: 12, color: t.textMuted }}>
          <summary style={{ cursor: "pointer" }}>
            調べたもの {msg.status === "streaming" ? `(${msg.tools.length}件・進行中)` : `(${msg.tools.length}件)`}
          </summary>
          <ul style={{ margin: `${t.space2} 0 0`, paddingLeft: t.space5 }}>
            {msg.tools.slice(-30).map((tl, i) => (
              <li key={i} style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                {tl}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The scrolling message log shared by both consoles. Auto-scrolls on new content. */
export function MessageLog({
  messages,
  emptyState,
  renderExtra,
  renderBody,
}: {
  messages: ChatMessage[];
  emptyState: React.ReactNode;
  renderExtra?: (msg: ChatMessage) => React.ReactNode;
  /** Override the default text bubble for a message (e.g. an operate plan card). */
  renderBody?: (msg: ChatMessage) => React.ReactNode | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      data-testid="chat-log"
      style={{
        ...card,
        flex: 1,
        minHeight: 320,
        maxHeight: "56vh",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: t.space4,
        background: t.sunken,
      }}
    >
      {messages.length === 0 ? (
        <div style={{ margin: "auto", textAlign: "center", color: t.textMuted }}>{emptyState}</div>
      ) : (
        messages.map((m) => (
          <MessageBubble key={m.id} msg={m} bodyOverride={renderBody?.(m)}>
            {renderExtra?.(m)}
          </MessageBubble>
        ))
      )}
    </div>
  );
}

export { btnGhost };
