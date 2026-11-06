// Worker bindings for lp-tickets: its own dub-tickets D1 + identity-roster for the policy gate
// (+ the free-plan reconcile DO). No queues / events.
import type { D1Database, DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  SVC_IDENTITY: Fetcher;
  DUB_DEFAULT_ORG_ID?: string;
  /** 公開 LP の URL（LP管理に出す /tickets の URL）。未設定なら本番 LP。 */
  LP_BASE_URL?: string;
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
  /** Free plan only: alarm loop that runs the ticket payment reconcile (no cron slot left). */
  TICKET_RECONCILE_DO?: DurableObjectNamespace;
}
