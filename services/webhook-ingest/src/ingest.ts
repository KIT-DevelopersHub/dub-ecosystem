// Ingest core: dedup -> (offload) -> publish -> ack. Pure of HTTP/verification concerns
// so it is unit-testable with fakes. Signature verification happens upstream (route).
import type { R2Bucket, Queue } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";
import { publishWebhookEvent } from "@dub/events";
import { newId, nowIso } from "@dub/db";
import type { webhook } from "@dub/types";
import { OFFLOAD_THRESHOLD_BYTES, QUEUE_NAME_BY_SOURCE, type WebhookEnvelope } from "./env";
import type { DeliveryRepo } from "./repo";

export interface IngestDeps {
  repo: DeliveryRepo;
  raw: R2Bucket;
  queues: Partial<Record<string, Queue<WebhookEnvelope>>>;
  now?: () => string; // injectable clock (default nowIso)
  mintId?: () => string; // injectable id mint (default newId("wh"))
}

export interface VerifiedRequest {
  source: webhook.WebhookSource;
  externalId: string;
  eventKind: string;
  rawBytes: Uint8Array;
  headers: Record<string, string>; // allow-listed only
  requestId: string;
}

/**
 * insert-or-ignore -> if new: (offload big body to R2) -> publish -> ack accepted.
 * Duplicate (unique conflict) returns accepted:false without republishing.
 * publish failure rolls the row (and R2 object) back and throws INTERNAL 500 so the
 * sender retries; at-least-once is covered by consumer idempotency on envelope id.
 */
export async function ingest(deps: IngestDeps, req: VerifiedRequest): Promise<webhook.WebhookIngestAck> {
  const now = deps.now ?? nowIso;
  const mint = deps.mintId ?? (() => newId("wh"));

  const id = mint();
  const bodySize = req.rawBytes.byteLength;
  const offload = bodySize > OFFLOAD_THRESHOLD_BYTES;
  const r2Key = offload ? `webhook-raw/${req.source}/${id}` : null;
  const queueName = QUEUE_NAME_BY_SOURCE[req.source];
  const receivedAt = now();

  const ins = await deps.repo.insertIfNew({
    id,
    source: req.source,
    externalId: req.externalId,
    eventKind: req.eventKind,
    status: "received",
    queue: queueName,
    r2Key,
    bodySize,
    receivedAt,
    processedAt: null,
    requestId: req.requestId,
  });

  if (!ins.inserted) {
    return { deliveryId: ins.existingId ?? id, accepted: false };
  }

  try {
    let payload: unknown = null;
    if (offload) {
      await deps.raw.put(r2Key!, req.rawBytes);
    } else if (req.rawBytes.byteLength > 0) {
      // signature already verified => trusted sender; malformed JSON surfaced as 400 upstream.
      // An empty body (e.g. google-drive `sync` handshake) stays payload=null.
      payload = JSON.parse(new TextDecoder().decode(req.rawBytes));
    }

    const envelope: WebhookEnvelope = {
      type: "webhook.received",
      version: 1,
      id,
      source: req.source,
      externalId: req.externalId,
      eventKind: req.eventKind,
      receivedAt,
      requestId: req.requestId,
      headers: req.headers,
      payload,
      r2Key,
    };

    await publishWebhookEvent(deps.queues, envelope);
    return { deliveryId: id, accepted: true };
  } catch (cause) {
    // compensate: remove the dedup row (and any R2 object) so a resend can succeed
    await deps.repo.deleteById(id).catch(() => {});
    if (r2Key) await deps.raw.delete(r2Key).catch(() => {});
    if (cause instanceof DubError) throw cause;
    throw new DubError("INTERNAL", "webhook publish failed", { status: 500, cause });
  }
}
