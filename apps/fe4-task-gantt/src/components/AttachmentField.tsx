import { useRef, useState } from "react";
import { Button, TextField, SkeletonList } from "@dub/ui";
import { humanFileSize } from "../domain/attachments";
import styles from "../styles/app.module.css";

/** One row shown in the compact chip list. Presentational only — the host owns the
 *  underlying model (a persisted task.TaskAttachment or an in-modal draft). */
export interface AttachmentChip {
  /** Stable id used as the React key and passed back to onRemove. */
  id: string;
  kind: "file" | "url";
  name: string;
  /** When set, the chip name is a link (detail view opens/downloads it). Draft chips
   *  (task not yet created) omit it and render as plain text. */
  href?: string;
  /** Add the download attribute (file attachments in the detail view). */
  download?: boolean;
  sizeBytes?: number | null;
}

export interface AttachmentFieldProps {
  chips: readonly AttachmentChip[];
  /** Gate the add/remove controls behind write access. Read (chips) always shows. */
  canWrite: boolean;
  /** Section heading. */
  heading?: string;
  /** Disable the controls while a mutation is in flight. */
  busy?: boolean;
  /** Host-provided error (e.g. the 1MB file-size cap) shown under the controls. */
  error?: string | null;
  /** Initial load in progress (persisted view) — show a skeleton instead of the list. */
  loading?: boolean;
  /** Initial load failed (persisted view). */
  loadFailed?: boolean;
  onPickFiles: (files: FileList) => void;
  onAddUrl: (url: string, name: string) => void;
  onRemove: (id: string) => void;
  /** Prefix for data-testids, e.g. "fe4-detail-attach" / "fe4-mytask-attach". */
  testIdPrefix: string;
}

/**
 * Compact attachment control shared by the gantt タスク詳細 and the マイタスク発行 dialog
 * (③=②で統一). The old browser-default `<input type="file">` occupied a wide, ugly strip;
 * this replaces it with a 📎 button (the file picker is a hidden input the button opens)
 * plus an optional 🔗 URL row, and lists what's attached as small removable chips — no
 * area-hogging dropzone. Purely presentational: the host owns the model and the file/URL
 * validation of onPickFiles, while this component validates the URL scheme locally.
 */
export function AttachmentField({
  chips,
  canWrite,
  heading = "添付（ファイル・URL）",
  busy = false,
  error = null,
  loading = false,
  loadFailed = false,
  onPickFiles,
  onAddUrl,
  onRemove,
  testIdPrefix,
}: AttachmentFieldProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlName, setUrlName] = useState("");
  const [urlErr, setUrlErr] = useState<string | null>(null);

  const submitUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setUrlErr("URLは http:// または https:// で始めてください");
      return;
    }
    setUrlErr(null);
    onAddUrl(url, urlName.trim());
    setUrlInput("");
    setUrlName("");
    setUrlOpen(false);
  };

  const shownError = error ?? urlErr;

  return (
    <section className={styles.detailSection} data-testid={`${testIdPrefix}-section`}>
      <h4 className={styles.detailHeading}>{heading}</h4>

      {canWrite && (
        <div className={styles.attachAddArea}>
          <div className={styles.attachAddBar}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className={styles.attachHiddenInput}
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) onPickFiles(e.target.files);
                e.target.value = "";
              }}
              data-testid={`${testIdPrefix}-file`}
              aria-hidden
              tabIndex={-1}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              iconLeft={<span aria-hidden>📎</span>}
              testId={`${testIdPrefix}-file-btn`}
            >
              ファイルを添付
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setUrlErr(null);
                setUrlOpen((v) => !v);
              }}
              disabled={busy}
              iconLeft={<span aria-hidden>🔗</span>}
              testId={`${testIdPrefix}-url-toggle`}
            >
              URLを追加
            </Button>
          </div>

          {urlOpen && (
            <div className={styles.attachUrlRow}>
              <TextField
                id={`${testIdPrefix}-url-name`}
                value={urlName}
                onChange={setUrlName}
                placeholder="表示名（任意）"
                disabled={busy}
                testId={`${testIdPrefix}-url-name`}
              />
              <TextField
                id={`${testIdPrefix}-url`}
                value={urlInput}
                onChange={setUrlInput}
                placeholder="https://…"
                disabled={busy}
                testId={`${testIdPrefix}-url`}
              />
              <Button variant="ghost" size="sm" onClick={submitUrl} disabled={busy || !urlInput.trim()} testId={`${testIdPrefix}-url-add`}>
                追加
              </Button>
            </div>
          )}

          {shownError && (
            <p className={styles.attachError} data-testid={`${testIdPrefix}-error`}>
              {shownError}
            </p>
          )}
        </div>
      )}

      {loading ? (
        <SkeletonList rows={2} />
      ) : loadFailed ? (
        <p className={styles.detailEmpty}>添付を読み込めませんでした。</p>
      ) : chips.length > 0 ? (
        <ul className={styles.attachChipList} data-testid={`${testIdPrefix}-list`}>
          {chips.map((c) => (
            <li key={c.id} className={styles.attachChip} data-testid={`${testIdPrefix}-item`}>
              <span className={styles.attachChipIcon} aria-hidden>
                {c.kind === "file" ? "📎" : "🔗"}
              </span>
              {c.href ? (
                <a
                  href={c.href}
                  target="_blank"
                  rel="noreferrer"
                  {...(c.download ? { download: c.name } : {})}
                  className={styles.attachChipName}
                  title={c.name}
                  data-testid={`${testIdPrefix}-open-${c.kind}`}
                >
                  {c.name}
                </a>
              ) : (
                <span className={styles.attachChipName} title={c.name}>
                  {c.name}
                </span>
              )}
              {c.sizeBytes != null && <span className={styles.attachChipSize}>{humanFileSize(c.sizeBytes)}</span>}
              {canWrite && (
                <button
                  type="button"
                  className={styles.attachChipRemove}
                  onClick={() => onRemove(c.id)}
                  aria-label={`「${c.name}」を外す`}
                  data-testid={`${testIdPrefix}-remove`}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.detailEmpty} data-testid={`${testIdPrefix}-empty`}>
          添付はありません。
        </p>
      )}
    </section>
  );
}
