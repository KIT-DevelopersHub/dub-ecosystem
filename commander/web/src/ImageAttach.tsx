// Image attachments for any prompt box (chat composer, task composer, rerun / reject forms).
// Paste (Cmd/Ctrl+V), drop, or pick with 📎 — like Claude Code. Images stay in memory only;
// the caller uploads them with client.uploadImage right before starting the run.
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@dub/ui";
import { imageFiles, MAX_IMAGES, prepareImage, type ChatImage } from "./lib/images.ts";
import { btnGhost, t } from "./lib/theme.ts";

export interface ImageAttachments {
  images: ChatImage[];
  /** Images still being shrunk / encoded (send must wait for them). */
  preparing: number;
  error: string | null;
  dragging: boolean;
  addFiles: (files: File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  /** Spread onto the <textarea>: image pastes attach, plain text pastes stay native. */
  onPaste: (e: React.ClipboardEvent) => void;
  /** Spread onto the drop target (usually the form / wrapper). */
  dropProps: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

/** Attachment state. Changing `scope` (e.g. the chat session) drops the images, and an image
 *  still preparing for an old scope never lands in the new one. */
export function useImageAttachments({ scope = "", disabled = false }: { scope?: string; disabled?: boolean } = {}): ImageAttachments {
  const [images, setImages] = useState<ChatImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const scopeRef = useRef(scope);

  useEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      setImages([]);
      setError(null);
    }
  }, [scope]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    const room = MAX_IMAGES - images.length - preparing;
    if (files.length > room) setError(`画像は1回に${MAX_IMAGES}枚までです`);
    const accepted = files.slice(0, Math.max(0, room));
    if (accepted.length === 0) return;
    const at = scope;
    setPreparing((n) => n + accepted.length);
    for (const file of accepted) {
      try {
        const img = await prepareImage(file);
        if (scopeRef.current === at) setImages((prev) => [...prev, img]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  };

  return {
    images,
    preparing,
    error,
    dragging,
    addFiles,
    remove: (id) => setImages((prev) => prev.filter((x) => x.id !== id)),
    clear: () => {
      setImages([]);
      setError(null);
    },
    onPaste: (e) => {
      const files = imageFiles(e.clipboardData.files);
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(files);
    },
    dropProps: {
      onDragOver: (e) => {
        if (disabled || !Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(imageFiles(e.dataTransfer.files));
      },
    },
  };
}

/** Outline shown on the drop target while files are dragged over it. */
export const dropOutline = (dragging: boolean): React.CSSProperties => ({
  borderRadius: t.radius,
  outline: dragging ? `2px dashed ${t.primary}` : "none",
  outlineOffset: 4,
});

/** Thumbnails (with remove buttons), preparing skeletons, and the last error. */
export function AttachmentTray({ att, testIdPrefix = "chat" }: { att: ImageAttachments; testIdPrefix?: string }) {
  return (
    <>
      {(att.images.length > 0 || att.preparing > 0) && (
        <div data-testid={`${testIdPrefix}-attachments`} style={{ display: "flex", flexWrap: "wrap", gap: t.space3, paddingTop: t.space2 }}>
          {att.images.map((img) => (
            <div key={img.id} data-testid={`${testIdPrefix}-attachment`} style={{ position: "relative" }}>
              <img src={img.previewUrl} alt={img.name} title={img.name} style={thumb} />
              <button
                type="button"
                data-testid={`${testIdPrefix}-attachment-remove`}
                aria-label={`${img.name} を外す`}
                title="外す"
                onClick={() => att.remove(img.id)}
                style={removeBtn}
              >
                ×
              </button>
            </div>
          ))}
          {Array.from({ length: att.preparing }, (_, i) => (
            <div key={`prep-${i}`} data-testid={`${testIdPrefix}-attachment-skeleton`} aria-label="画像を準備中">
              <Skeleton variant="rect" width={72} height={72} radius="var(--dub-radius-sm, 8px)" />
            </div>
          ))}
        </div>
      )}
      {att.error && (
        <p data-testid={`${testIdPrefix}-attachment-error`} role="alert" style={{ margin: 0, fontSize: 12, color: t.danger }}>
          {att.error}
        </p>
      )}
    </>
  );
}

/** 📎 button + its hidden file input. */
export function AttachButton({
  att,
  disabled,
  testIdPrefix = "chat",
  label = "📎",
}: {
  att: ImageAttachments;
  disabled?: boolean;
  testIdPrefix?: string;
  label?: string;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        data-testid={`${testIdPrefix}-file-input`}
        onChange={(e) => {
          void att.addFiles(imageFiles(e.target.files));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        data-testid={`${testIdPrefix}-attach`}
        aria-label="画像を添付"
        title="画像を添付（貼り付け・ドラッグ&ドロップでも可）"
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
        style={{ ...btnGhost, padding: `${t.space2} ${t.space3}`, whiteSpace: "nowrap", opacity: disabled ? 0.5 : 1 }}
      >
        {label}
      </button>
    </>
  );
}

export const thumb: React.CSSProperties = {
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
