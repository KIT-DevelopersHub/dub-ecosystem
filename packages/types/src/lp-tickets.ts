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
}

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

// ---- 領収書（公開 LP の /receipt/<token>。トークンは注文ごとの HMAC 署名で、チケット URL とは別） ----

/** 宛名の上限文字数（LP のフォームと lp-tickets の検証で共有）。 */
export const LP_TICKET_RECEIPT_NAME_MAX = 60;

/** issued = 有効な領収書 / refunded = 返金済みで無効（表示はするが「無効」と明記）。 */
export type LpTicketReceiptStatus = "issued" | "refunded";

/** 発行者。未設定の項目は null（LP は「未設定」と明示して出す。勝手に埋めない）。 */
export interface LpTicketReceiptIssuer {
  /** 法人名。 */
  name: string;
  /** イベント名（但し書き・明細に使う）。 */
  event: string;
  /** 事務局名（発行者欄の表示名）。会計アプリの設定、未設定なら「<イベント名> 事務局」。 */
  office: string;
  email: string;
  url: string;
  /** 所在地（〒 + 住所の 1 行）。null = 未設定。 */
  address: string | null;
  /** 電話番号。null = 出さない。 */
  phone: string | null;
  /** 適格請求書発行事業者の登録番号（T + 13 桁）。null = 登録なし（消費税額の内訳も出さない）。 */
  invoiceRegistrationNo: string | null;
  /** 消費税率（%）。内訳を出す時の率。 */
  taxRatePercent: number;
}

/** GET/POST /lp/internal/tickets/receipt/:token（LP Worker が HTML にする）。有料で支払い済み・返金済みの注文だけ。 */
export interface LpTicketReceipt {
  orderNumber: string;
  status: LpTicketReceiptStatus;
  /** null = 宛名なし（LP で 1 回だけ入れられる）。 */
  receiptName: string | null;
  items: LpTicketOrderItem[];
  /** 合計（税込）。 */
  amountJpy: number;
  /** うち消費税（10%）。登録番号が無い時は null。 */
  taxJpy: number | null;
  /** 支払日時（ISO）。 */
  paidAt: string;
  /** Stripe の決済手段（"card" / "paypay" など）。不明は null。 */
  paymentMethod: string | null;
  /** テスト注文（実際の請求なし）。領収書としては無効。 */
  test: boolean;
  issuer: LpTicketReceiptIssuer;
}

/** POST /lp/internal/tickets/receipt/:token — 宛名が未設定の時だけ 1 回入れられる（2 回目は 409）。 */
export interface LpTicketReceiptNameInput {
  /** 1..LP_TICKET_RECEIPT_NAME_MAX 字 */
  receiptName: string;
}
