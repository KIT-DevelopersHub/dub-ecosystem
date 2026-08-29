import { useEffect, useState } from "react";
import type { common, task } from "@dub/types";
import { useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTaskAttachments, createTaskAttachment, deleteTaskAttachment } from "../api/endpoints";
import { MAX_ATTACHMENT_BYTES, readFileAsDataUrl } from "../domain/attachments";
import { AttachmentField, type AttachmentChip } from "./AttachmentField";

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const addFiles = async (list: FileList) => {
    if (list.length === 0) return;
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
    }
  };

  const addUrl = async (url: string, name: string) => {
    setError(null);
    setBusy(true);
    const display = name || url;
    try {
      const saved = await createTaskAttachment(client, taskId, { kind: "url", name: display, url });
      setItems((prev) => [saved, ...(prev ?? [])]);
      toast.show({ kind: "success", title: "URLを添付しました" });
    } catch {
      toast.show({ kind: "error", title: "URLを添付できませんでした", description: display });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    // Optimistic: drop it now, restore on failure.
    const snapshot = items ?? [];
    const att = snapshot.find((a) => a.id === id);
    if (!att) return;
    setItems(snapshot.filter((a) => a.id !== id));
    try {
      await deleteTaskAttachment(client, taskId, att.id);
      toast.show({ kind: "success", title: `「${att.name}」を削除しました` });
    } catch {
      setItems(snapshot);
      toast.show({ kind: "error", title: "削除できませんでした", description: att.name });
    }
  };

  const chips: AttachmentChip[] = (items ?? []).map((a) => ({
    id: a.id,
    kind: a.kind,
    name: a.name,
    href: a.url,
    download: a.kind === "file",
    sizeBytes: a.sizeBytes,
  }));

  return (
    <AttachmentField
      chips={chips}
      canWrite={canWrite}
      busy={busy}
      error={error}
      loading={items === null && !loadFailed}
      loadFailed={loadFailed}
      onPickFiles={(list) => void addFiles(list)}
      onAddUrl={(url, name) => void addUrl(url, name)}
      onRemove={(id) => void remove(id)}
      testIdPrefix="fe4-detail-attach"
    />
  );
}
