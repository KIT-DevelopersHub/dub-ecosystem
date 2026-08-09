// Worker environment bindings (mirror of wrangler.toml).
import type { D1Database, Queue, R2Bucket, Fetcher } from "@cloudflare/workers-types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1, WebhookEventEnvelopeV1 } from "@dub/events";

export interface Env {
  // D1 (github_* namespace of shared dub-core)
  DB: D1Database;
  // R2 read fallback for >96KB webhook payloads
  WEBHOOK_RAW: R2Bucket;
  // Queue producers
  EVT_NOTIFICATION: Queue<DubEventEnvelope>;
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
  // Service bindings
  SVC_TASK: Fetcher;
  SVC_IDENTITY: Fetcher;
  SVC_EVENT: Fetcher;
  // Vars / secrets
  GITHUB_ORIGIN_DEFAULT?: string;
  GITHUB_SELF_LOGINS?: string; // comma-separated bot logins for echo suppression
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
}

// Inbound queue names (dispatched by MessageBatch.queue).
export const WH_GITHUB_QUEUE = "dub-q-wh-github";
export const EVT_GITHUB_SYNC_QUEUE = "dub-q-evt-github-sync";

export type InboundMessage = WebhookEventEnvelopeV1 | DubEventEnvelope;
