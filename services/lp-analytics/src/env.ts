// Worker bindings for lp-analytics: the shared dub-core D1 (lp_* namespace) + identity-roster
// for the LP管理 policy gate. No queues / events.
import type { D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  SVC_IDENTITY: Fetcher;
  DUB_DEFAULT_ORG_ID?: string;
  /** 公開 LP の URL（流入URL の組み立て元）。未設定なら本番 LP。 */
  LP_BASE_URL?: string;
  /** 1 日に記録する訪問の上限（既定 5000）。 */
  LP_DAILY_VISIT_CAP?: string;
}
