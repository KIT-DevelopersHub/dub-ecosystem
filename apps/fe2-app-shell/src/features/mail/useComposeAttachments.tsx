// Compose-attachment state hook shared by ComposeWindow (floating) and ComposeScreen
// (legacy). Owns the picked-file list, per-file read progress, image thumbnails (object
// URLs, revoked on remove/unmount) and the rejection errors, so both compose surfaces get
// identical Gmail-parity behaviour from one place. `addFiles` runs the shared validation
// (attach.ts), then reads each accepted file to base64 with progress; `readyInputs` is what
// rides the SendMailRequest once reads complete.
import { useCallback, useEffect, useRef, useState } from "react";
import type { mail } from "@dub/types";
import { fileToAttachmentWithProgress, isImageType, validateIncomingFiles, type AttachReject } from "./attach.ts";

export interface ComposeAttachmentItem {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isImage: boolean;
  /** The picked File itself, kept so the attachment can be PREVIEWED in-place before send
   *  (image/pdf via an object URL, text via FileReader) with no server round-trip. */
  file: File;
  /** Object URL for the inline image thumbnail (images only; revoked on remove/unmount). */
  previewUrl?: string;
  /** reading = bytes are being read to base64; ready = input filled; error = read failed. */
  status: "reading" | "ready" | "error";
  progress: number; // 0..1 while reading
  input?: mail.MailAttachmentInput; // present once status === "ready"
}

let seq = 0;
const nextId = (): string => `att_local_${Date.now().toString(36)}_${seq++}`;

/** Best-effort object URL for an image preview (guarded: jsdom lacks createObjectURL). */
function makePreviewUrl(file: File, isImage: boolean): string | undefined {
  if (!isImage || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

function revokePreview(url: string | undefined): void {
  if (url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already revoked */
    }
  }
}

export interface UseComposeAttachments {
  items: ComposeAttachmentItem[];
  errors: string[];
  /** Validate + ingest a set of picked/dropped files. Rejections populate `errors`. */
  addFiles: (files: FileList | File[] | null) => void;
  remove: (id: string) => void;
  clear: () => void;
  dismissErrors: () => void;
  /** The gateway inputs for every fully-read attachment (skips still-reading / errored). */
  readyInputs: () => mail.MailAttachmentInput[];
  /** True while any attachment is still being read (send should wait for these). */
  hasPending: boolean;
}

export function useComposeAttachments(): UseComposeAttachments {
  const [items, setItems] = useState<ComposeAttachmentItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  // A ref mirror of `items` so addFiles validates against the current list without being
  // re-created on every change (stable callback), and so unmount cleanup revokes URLs.
  const itemsRef = useRef<ComposeAttachmentItem[]>(items);
  itemsRef.current = items;

  useEffect(() => {
    return () => {
      for (const it of itemsRef.current) revokePreview(it.previewUrl);
    };
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<ComposeAttachmentItem>): void => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[] | null): void => {
      if (!files) return;
      const incoming = Array.from(files);
      if (incoming.length === 0) return;
      const { accepted, rejected } = validateIncomingFiles(itemsRef.current, incoming);
      if (rejected.length > 0) {
        setErrors((prev) => [...prev, ...rejected.map((r: AttachReject) => `${r.filename}: ${r.reason}`)]);
      }
      for (const file of accepted) {
        const id = nextId();
        const isImage = isImageType(file.type || "");
        const item: ComposeAttachmentItem = {
          id,
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          isImage,
          file,
          status: "reading",
          progress: 0,
        };
        const previewUrl = makePreviewUrl(file, isImage);
        if (previewUrl) item.previewUrl = previewUrl;
        setItems((prev) => [...prev, item]);
        void fileToAttachmentWithProgress(file, (p) => patchItem(id, { progress: p }))
          .then((input) => patchItem(id, { status: "ready", progress: 1, input }))
          .catch(() => patchItem(id, { status: "error" }));
      }
    },
    [patchItem],
  );

  const remove = useCallback((id: string): void => {
    setItems((prev) => {
      const target = prev.find((it) => it.id === id);
      revokePreview(target?.previewUrl);
      return prev.filter((it) => it.id !== id);
    });
  }, []);

  const clear = useCallback((): void => {
    setItems((prev) => {
      for (const it of prev) revokePreview(it.previewUrl);
      return [];
    });
    setErrors([]);
  }, []);

  const dismissErrors = useCallback((): void => setErrors([]), []);

  const readyInputs = useCallback(
    (): mail.MailAttachmentInput[] => items.filter((it) => it.status === "ready" && it.input).map((it) => it.input!),
    [items],
  );

  return {
    items,
    errors,
    addFiles,
    remove,
    clear,
    dismissErrors,
    readyInputs,
    hasPending: items.some((it) => it.status === "reading"),
  };
}
