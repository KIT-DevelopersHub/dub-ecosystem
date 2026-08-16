// In-place preview for a compose attachment (判断18 フォロー: "下書きの添付をクリックしたら
// その場でプレビュー"). Opens a @dub/ui Modal (portal + Esc + focus-trap + scroll-lock) over
// the compose window and renders the picked file WITHOUT a server round-trip:
//   • image → inline <img> (blob/object URL);
//   • pdf   → embedded <iframe> viewer;
//   • text/code → text panel (FileReader, size-guarded, skeleton while reading);
//   • その他 → "プレビュー不可" フォールバック＋ダウンロード。
// Multiple attachments get prev/next navigation and a counter. Non-destructive: it only
// reads the File the tray already holds; add/remove/DnD/limits are untouched.
import { useEffect, useState, type CSSProperties } from "react";
import { Button, Modal } from "@dub/ui";
import { MailIcon } from "./gmail/icons.tsx";
import { saveBlob } from "./mailApi.tsx";
import { TEXT_PREVIEW_MAX_BYTES, previewKind } from "./attach.ts";
import type { ComposeAttachmentItem } from "./useComposeAttachments.tsx";

const CANVAS_MIN_HEIGHT = 360;

/** Manage an object URL for a File (image/pdf viewers). Revoked on change/unmount. Guarded
 *  so jsdom (createObjectURL stubbed) and SSR never throw. */
function useObjectUrl(file: File | undefined, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !enabled || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    let created: string | null = null;
    try {
      created = URL.createObjectURL(file);
      setUrl(created);
    } catch {
      setUrl(null);
    }
    return () => {
      if (created && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(created);
    };
  }, [file, enabled]);
  return url;
}

const skeletonStyle: CSSProperties = {
  height: CANVAS_MIN_HEIGHT,
  borderRadius: "var(--dub-radius-md)",
  background: "linear-gradient(90deg, var(--dub-color-surface-sunken) 25%, var(--dub-color-surface-raised) 37%, var(--dub-color-surface-sunken) 63%)",
  backgroundSize: "400% 100%",
  animation: "dub-skeleton-shimmer 1.4s ease infinite",
};

function Fallback({ item, reason }: { item: ComposeAttachmentItem; reason: string }): JSX.Element {
  return (
    <div
      data-testid="fe2-mail-preview-unsupported"
      style={{ minHeight: CANVAS_MIN_HEIGHT, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--dub-color-text-muted)" }}
    >
      <MailIcon name="file" size={40} />
      <span style={{ fontSize: "var(--dub-font-size-sm)" }}>{reason}</span>
      <Button variant="secondary" testId="fe2-mail-preview-download" onClick={() => saveBlob(item.file, item.filename)}>
        ダウンロード
      </Button>
    </div>
  );
}

function TextPreview({ item }: { item: ComposeAttachmentItem }): JSX.Element {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error" | "toobig"; text?: string }>({ status: "loading" });
  useEffect(() => {
    if (item.sizeBytes > TEXT_PREVIEW_MAX_BYTES) {
      setState({ status: "toobig" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    const onText = (t: string): void => {
      if (alive) setState({ status: "ready", text: t });
    };
    const onErr = (): void => {
      if (alive) setState({ status: "error" });
    };
    if (typeof FileReader === "undefined") {
      item.file.text().then(onText).catch(onErr);
      return () => {
        alive = false;
      };
    }
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result ?? ""));
    reader.onerror = onErr;
    reader.readAsText(item.file);
    return () => {
      alive = false;
    };
  }, [item]);

  if (state.status === "loading") return <div data-testid="fe2-mail-preview-skeleton" style={skeletonStyle} />;
  if (state.status === "toobig") return <Fallback item={item} reason="ファイルが大きいためプレビューを省略しました" />;
  if (state.status === "error") return <Fallback item={item} reason="プレビューを表示できませんでした" />;
  return (
    <pre
      data-testid="fe2-mail-preview-text"
      style={{
        margin: 0,
        maxHeight: 480,
        overflow: "auto",
        padding: 12,
        borderRadius: "var(--dub-radius-md)",
        background: "var(--dub-color-surface-sunken)",
        color: "var(--dub-color-text-primary)",
        fontSize: "var(--dub-font-size-xs)",
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "var(--dub-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
      }}
    >
      {state.text}
    </pre>
  );
}

function PreviewBody({ item }: { item: ComposeAttachmentItem }): JSX.Element {
  const kind = previewKind(item.contentType, item.filename);
  const needsUrl = kind === "image" || kind === "pdf";
  const objUrl = useObjectUrl(item.file, needsUrl);

  if (kind === "image") {
    const src = item.previewUrl ?? objUrl;
    return src ? (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: CANVAS_MIN_HEIGHT, background: "var(--dub-color-surface-sunken)", borderRadius: "var(--dub-radius-md)" }}>
        <img data-testid="fe2-mail-preview-image" src={src} alt={item.filename} style={{ maxWidth: "100%", maxHeight: 520, objectFit: "contain" }} />
      </div>
    ) : (
      <div data-testid="fe2-mail-preview-skeleton" style={skeletonStyle} />
    );
  }
  if (kind === "pdf") {
    return objUrl ? (
      <iframe data-testid="fe2-mail-preview-pdf" title={item.filename} src={objUrl} style={{ width: "100%", height: 520, border: "none", borderRadius: "var(--dub-radius-md)", background: "var(--dub-color-surface-sunken)" }} />
    ) : (
      <div data-testid="fe2-mail-preview-skeleton" style={skeletonStyle} />
    );
  }
  if (kind === "text") return <TextPreview item={item} />;
  return <Fallback item={item} reason="この形式はプレビューに対応していません" />;
}

/** The compose-attachment preview modal. `openId` names the attachment to open (null = closed);
 *  navigation moves within `items`. Rendering nothing when closed keeps the Modal unmounted. */
export function AttachmentPreview({
  items,
  openId,
  onClose,
}: {
  items: ComposeAttachmentItem[];
  openId: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const [idx, setIdx] = useState(0);
  // Jump to the clicked attachment when the modal opens (not on later list edits).
  useEffect(() => {
    if (openId == null) return;
    const i = items.findIndex((it) => it.id === openId);
    if (i >= 0) setIdx(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);
  // If the list empties while open (e.g. all removed), close.
  useEffect(() => {
    if (openId != null && items.length === 0) onClose();
  }, [openId, items.length, onClose]);

  if (openId == null || items.length === 0) return null;
  const safeIdx = Math.min(idx, items.length - 1);
  const current = items[safeIdx]!;
  const multi = items.length > 1;
  const go = (delta: number): void => setIdx((safeIdx + delta + items.length) % items.length);

  const footer = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
      {multi ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="secondary" testId="fe2-mail-preview-prev" onClick={() => go(-1)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <MailIcon name="chevron-left" size={16} /> 前へ
            </span>
          </Button>
          <span data-testid="fe2-mail-preview-counter" style={{ fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)" }}>
            {safeIdx + 1} / {items.length}
          </span>
          <Button variant="secondary" testId="fe2-mail-preview-next" onClick={() => go(1)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              次へ <MailIcon name="chevron-right" size={16} />
            </span>
          </Button>
        </div>
      ) : null}
      <span style={{ flex: 1 }} />
      <Button variant="secondary" testId="fe2-mail-preview-download-footer" onClick={() => saveBlob(current.file, current.filename)}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <MailIcon name="download" size={16} /> ダウンロード
        </span>
      </Button>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={current.filename} size="lg" footer={footer} testId="fe2-mail-attach-preview">
      <PreviewBody key={current.id} item={current} />
    </Modal>
  );
}
