// Gmail-style attachment tray: one card per picked file with a type icon or image
// thumbnail, the filename, a size line that becomes a progress bar while the file is being
// read, and a remove (×) button. Purely presentational — fed by useComposeAttachments —
// so ComposeWindow and ComposeScreen render an identical tray. Built from @dub/tokens vars.
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { MailIcon } from "./gmail/icons.tsx";
import { formatBytes } from "./mailApi.tsx";
import type { ComposeAttachmentItem } from "./useComposeAttachments.tsx";

function iconFor(contentType: string): "image" | "file" {
  return contentType.startsWith("image/") ? "image" : "file";
}

function AttachmentCard({
  item,
  onRemove,
  onOpen,
}: {
  item: ComposeAttachmentItem;
  onRemove: (id: string) => void;
  onOpen?: (id: string) => void;
}): JSX.Element {
  const reading = item.status === "reading";
  const errored = item.status === "error";
  const clickable = Boolean(onOpen) && !errored;
  // The card itself opens the preview (role=button + keyboard); the × is a nested <button>
  // with stopPropagation so removing never opens the preview (no invalid nested buttons).
  const open = (): void => {
    if (clickable) onOpen!(item.id);
  };
  return (
    <div
      data-testid="fe2-mail-attach-chip"
      data-status={item.status}
      title={clickable ? `${item.filename}（クリックでプレビュー）` : item.filename}
      {...(clickable
        ? {
            role: "button",
            tabIndex: 0,
            onClick: open,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            },
          }
        : {})}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: 220,
        maxWidth: "100%",
        padding: 6,
        borderRadius: "var(--dub-radius-md)",
        border: `1px solid ${errored ? "var(--dub-color-danger-500, #d33)" : "var(--dub-color-border-default)"}`,
        background: "var(--dub-color-surface-base)",
        cursor: clickable ? "pointer" : "default",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: "var(--dub-radius-sm)",
          overflow: "hidden",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--dub-color-surface-sunken)",
          color: "var(--dub-color-text-muted)",
        }}
      >
        {item.previewUrl ? (
          <img src={item.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <MailIcon name={iconFor(item.contentType)} size={18} />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontSize: "var(--dub-font-size-xs)",
            fontWeight: 600,
            color: "var(--dub-color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.filename}
        </span>
        {reading ? (
          <span
            data-testid="fe2-mail-attach-progress"
            aria-label="読み込み中"
            style={{ height: 4, borderRadius: 2, background: "var(--dub-color-surface-sunken)", overflow: "hidden" }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${Math.round(item.progress * 100)}%`,
                background: "var(--dub-color-brand-500)",
                transition: "width 120ms linear",
              }}
            />
          </span>
        ) : (
          <span style={{ fontSize: 11, color: errored ? "var(--dub-color-danger-500, #d33)" : "var(--dub-color-text-muted)" }}>
            {errored ? "読み込みに失敗しました" : formatBytes(item.sizeBytes)}
          </span>
        )}
      </span>
      <button
        type="button"
        data-testid="fe2-mail-attach-remove"
        aria-label={`${item.filename} を削除`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(item.id);
        }}
        style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-muted)", padding: 4, flexShrink: 0 }}
      >
        <MailIcon name="x" size={14} />
      </button>
    </div>
  );
}

export function AttachmentTray({
  items,
  onRemove,
  onOpen,
  testId = "fe2-mail-attach-tray",
}: {
  items: ComposeAttachmentItem[];
  onRemove: (id: string) => void;
  /** When provided, clicking a (non-errored) chip opens the in-place preview. */
  onOpen?: (id: string) => void;
  testId?: string;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div data-testid={testId} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {items.map((it) => (
        <AttachmentCard key={it.id} item={it} onRemove={onRemove} {...(onOpen ? { onOpen } : {})} />
      ))}
    </div>
  );
}

/** Dismissible red banner listing files the compose rules refused (size / type / count). */
export function AttachmentErrors({ errors, onDismiss }: { errors: string[]; onDismiss: () => void }): JSX.Element | null {
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="fe2-mail-attach-errors"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 12px",
        borderRadius: "var(--dub-radius-md)",
        background: "var(--dub-color-danger-50, rgba(211,51,51,0.08))",
        border: "1px solid var(--dub-color-danger-500, #d33)",
        color: "var(--dub-color-danger-700, #a11)",
        fontSize: "var(--dub-font-size-xs)",
      }}
    >
      <MailIcon name="alert" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        {errors.map((e, i) => (
          <span key={`${e}-${i}`}>{e}</span>
        ))}
      </span>
      <button
        type="button"
        aria-label="警告を閉じる"
        onClick={onDismiss}
        style={{ all: "unset", cursor: "pointer", color: "inherit", padding: 2, flexShrink: 0 } as CSSProperties}
      >
        <MailIcon name="x" size={14} />
      </button>
    </div>
  );
}
