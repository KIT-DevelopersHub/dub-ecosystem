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
  /** Cloudflare Web Analytics (サイト全体のアクセス). 3 つ揃わなければ画面は「未設定」表示。 */
  CF_ACCOUNT_ID?: string;
  LP_WEB_ANALYTICS_SITE_TAG?: string;
  /** secret: Account Analytics:Read の API トークン。 */
  CF_ANALYTICS_TOKEN?: string;
  /** secret: Stripe API キー。未設定なら決済準備中（有料券は 503・無料券は動く）。 */
  STRIPE_SECRET_KEY?: string;
  /** "1" の時だけ本番キー (sk_live_) を使う。それ以外で本番キーなら決済準備中扱い。 */
  STRIPE_ALLOW_LIVE?: string;
  /** secret: Stripe webhook の署名シークレット (whsec_...)。 */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * "1" = Stripe ダッシュボードで PayPay を有効化済み。LP と LP管理 に「PayPay」を表示する。
   * 決済手段そのものはダッシュボード管理（動的な決済手段）なので、これは表記だけのスイッチ。
   */
  LP_PAYPAY_ENABLED?: string;
  /** 1 日 (JST) に作れる checkout の上限（既定 300）。 */
  LP_DAILY_CHECKOUT_CAP?: string;
  /** 1 日 (JST) に受け付ける登壇応募の上限（既定 200）。 */
  LP_DAILY_PROPOSAL_CAP?: string;
}
