// Worker bindings for event-service. Extracted from index.ts so the Cron drain
// (drain.ts) can share the Env type without an index <-> drain runtime cycle.
//
// FREE-TIER shape: the event.*/action.* fan-out queues (EVT_*) and the audit
// channel (AUDIT_QUEUE) are PAID Cloudflare Queues and are therefore OPTIONAL. On a
// free-plan deploy they are absent and the publishers fall back to a @dub/freeq D1
// outbox (freeq_outbox on the shared dub-core DB); a Cron-triggered drain forwards
// audit rows to audit-log and defers domain events (kept durable/pending). When the
// real Queue bindings ARE present (paid deploy, wrangler.toml) they are used unchanged.
import type { D1Database, Fetcher, Queue } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database; // shared dub-core D1 (event_* namespace + un-namespaced freeq_outbox)
  SVC_IDENTITY: Fetcher; // identity-roster (authz)
  SVC_TASK?: Fetcher; // task-service (read-only participant synthesis)
  SVC_AUDIT?: Fetcher; // audit-log (free-tier outbox drain delivery target); absent => drain defers audit

  // event fan-out queues (PAID plan only; absent => @dub/freeq outbox fallback).
  // Only the ones event.* / action.* target need to exist.
  EVT_NOTIFICATION?: Queue;
  EVT_TASK?: Queue;
  EVT_GANTT?: Queue;
  EVT_FILE_META?: Queue;
  EVT_GITHUB_SYNC?: Queue;
  EVT_MOBILE_BFF?: Queue;
  AUDIT_QUEUE?: Queue; // audit channel (PAID plan only; absent => outbox fallback)

  DUB_DEFAULT_ORG_ID?: string;
}
