// Shared UI for the multi-session chat consoles: a session sidebar (list / new / delete),
// a composer whose draft is persisted PER SESSION in localStorage (survives tab round-trips
// and reloads — Task 3), and a message bubble. "Dubに聞く" and "Dubを操作" both compose these.
import { useEffect, useRef, useState } from "react";
import type { ChatKind, ChatMessage, ChatSession } from "./lib/commanderApi.ts";
import { loadDraft, saveDraft, TITLE_MAX, useChat } from "./lib/chatStore.tsx";
import { btnGhost, btnPrimary, card, input, t } from "./lib/theme.ts";
import { isSubmitEnter } from "./lib/keyboard.ts";
import { imageFiles, MAX_IMAGES, prepareImage, type ChatImage } from "./lib/images.ts";
import { Skeleton } from "@dub/ui";

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
  const [editing, setEditing] = useState(false);
  const label = session.title || "新しいチャット";

  return (
    <div
      data-testid="chat-session"
      data-active={active ? "1" : "0"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: t.space1,
        borderRadius: "var(--dub-radius-sm, 8px)",
        border: `1px solid ${active || editing ? t.primary : t.border}`,
        background: active ? t.overlay : "transparent",
        padding: `${t.space1} ${t.space2}`,
      }}
    >
      {editing ? (
        // While renaming the row is the input alone: the delete "×" sits one tap away,
        // so keeping it reachable mid-edit invites a destructive mis-tap.
        <SessionNameInput
          initial={session.title}
          onCommit={(value) => {
            setEditing(false);
            void chat.rename(kind, session.id, value);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <button
            type="button"
            data-testid="chat-select-session"
            onClick={() => chat.select(kind, session.id)}
            onDoubleClick={() => setEditing(true)}
            title={`${label}（ダブルクリックで名前を変更）`}
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
            {label}
          </button>
          <button
            type="button"
            data-testid="chat-rename-session"
            aria-label="チャット名を変更"
            title="チャット名を変更"
            onClick={() => setEditing(true)}
            style={iconBtn}
          >
            ✎
          </button>
          <button
            type="button"
            data-testid="chat-delete-session"
            title="このチャットを削除（履歴も物理削除）"
            aria-label="このチャットを削除"
            onClick={() => {
              if (typeof window !== "undefined" && !window.confirm("このチャットの履歴を削除します。よろしいですか？")) return;
              void chat.remove(kind, session.id);
            }}
            // Extra left margin: the destructive action keeps its distance from ✎.
            style={{ ...iconBtn, marginLeft: t.space1 }}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: 0,
  color: t.textMuted,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: "2px 4px",
  flexShrink: 0,
};

/** Inline name editor for one session row. Enter / blur commit, Escape cancels; an empty
 *  name is a no-op (the store rejects it, so the old name stays). */
function SessionNameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <input
      data-testid="chat-rename-input"
      aria-label="チャット名"
      autoFocus
      value={value}
      maxLength={TITLE_MAX}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      style={{
        flex: 1,
        minWidth: 0,
        background: t.surface,
        color: t.text,
        border: `1px solid ${t.primary}`,
        borderRadius: "var(--dub-radius-sm, 6px)",
        fontSize: 13,
        fontFamily: "inherit",
        padding: `2px ${t.space1}`,
      }}
    />
  );
}

/** Prompt used when the operator sends images without typing anything. */
export const IMAGE_ONLY_TEXT = "この画像を見てください。";

/** A composer whose draft is stored per session in localStorage. Remounts (via `key`)
 *  and a sessionId effect both re-seed it, so navigating away and back keeps the text.
 *  Images can be pasted (Cmd/Ctrl+V), dropped, or picked with 📎, like Claude Code;
 *  they stay in memory only and are dropped on a session switch. */
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
  onSend: (text: string, images: ChatImage[]) => void;
}) {
  const [draft, setDraft] = useState(() => loadDraft(sessionId));
  const [images, setImages] = useState<ChatImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const sidRef = useRef(sessionId);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Re-seed when the active session changes (component may stay mounted across switches).
  useEffect(() => {
    if (sidRef.current !== sessionId) {
      sidRef.current = sessionId;
      setDraft(loadDraft(sessionId));
      setImages([]);
      setImageError(null);
    }
  }, [sessionId]);

  const update = (text: string) => {
    setDraft(text);
    saveDraft(sessionId, text);
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setImageError(null);
    const room = MAX_IMAGES - images.length - preparing;
    if (files.length > room) setImageError(`画像は1回に${MAX_IMAGES}枚までです`);
    const accepted = files.slice(0, Math.max(0, room));
    if (accepted.length === 0) return;
    const sid = sessionId;
    setPreparing((n) => n + accepted.length);
    for (const file of accepted) {
      try {
        const img = await prepareImage(file);
        if (sidRef.current === sid) setImages((prev) => [...prev, img]);
      } catch (e) {
        setImageError((e as Error).message);
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  };

  const canSend = (draft.trim() !== "" || images.length > 0) && !disabled && preparing === 0;

  const submit = () => {
    if (!canSend) return;
    onSend(draft.trim() || IMAGE_ONLY_TEXT, images);
    update("");
    setImages([]);
    setImageError(null);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => {
        if (disabled || !Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(imageFiles(e.dataTransfer.files));
      }}
      data-testid="chat-composer"
      data-dragging={dragging ? "1" : "0"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: t.space3,
        borderRadius: t.radius,
        outline: dragging ? `2px dashed ${t.primary}` : "none",
        outlineOffset: 4,
      }}
    >
      {(images.length > 0 || preparing > 0) && (
        <div data-testid="chat-attachments" style={{ display: "flex", flexWrap: "wrap", gap: t.space3, paddingTop: t.space2 }}>
          {images.map((img) => (
            <div key={img.id} data-testid="chat-attachment" style={{ position: "relative" }}>
              <img src={img.previewUrl} alt={img.name} title={img.name} style={thumb} />
              <button
                type="button"
                data-testid="chat-attachment-remove"
                aria-label={`${img.name} を外す`}
                title="外す"
                onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                style={removeBtn}
              >
                ×
              </button>
            </div>
          ))}
          {Array.from({ length: preparing }, (_, i) => (
            <div key={`prep-${i}`} data-testid="chat-attachment-skeleton" aria-label="画像を準備中">
              <Skeleton variant="rect" width={72} height={72} radius="var(--dub-radius-sm, 8px)" />
            </div>
          ))}
        </div>
      )}
      {imageError && (
        <p data-testid="chat-attachment-error" role="alert" style={{ margin: 0, fontSize: 12, color: t.danger }}>
          {imageError}
        </p>
      )}
      <div style={{ display: "flex", gap: t.space3, alignItems: "flex-end" }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          data-testid="chat-file-input"
          onChange={(e) => {
            void addFiles(imageFiles(e.target.files));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          data-testid="chat-attach"
          aria-label="画像を添付"
          title="画像を添付（貼り付け・ドラッグ&ドロップでも可）"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          style={{ ...btnGhost, padding: `${t.space2} ${t.space3}`, opacity: disabled ? 0.5 : 1 }}
        >
          📎
        </button>
        <textarea
          data-testid="chat-input"
          value={draft}
          onChange={(e) => update(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.files);
            if (files.length === 0) return; // plain text paste stays native
            e.preventDefault();
            void addFiles(files);
          }}
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
          style={{ ...btnPrimary, whiteSpace: "nowrap", opacity: canSend ? 1 : 0.5 }}
          disabled={!canSend}
          data-testid="chat-send"
        >
          {busy ? "実行中…" : sendLabel}
        </button>
      </div>
    </form>
  );
}

const thumb: React.CSSProperties = {
  width: 72,
  height: 72,
  objectFit: "cover",
  borderRadius: "var(--dub-radius-sm, 8px)",
  border: `1px solid ${t.border}`,
  display: "block",
};

const removeBtn: React.CSSProperties = {
  position: "absolute",
  top: -8,
  right: -8,
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: `1px solid ${t.borderStrong}`,
  background: t.surface,
  color: t.text,
  fontSize: 13,
  lineHeight: "18px",
  padding: 0,
  cursor: "pointer",
};

/** Thumbnails of the images a user message was sent with; click to view full size. */
function MessageImages({ urls }: { urls: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div data-testid="chat-msg-images" style={{ display: "flex", flexWrap: "wrap", gap: t.space2, justifyContent: "flex-end" }}>
      {urls.map((url, i) => (
        <button
          key={i}
          type="button"
          aria-label={`添付画像 ${i + 1} を拡大`}
          onClick={() => setOpen(url)}
          style={{ padding: 0, border: 0, background: "transparent", cursor: "zoom-in" }}
        >
          <img src={url} alt={`添付画像 ${i + 1}`} style={{ ...thumb, width: 120, height: 90 }} />
        </button>
      ))}
      {open && (
        <div
          data-testid="chat-image-viewer"
          role="dialog"
          aria-label="添付画像"
          onClick={() => setOpen(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: t.space6,
            cursor: "zoom-out",
          }}
        >
          <img src={open} alt="添付画像（拡大）" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: t.radius }} />
        </div>
      )}
    </div>
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
      {isUser && msg.images && msg.images.length > 0 && <MessageImages urls={msg.images} />}
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
