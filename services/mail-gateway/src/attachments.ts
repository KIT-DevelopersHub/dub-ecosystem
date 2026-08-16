// Attachment body store + persistence orchestration (attachments slice). Metadata lives
// in D1 (mail_attachments); the file BYTES live in R2 (bucket dub-mail-attachments). This
// module is the thin seam between the two: an R2-backed BlobStore, the deterministic key
// scheme, and the two persist helpers (outbound send / inbound receive) that write bytes
// then record metadata. Both persist paths are best-effort at the SEND/RECEIVE boundary:
// the email itself is already delivered/ingested, so a storage hiccup is logged, never
// turned into a 5xx (mirrors send.ts safePublish posture).
import { consoleSink } from "@dub/observability";
import type { mail } from "@dub/types";
import type { DbClient } from "@dub/db";
import type { RequestContext } from "@dub/http";
import { SERVICE_NAME } from "./config";
import { b64decodeToBytes } from "./mime";
import { insertAttachment, listAttachments, newAttachmentId, type AttachmentRow } from "./repo";

/** Minimal blob interface (R2 in prod, an in-memory fake in tests). */
export interface MailBlobStore {
  put(input: { key: string; body: Uint8Array | ArrayBuffer; contentType: string }): Promise<void>;
  get(key: string): Promise<{ body: ArrayBuffer; contentType: string; size: number } | null>;
  delete(key: string): Promise<void>;
}

export type AttachmentKind = "sent" | "inbound";

/** Decoded attachment ready to store (bytes + metadata). */
export interface AttachmentBytes {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Deterministic R2 key: org / kind / owning-message-id / attachment-id. */
export function attachmentR2Key(orgId: string, kind: AttachmentKind, messageId: string, attId: string): string {
  return `${orgId}/${kind}/${messageId}/${attId}`;
}

/** Wrap a Cloudflare R2 bucket as a MailBlobStore (same shape file-meta uses). */
export function r2Blobs(bucket: {
  put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}): MailBlobStore {
  return {
    async put({ key, body, contentType }) {
      const buf = body instanceof Uint8Array ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body;
      await bucket.put(key, buf as ArrayBuffer, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        body: await obj.arrayBuffer(),
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
        size: obj.size,
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

interface PersistDeps {
  db: DbClient;
  blobs: MailBlobStore;
  orgId: string;
  ctx: RequestContext;
}

/** Store a set of decoded attachments for one message (put bytes -> record metadata).
 *  Returns the persisted metadata. Best-effort: a per-file failure is logged and skipped
 *  so one bad blob never loses the others (nor the already-delivered/ingested email). */
export async function persistAttachments(
  deps: PersistDeps,
  kind: AttachmentKind,
  messageId: string,
  items: AttachmentBytes[],
): Promise<mail.MailAttachment[]> {
  const out: mail.MailAttachment[] = [];
  const now = new Date().toISOString();
  for (const item of items) {
    const id = newAttachmentId();
    const key = attachmentR2Key(deps.orgId, kind, messageId, id);
    try {
      await deps.blobs.put({ key, body: item.bytes, contentType: item.contentType });
      await insertAttachment(deps.db, {
        id,
        messageKind: kind,
        messageId,
        filename: item.filename,
        mimeType: item.contentType,
        sizeBytes: item.bytes.byteLength,
        r2Key: key,
        createdAt: now,
      });
      out.push({ id, filename: item.filename, contentType: item.contentType, sizeBytes: item.bytes.byteLength });
    } catch (err) {
      consoleSink({
        level: "error",
        message: "mail-gateway: failed to persist attachment",
        service: SERVICE_NAME,
        requestId: deps.ctx.requestId,
        fields: { kind, messageId, filename: item.filename, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return out;
}

/** Decode a SendMailRequest attachment (base64 body) into raw bytes for storage/provider. */
export function decodeInputAttachment(a: mail.MailAttachmentInput): AttachmentBytes {
  return { filename: a.filename, contentType: a.contentType, bytes: b64decodeToBytes(a.contentBase64) };
}

/** Metadata list for a message's detail view (empty array when none). */
export async function attachmentsFor(db: DbClient, kind: AttachmentKind, messageId: string): Promise<mail.MailAttachment[]> {
  const rows = await listAttachments(db, kind, messageId);
  return rows.map(rowToMeta);
}

export function rowToMeta(r: AttachmentRow): mail.MailAttachment {
  const meta: mail.MailAttachment = { id: r.id, filename: r.filename, contentType: r.mime_type, sizeBytes: r.size_bytes };
  // Only surface a status when the attachment is NOT the normal stored case, so a stored
  // attachment's DTO stays byte-identical to the pre-#2 shape (後方互換). A 'dropped_*'
  // status tells the UI to render a disabled chip + reason instead of a download link.
  if (r.status && r.status !== "stored") meta.status = r.status;
  return meta;
}

/** Record metadata-only STUB rows for attachments the gateway could not persist (too large
 *  for the ceiling, or the inbound MIME was truncated before their bytes arrived). No R2
 *  write — r2_key='' — so nothing is fetchable, but the file is VISIBLE in the message
 *  detail as a dropped attachment rather than silently missing (改善#2). Best-effort. */
export async function persistDroppedAttachments(
  deps: Pick<PersistDeps, "db" | "ctx">,
  kind: AttachmentKind,
  messageId: string,
  items: { filename: string; contentType: string; sizeBytes: number; reason: DroppedReason }[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const item of items) {
    try {
      await insertAttachment(deps.db, {
        id: newAttachmentId(),
        messageKind: kind,
        messageId,
        filename: item.filename,
        mimeType: item.contentType || "application/octet-stream",
        sizeBytes: item.sizeBytes,
        r2Key: "",
        createdAt: now,
        status: item.reason,
      });
    } catch (err) {
      consoleSink({
        level: "error",
        message: "mail-gateway: failed to record dropped attachment stub",
        service: SERVICE_NAME,
        requestId: deps.ctx.requestId,
        fields: { kind, messageId, filename: item.filename, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

export type DroppedReason = "dropped_too_large" | "dropped_truncated";
