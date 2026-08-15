// Attachment compose logic (Gmail-parity slice). PURE, unit-tested helpers shared by the
// floating ComposeWindow and the legacy ComposeScreen so both enforce the SAME rules:
//   • forbidden executable types are refused with a reason (Gmail blocks .exe/.js/… — a
//     hard security block, never silently swallowed);
//   • per-file (20MB), per-message total (25MB) and count (10) ceilings mirror the gateway,
//     each surfaced as an explicit error instead of the old silent drop/slice;
//   • files are read to base64 WITH progress (FileReader) so the UI shows an upload bar.
// The gateway re-validates every rule server-side (validation.ts); this is UX, not trust.
import type { mail } from "@dub/types";
import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_BYTES, bufferToBase64, formatBytes } from "./mailApi.tsx";

// Executable / script types Gmail refuses (support.google.com "file types blocked"). Kept
// lower-case, leading-dot-free. Blocking is by final extension only — enough for the common
// case; the gateway is the real trust boundary.
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com", "cpl",
  "dll", "dmg", "ex", "ex_", "exe", "hta", "img", "ins", "iso", "isp", "jar", "js", "jse",
  "lib", "lnk", "mde", "msc", "msi", "msix", "msixbundle", "msp", "mst", "nsh", "pif",
  "ps1", "reg", "scr", "sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc",
  "wsf", "wsh", "xll",
]);

/** Final lower-case extension of a filename (no dot). "" when the name has none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** True when the file's extension is on the executable/script blocklist (Gmail parity). */
export function isBlockedFilename(filename: string): boolean {
  return BLOCKED_EXTENSIONS.has(fileExtension(filename));
}

/** True for image MIME types — those get an inline thumbnail rather than a generic icon. */
export function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** A picked file the compose rules refused, with a human reason for the error banner. */
export interface AttachReject {
  filename: string;
  reason: string;
}
/** Split incoming files into the ones the compose rules accept vs. reject (with reasons).
 *  `existing` is what is already attached (for the count / running-total ceilings). Pure. */
export interface ValidateResult {
  accepted: File[];
  rejected: AttachReject[];
}
export function validateIncomingFiles(existing: { sizeBytes: number }[], incoming: File[]): ValidateResult {
  const accepted: File[] = [];
  const rejected: AttachReject[] = [];
  let count = existing.length;
  let total = existing.reduce((n, a) => n + a.sizeBytes, 0);
  for (const f of incoming) {
    const ext = fileExtension(f.name);
    if (isBlockedFilename(f.name)) {
      rejected.push({ filename: f.name, reason: `セキュリティ上の理由でこの形式（.${ext}）は添付できません` });
      continue;
    }
    if (f.size === 0) {
      rejected.push({ filename: f.name, reason: "空のファイルは添付できません" });
      continue;
    }
    if (f.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ filename: f.name, reason: `ファイルが大きすぎます（1件 ${formatBytes(MAX_ATTACHMENT_BYTES)} まで）` });
      continue;
    }
    if (count >= MAX_ATTACHMENTS) {
      rejected.push({ filename: f.name, reason: `添付は最大 ${MAX_ATTACHMENTS} 件までです` });
      continue;
    }
    if (total + f.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
      rejected.push({ filename: f.name, reason: `合計サイズが上限（${formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)}）を超えます` });
      continue;
    }
    accepted.push(f);
    count += 1;
    total += f.size;
  }
  return { accepted, rejected };
}

/** Read a File to an ArrayBuffer, reporting 0..1 progress. Uses FileReader (which emits
 *  progress events) in the browser; falls back to File.arrayBuffer() for the test File-likes
 *  that lack a real FileReader pipe. */
export function readFileWithProgress(file: File, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
  const hasFileReader = typeof FileReader !== "undefined";
  const hasReaderInput = typeof (file as unknown as { slice?: unknown }).slice === "function";
  if (!hasFileReader || !hasReaderInput) {
    return file.arrayBuffer().then((buf) => {
      onProgress?.(1);
      return buf;
    });
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e: ProgressEvent<FileReader>) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    reader.onload = () => {
      onProgress?.(1);
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => reject(reader.error ?? new Error("ファイルの読み込みに失敗しました"));
    reader.readAsArrayBuffer(file);
  });
}

/** Read a File into the gateway's MailAttachmentInput (base64 body) with read progress. */
export async function fileToAttachmentWithProgress(file: File, onProgress?: (p: number) => void): Promise<mail.MailAttachmentInput> {
  const buf = await readFileWithProgress(file, onProgress);
  return {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    contentBase64: bufferToBase64(buf),
  };
}
