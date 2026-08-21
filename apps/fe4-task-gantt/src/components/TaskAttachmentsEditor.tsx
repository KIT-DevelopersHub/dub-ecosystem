import { useEffect, useRef, useState } from "react";
import type { common, task } from "@dub/types";
import { Button, TextField, IconButton, SkeletonList, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTaskAttachments, createTaskAttachment, deleteTaskAttachment } from "../api/endpoints";
import { MAX_ATTACHMENT_BYTES, humanFileSize, isImageAttachment, readFileAsDataUrl } from "../domain/attachments";
import styles from "../styles/app.module.css";

export interface TaskAttachmentsEditorProps {
  taskId: common.TaskId;
  /** gate the add/delete controls behind task:write. read stays available. */
  canWrite: boolean;
}

/**
 * Manage a task's attachments inside the detail dialog: upload files (stored as a
 * self-contained data URL — the same $0 path マイタスク発行 already ships), add
 * external URLs, list them (download / open), and delete. Every mutation is
 * optimistic (the list updates the same tick) with a toast and rollback on failure,
 * per the optimistic-UI principle.
 */
export function TaskAttachmentsEditor({ taskId, canWrite }: TaskAttachmentsEditorProps) {
  const client = useApiClient();
  const toast = useToast();
  const [items, setItems] = useState<task.TaskAttachment[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlName, setUrlName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setItems(null);
    setLoadFailed(false);
    listTaskAttachments(client, taskId)
      .then((res) => {
        if (live) setItems(res.items);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [client, taskId]);

  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setError(`「${file.name}」は1MBを超えています（添付できるのは1MBまで）`);
          continue;
        }
        const dataUrl = await readFileAsDataUrl(file);
        try {
          const saved = await createTaskAttachment(client, taskId, {
            kind: "file",
            name: file.name,
            url: dataUrl,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          });
          setItems((prev) => [saved, ...(prev ?? [])]);
          toast.show({ kind: "success", title: `「${file.name}」を添付しました` });
        } catch {
          toast.show({ kind: "error", title: "ファイルを添付できませんでした", description: file.name });
        }
      }
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addUrl = async () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setError("URLは http:// または https:// で始めてください");
      return;
    }
    setError(null);
    setBusy(true);
    const name = urlName.trim() || url;
    try {
      const saved = await createTaskAttachment(client, taskId, { kind: "url", name, url });
      setItems((prev) => [saved, ...(prev ?? [])]);
      setUrlInput("");
      setUrlName("");
      toast.show({ kind: "success", title: "URLを添付しました" });
    } catch {
      toast.show({ kind: "error", title: "URLを添付できませんでした", description: name });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (att: task.TaskAttachment) => {
    // Optimistic: drop it now, restore on failure.
    const snapshot = items ?? [];
    setItems(snapshot.filter((a) => a.id !== att.id));
    try {
      await deleteTaskAttachment(client, taskId, att.id);
      toast.show({ kind: "success", title: `「${att.name}」を削除しました` });
    } catch {
      setItems(snapshot);
      toast.show({ kind: "error", title: "削除できませんでした", description: att.name });
    }
  };

  return (
    <section className={styles.detailSection} data-testid="fe4-detail-attachments">
      <h3 className={styles.detailHeading}>添付（ファイル・URL）</h3>

      {canWrite && (
        <div className={styles.attachEditControls}>
          <div className={styles.attachRow}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className={styles.attachFileInput}
              disabled={busy}
              onChange={(e) => void addFiles(e.target.files)}
              data-testid="fe4-detail-attach-file"
            />
          </div>
          <div className={styles.attachUrlRow}>
            <TextField
              id="fe4-detail-attach-url-name"
              value={urlName}
              onChange={setUrlName}
              placeholder="表示名（任意）"
              disabled={busy}
              testId="fe4-detail-attach-url-name"
            />
            <TextField
              id="fe4-detail-attach-url"
              value={urlInput}
              onChange={setUrlInput}
              placeholder="https://…"
              disabled={busy}
              testId="fe4-detail-attach-url"
            />
            <Button variant="ghost" onClick={() => void addUrl()} disabled={busy || !urlInput.trim()} testId="fe4-detail-attach-url-add">
              URL追加
            </Button>
          </div>
          {error && (
            <p className={styles.attachError} data-testid="fe4-detail-attach-error">
              {error}
            </p>
          )}
        </div>
      )}

      {items === null && !loadFailed ? (
        <SkeletonList rows={2} />
      ) : loadFailed ? (
        <p className={styles.detailEmpty}>添付を読み込めませんでした。</p>
      ) : items && items.length > 0 ? (
        <ul className={styles.attachViewList}>
          {items.map((a) => {
            const isImage = a.kind === "file" && isImageAttachment(a);
            return (
              <li key={a.id} className={styles.attachEditItem} data-testid="fe4-detail-attach-item">
                {isImage ? (
                  <a href={a.url} target="_blank" rel="noreferrer" title={a.name} className={styles.attachViewImageLink}>
                    <img src={a.url} alt={a.name} className={styles.attachViewImage} />
                  </a>
                ) : (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    {...(a.kind === "file" ? { download: a.name } : {})}
                    className={styles.attachViewLink}
                    data-testid={`fe4-detail-attach-open-${a.kind}`}
                  >
                    <span aria-hidden>{a.kind === "file" ? "📎" : "🔗"}</span>
                    <span className={styles.attachViewName}>{a.name}</span>
                    {a.sizeBytes !== null && <span className={styles.attachViewSize}>{humanFileSize(a.sizeBytes)}</span>}
                  </a>
                )}
                {canWrite && (
                  <IconButton
                    name="trash"
                    aria-label={`「${a.name}」を削除`}
                    variant="ghost"
                    onClick={() => void remove(a)}
                    testId="fe4-detail-attach-remove"
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.detailEmpty} data-testid="fe4-detail-attachments-empty">
          添付はありません。
        </p>
      )}
    </section>
  );
}
