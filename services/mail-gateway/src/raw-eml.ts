// Raw .eml archive (データ保全 Phase 1). Every newly ingested inbound message keeps its
// full, untruncated RFC822 bytes in R2 so a parser bug or a data-loss incident can be
// repaired by re-parsing the original. Best-effort by contract: a failed put/record is
// logged and ingest continues — losing the archive copy must never lose the mail itself.
import { consoleSink } from "@dub/observability";
import type { DbClient } from "@dub/db";
import type { RequestContext } from "@dub/http";
import { SERVICE_NAME } from "./config";
import type { MailBlobStore } from "./attachments";
import { setInboundRawKey } from "./repo";

/** `raw/<yyyy>/<mm>/<inbound row id>.eml` (UTC ingest month). */
export function rawEmlKey(inboundId: string, at: Date = new Date()): string {
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `raw/${yyyy}/${mm}/${inboundId}.eml`;
}

/** Store the raw bytes and record the key on the mail_inbound row. Never throws. */
export async function archiveRawEml(
  deps: { db: DbClient; blobs: MailBlobStore; ctx: RequestContext },
  inboundId: string,
  bytes: Uint8Array,
  at: Date = new Date(),
): Promise<string | null> {
  const key = rawEmlKey(inboundId, at);
  try {
    await deps.blobs.put({ key, body: bytes, contentType: "message/rfc822" });
    await setInboundRawKey(deps.db, inboundId, key);
    return key;
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-gateway: raw .eml archive failed (ingest continues)",
      service: SERVICE_NAME,
      requestId: deps.ctx.requestId,
      fields: { inboundId, key, sizeBytes: bytes.byteLength, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
