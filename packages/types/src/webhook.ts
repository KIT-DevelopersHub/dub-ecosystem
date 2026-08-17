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

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* webhook-ingest's admin read
// endpoint puts on the wire. The server (webhook-ingest app.ts) and the OpenAPI spec
// (docs/openapi/webhook-ingest.yaml) are reconciled against this map in CI (see
// @dub/e2e-smoke wire-params.test.ts). Renaming a key here is the only legitimate way to
// change a wire param. See docs/api-contracts/_wire-contract-enforcement.md.
export const WEBHOOK_WIRE = {
  listDeliveries: {
    method: "GET",
    path: "/webhooks/deliveries",
    query: ["cursor", "limit", "source", "status"],
  },
} as const;

// Compile-time tie: every query key the descriptor lists must be a real key of the
// typed query interface, so the descriptor and the type can never silently drift.
type _WebhookWireKeysAreTyped =
  (typeof WEBHOOK_WIRE)[keyof typeof WEBHOOK_WIRE]["query"][number] extends keyof WebhookDeliveryQuery
    ? true
    : never;
const _webhookWireKeyGuard: _WebhookWireKeysAreTyped = true;
void _webhookWireKeyGuard;
