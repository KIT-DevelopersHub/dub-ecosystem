// Cloudflare Worker bindings. SVC_* Service Bindings are optional in P0 (the
// integration wave 9-B/C/E wires audit-log + auth-service); when absent the
// Worker builds degraded sinks (see sinks.ts) so unit deploys still boot.
import type { D1Database, Queue, Fetcher } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";

export interface Env {
  DB: D1Database;
  // Best-effort audit producer. On the Workers PAID plan this binding is present and the
  // real Queue is used unchanged. On the FREE plan it is absent and sinks.ts falls back
  // to the @dub/freeq D1 outbox shim (outbox.ts) writing to OUTBOX_DB — so the record is
  // durably persisted, never dropped.
  AUDIT_QUEUE?: Queue<AuditRecordEnvelopeV1>;
  // @dub/freeq audit outbox DB (free-tier replacement for the AUDIT_QUEUE producer).
  // The shared dub-core D1 (same physical DB as `DB`, bound separately as infra plumbing
  // for the un-namespaced freeq_outbox table). Absent on the paid deploy.
  OUTBOX_DB?: D1Database;
  SVC_AUDIT_LOG?: Fetcher; // audit-log sync POST /internal/log
  SVC_AUDIT?: Fetcher; // audit-log async ingest (free-tier outbox drain delivery target)
  SVC_AUTH?: Fetcher; // auth-service POST /internal/revoke-user
  DUB_DEFAULT_ORG_ID?: string;
}

export type AppVariables = {
  requestId: string;
  userId: string | null;
};
