// lpTickets — LP チケット販売（/tickets）の HTTP 契約。services/lp-tickets が返し、
// fe2（LP管理 > チケット）が読む。両者ともここから import し、ローカルに再宣言しない
// （packages/types/test/lp-tickets.test.ts が再宣言を検出する）。
import type { LpFieldType, LpFormAnswer, LpFormField } from "./lp";

export type LpTicketFieldType = LpFieldType;
export type LpTicketField = LpFormField;
export type LpTicketAnswer = LpFormAnswer;

export interface LpTicketType {
  id: string;
  name: string;
  description: string;
  priceJpy: number;
  capacity: number | null;
  /** "" = 日付なし（通し/共通）。例 "Day 1 · 9/13(月)"。0..30 字 */
  dayLabel: string;
  /** 1 回の購入で買える上限枚数 1..20（既定 10） */
  maxPerOrder: number;
  active: boolean;
  /**
   * 無料参加登録: 0 円券をクーポン無しで申し込める（LP は「無料で参加登録」と出す）。
   * true は priceJpy === 0 のときだけ。1 メールアドレスにつき 1 枚（同じイベントで重複登録は 409 already_registered）。
   */
  openRegistration: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** sold / pending は「枚数」（注文数ではない）。pending = 確保中で未販売（決済待ち + 要確認）。 */
export interface LpTicketTypeStats {
  sold: number;
  pending: number;
  revenueJpy: number;
  remaining: number | null;
}

export interface LpTicketTypeSummary extends LpTicketType {
  stats: LpTicketTypeStats;
}

/** LP に出す決済手段。注文には Stripe の PaymentMethod.type がそのまま入る（"link" など他もあり得る）。 */
export type LpTicketPaymentMethod = "card" | "paypay";

/** GET /api/v1/lp/tickets */
export interface LpTicketsState {
  site: string;
  enabled: boolean;
  /** LP の「参加登録」ボタンを「参加チケットを購入」に差し替える。効くのは enabled && ctaEnabled のとき。 */
  ctaEnabled: boolean;
  paymentReady: boolean;
  /** Stripe がテストキーで動いていて、プレビューからテスト購入できる（本番キー・未設定なら false）。 */
  previewCheckout: boolean;
  /** LP に表示する決済手段（PayPay は LP_PAYPAY_ENABLED=1 の時だけ）。 */
  paymentMethods: LpTicketPaymentMethod[];
  /** LP_BASE_URL + "/tickets" */
  publicUrl: string;
  fields: LpTicketField[];
  types: LpTicketTypeSummary[];
  totals: { sold: number; revenueJpy: number };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** needs_review = 金額/通貨の不一致・チャージバック等で人の確認が必要（席は確保したまま）。 */
export type LpTicketOrderStatus = "pending" | "paid" | "expired" | "refunded" | "needs_review";

export interface LpTicketOrderItem {
  ticketTypeId: string;
  ticketTypeName: string;
  dayLabel: string;
  unitPriceJpy: number;
  quantity: number;
}

export interface LpTicketOrder {
  id: string;
  items: LpTicketOrderItem[];
  /** 合計枚数 */
  quantity: number;
  /** 合計金額 */
  amountJpy: number;
  status: LpTicketOrderStatus;
  buyerName: string;
  buyerEmail: string;
  answers: LpTicketAnswer[];
  createdAt: string;
  paidAt: string | null;
  /** needs_review になった理由（amount_mismatch / currency_mismatch / oversold / dispute）。確定後も残る。 */
  reviewReason: string | null;
  /** 使ったクーポン。クーポン注文は常に 0 円。 */
  couponId: string | null;
  /** 実際に使われた Stripe の決済手段（"card" / "paypay" など）。無料・未確定・不明は null。 */
  paymentMethod: string | null;
  /** LP管理のプレビュー（テスト購入トークン）から作られた注文。 */
  preview: boolean;
  /** テスト注文（プレビュー由来、または Stripe テストモードの決済 cs_test_）。実際の請求はない。 */
  test: boolean;
}

/** GET /api/v1/lp/tickets/orders */
export interface LpTicketOrdersPage {
  items: LpTicketOrder[];
  nextCursor: string | null;
}

/** POST /api/v1/lp/tickets/types（PATCH は Partial）。 */
export interface LpTicketTypeInput {
  name: string;
  description: string;
  priceJpy: number;
  capacity: number | null;
  dayLabel: string;
  maxPerOrder: number;
  active: boolean;
  /** 省略 = false（作成）/ 変更なし（PATCH）。true は priceJpy === 0 のときだけ（違えば 400 openRegistration requires_free）。 */
  openRegistration?: boolean;
}

/**
 * GET /lp/internal/tickets の券種（公開 LP 向け。販売中の券種だけ）。
 * couponOnly = 0 円でクーポン必須（LP は通常の一覧に出さない）。openRegistration = 0 円でクーポン無しで申し込める
 * （1 回 1 枚・1 メールアドレス 1 回）。両方 true にはならない。
 */
export interface LpTicketPublicType {
  id: string;
  name: string;
  description: string;
  priceJpy: number;
  dayLabel: string;
  maxPerOrder: number;
  /** 確保分を引いた残り。null = 定員なし */
  remaining: number | null;
  soldOut: boolean;
  couponOnly: boolean;
  openRegistration: boolean;
}

/** 409 の details.reason（公開 checkout）。already_registered = 同じメールアドレスで無料参加登録済み。 */
export type LpTicketCheckoutConflict = "sold_out" | "coupon_used_up" | "already_registered";

/** 無料券のクーポン。1 コード = 1 券種 x 最大 maxUses 枚。used = 使った枚数（決済待ち・要確認の確保分を含む）。 */
export interface LpTicketCoupon {
  id: string;
  /** サーバー生成（英大文字 + 数字 10 文字）。 */
  code: string;
  label: string;
  ticketTypeId: string;
  maxUses: number;
  used: number;
  /** null = 期限なし */
  expiresAt: string | null;
  /** false = 停止中。削除は無い（注文が参照するため）。 */
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LpTicketCouponsPage {
  items: LpTicketCoupon[];
}

/** POST /api/v1/lp/tickets/coupons */
export interface LpTicketCouponInput {
  ticketTypeId: string;
  /** 1..1000 */
  maxUses: number;
  /** 0..60 字 */
  label?: string;
  /** ISO・未来 */
  expiresAt?: string;
}
