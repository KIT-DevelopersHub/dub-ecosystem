// Worker environment bindings for deploy-service.
// Queue bindings follow the frozen catalog:
//  - EVT_NOTIFICATION : domain-event fan-out target for "deploy.*" (CONSUMER_QUEUE_BINDINGS)
//  - AUDIT_QUEUE      : result-stage audit channel (publishAudit)
//  - DEPLOY_JOBS      : this service's PRIVATE job queue (async deploy exec + poll), not a contract queue
import type { D1Database, Fetcher, Queue } from "@cloudflare/workers-types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";
import type { DeployJobMessage } from "./jobs";

export interface Env {
  // D1 (shared dub-core DB; deploy_* namespace only)
  DB: D1Database;

  // Service Bindings (Service Binding calls only; never public)
  SVC_IDENTITY: Fetcher; // identity-roster /authz/check
  SVC_AUDIT_LOG: Fetcher; // audit-log /internal/log (intent, sync fail-close)

  // Queues
  EVT_NOTIFICATION: Queue<DubEventEnvelope>;
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
  DEPLOY_JOBS: Queue<DeployJobMessage>;

  // Secrets (wrangler secret; local only). Minimal-scope split (design §5).
  CF_ACCOUNT_ID?: string;
  CF_DEPLOY_TOKEN_PAGES?: string; // Pages edit only
  CF_DEPLOY_TOKEN_DNS?: string; // DNS edit only
  CF_DEPLOY_TOKEN_READ?: string; // Zones/Registrar read only
  CF_API_BASE?: string; // default https://api.cloudflare.com/client/v4
}
