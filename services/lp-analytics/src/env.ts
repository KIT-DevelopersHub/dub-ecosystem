// Worker bindings for lp-analytics: the shared dub-core D1 (lp_* namespace) + identity-roster
// for the LP管理 policy gate + lp-tickets (公開設定の販売状態). No queues / events.
import type { D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  SVC_IDENTITY: Fetcher;
  /** lp-tickets: 公開設定の release のうちチケット販売の 2 項目の正本。 */
  SVC_LP_TICKETS: Fetcher;
  DUB_DEFAULT_ORG_ID?: string;
  /** 公開 LP の URL（流入URL の組み立て元）。未設定なら本番 LP。 */
  LP_BASE_URL?: string;
  /** 1 日に記録する訪問の上限（既定 5000）。 */
  LP_DAILY_VISIT_CAP?: string;
  /** 1 日に受け付けるアクセス解析ビーコンの上限（既定 3000）。 */
  LP_DAILY_INSIGHT_CAP?: string;
  /** Cloudflare Web Analytics (サイト全体のアクセス). 3 つ揃わなければ画面は「未設定」表示。 */
  CF_ACCOUNT_ID?: string;
  LP_WEB_ANALYTICS_SITE_TAG?: string;
  /** secret: Account Analytics:Read の API トークン。 */
  CF_ANALYTICS_TOKEN?: string;
  /** 1 日 (JST) に受け付ける登壇応募の上限（既定 200）。 */
  LP_DAILY_PROPOSAL_CAP?: string;
  /** スポンサー募集の通知: Dub 通知（notification-service POST /notify・app:sponsor:edit を持つ人へ）。無ければ送らない。 */
  SVC_NOTIFICATION?: Fetcher;
  /** スポンサー募集の通知メール・受付メール（mail-gateway POST /send）。無ければメールは送らない。 */
  SVC_MAIL?: Fetcher;
  /** LP管理で通知メールを設定していないときのスポンサーチームのアドレス。 */
  LP_SPONSOR_NOTIFY_EMAIL?: string;
  /** 1 日 (JST) に受け付ける資料請求の上限（既定 100）。 */
  LP_DAILY_SPONSOR_CAP?: string;
}
