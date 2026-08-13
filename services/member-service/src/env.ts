// Worker bindings for member-service. Minimal: the shared dub-core D1 (member_*
// namespace) + identity-roster for authz. No queues / events (self-contained domain).
import type { D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database; // shared dub-core D1 (member_* namespace)
  SVC_IDENTITY: Fetcher; // identity-roster (authz: /authz/check)
  DUB_DEFAULT_ORG_ID?: string;
}
