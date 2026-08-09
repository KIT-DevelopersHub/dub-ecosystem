// Cloudflare Worker bindings. SVC_* Service Bindings are optional in P0 (the
// integration wave 9-B/C/E wires audit-log + auth-service); when absent the
// Worker builds degraded sinks (see sinks.ts) so unit deploys still boot.
import type { D1Database, Queue, Fetcher } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";

export interface Env {
  DB: D1Database;
  AUDIT_QUEUE?: Queue<AuditRecordEnvelopeV1>;
  SVC_AUDIT_LOG?: Fetcher; // audit-log sync POST /internal/log
  SVC_AUTH?: Fetcher; // auth-service POST /internal/revoke-user
  DUB_DEFAULT_ORG_ID?: string;
}

export type AppVariables = {
  requestId: string;
  userId: string | null;
};
