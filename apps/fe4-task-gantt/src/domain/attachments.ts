// Shared helpers for task attachments (file + URL). File BODIES follow the same
// storage path the マイタスク発行 flow already ships: the bytes are read into a
// self-contained `data:` URL and persisted in the attachment row's `url` column
// (task-service D1). This is $0 (no extra infra) and consistent with the existing
// attachment feature. A file-meta/R2 blob upload (services/file-meta POST /files →
// dub-file-attachments bucket, already built) is the documented follow-up for large
// files once the shared ApiClient gains a multipart `upload` method — the metadata
// contract here (kind/fileId/url/mimeType/sizeBytes) already accommodates it.
import type { task } from "@dub/types";

/** Per-file cap for the data-URL storage path (keeps D1 rows small). */
export const MAX_ATTACHMENT_BYTES = 1 * 1024 * 1024;

/** Read a File's bytes into a self-contained `data:` URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Human-readable byte size (null → empty). */
export function humanFileSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageAttachment(a: task.TaskAttachment): boolean {
  return (a.mimeType ?? "").startsWith("image/");
}
