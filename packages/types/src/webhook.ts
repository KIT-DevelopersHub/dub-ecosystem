// webhook — webhook-ingest namespace. Owns WebhookEventEnvelopeV1 (events re-exports).
import type { ISODateTime, Paginated, CursorQuery } from "./common";

export type WebhookSource = "github" | "google-drive" | "gmail" | "stripe";

export interface WebhookIngestAck {
  deliveryId: string; // = webhook_deliveries.id (ULID), idempotency key
  accepted: boolean;
}

// Single envelope, discriminated by `source`/`eventKind` (named normalized events retired).
export interface WebhookEventEnvelopeV1 {
  type: "webhook.received";
  version: 1;
  id: string; // webhook_deliveries.id (ULID) = idempotency key
  source: WebhookSource;
  externalId: string;
  eventKind: string;
  receivedAt: ISODateTime;
  requestId: string;
  headers: Record<string, string>;
  payload: unknown | null; // >96KB: payload=null + r2Key set
  r2Key: string | null;
}

export type WebhookDeliveryStatus = "received" | "processed" | "failed";

export interface WebhookDelivery {
  id: string;
  source: WebhookSource;
  eventKind: string;
  status: WebhookDeliveryStatus;
  receivedAt: ISODateTime;
  processedAt: ISODateTime | null;
}
export interface WebhookDeliveryQuery extends CursorQuery {
  source?: WebhookSource;
  status?: WebhookDeliveryStatus;
}
export type WebhookDeliveryPage = Paginated<WebhookDelivery>;
