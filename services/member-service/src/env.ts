// Worker bindings for member-service. Minimal: the shared dub-core D1 (member_*
// namespace) + identity-roster for authz. No queues / events (self-contained domain).
import type { D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database; // shared dub-core D1 (member_* namespace)
  SVC_IDENTITY: Fetcher; // identity-roster (authz: /authz/check)
  // notification-service (POST /notify) — 参加届が届いたら管理者へ in-app 通知を1件出す。
  // Optional: absent (unit tests / a stripped deploy) simply skips the notify (best-effort).
  SVC_NOTIFICATION?: Fetcher;
  DUB_DEFAULT_ORG_ID?: string;
}
