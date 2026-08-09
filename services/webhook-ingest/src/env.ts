// Worker environment bindings + tuning constants for webhook-ingest (#13).
import type { D1Database, R2Bucket, Queue, Fetcher } from "@cloudflare/workers-types";
import type { webhook } from "@dub/types";

export type WebhookEnvelope = webhook.WebhookEventEnvelopeV1;

export interface Env {
  // storage
  DUB_DB: D1Database; // single shared dub-core DB (webhook_* namespace only)
  WEBHOOK_RAW: R2Bucket; // dub-r2-webhook-raw (RW)

  // per-source producer queues (only WH_GITHUB is required in P0)
  WH_GITHUB: Queue<WebhookEnvelope>;
  WH_GOOGLE_DRIVE?: Queue<WebhookEnvelope>;
  WH_GMAIL?: Queue<WebhookEnvelope>;
  WH_STRIPE?: Queue<WebhookEnvelope>;

  // service bindings
  SVC_IDENTITY: Fetcher; // identity-roster (authz /authz/check)

  // secrets — new + next for rotation (infra common convention)
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET_NEXT?: string;
  DRIVE_WEBHOOK_TOKEN?: string;
  DRIVE_WEBHOOK_TOKEN_NEXT?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET_NEXT?: string;
  GMAIL_WEBHOOK_AUDIENCE?: string;
  // Pub/Sub push service-account identity (the OIDC token's `email` claim). Pub/Sub push
  // aud is attacker-controllable, so the SA identity must be pinned in addition to aud.
  GMAIL_PUSH_SA_EMAIL?: string;

  // vars
  RETENTION_DAYS?: string;
}

// Body offload / limits.
export const OFFLOAD_THRESHOLD_BYTES = 96 * 1024; // >96KB -> R2 (128KB Queue limit headroom)
export const MAX_BODY_BYTES = 1024 * 1024; // >1MB -> 413
export const DEFAULT_RETENTION_DAYS = 30;
export const STRIPE_TOLERANCE_SEC = 300;

// Per-source Queue physical name (mirrors @dub/events WEBHOOK_QUEUE_BY_SOURCE bindings).
export const QUEUE_NAME_BY_SOURCE: Record<webhook.WebhookSource, string> = {
  github: "dub-q-wh-github",
  "google-drive": "dub-q-wh-google-drive",
  gmail: "dub-q-wh-gmail",
  stripe: "dub-q-wh-stripe",
};

// Enabled ingress sources. github/google-drive/stripe accept live traffic; gmail stays
// gated (its verifier is implemented but the endpoint is not yet activated — see 9-B).
export const ENABLED_SOURCES: ReadonlySet<webhook.WebhookSource> = new Set([
  "github",
  "google-drive",
  "stripe",
]);

export const KNOWN_SOURCES: ReadonlySet<string> = new Set<webhook.WebhookSource>([
  "github",
  "google-drive",
  "gmail",
  "stripe",
]);

export function isWebhookSource(v: string): v is webhook.WebhookSource {
  return KNOWN_SOURCES.has(v);
}
