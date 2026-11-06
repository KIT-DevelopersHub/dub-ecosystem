// Worker bindings for member-service. Minimal: the shared dub-core D1 (member_*
// namespace) + identity-roster for authz. No queues / events (self-contained domain).
import type { D1Database, Fetcher, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database; // shared dub-core D1 (member_* namespace)
  SVC_IDENTITY: Fetcher; // identity-roster (authz: /authz/check)
  // notification-service (POST /notify) — 参加届が届いたら管理者へ in-app 通知を1件出す。
  // Optional: absent (unit tests / a stripped deploy) simply skips the notify (best-effort).
  SVC_NOTIFICATION?: Fetcher;
  // 目標管理の実績 (チームのタスク件数 / LP の訪問者数)。Optional: 無ければその KPI は「集計できません」。
  SVC_TASK?: Fetcher;
  SVC_LP_ANALYTICS?: Fetcher;
  // R2 dub-file-attachments (sponsor/cards/<id> = 名刺写真)。Optional: 無ければ写真ルートだけ 503。
  SPONSOR_FILES?: R2Bucket;
  DUB_DEFAULT_ORG_ID?: string;
}
