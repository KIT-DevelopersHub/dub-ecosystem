// Service-local types for lp-tickets (LP チケット販売). The wire shapes come from the shared
// contract @dub/types lpTickets (also read by fe2) — never redeclare them here.
import type { PermissionGranter } from "@dub/policy-gate";
import type { accounting, common, lpTickets } from "@dub/types";
import type { Mailer } from "./mailer";
import type { StripeClient } from "./stripe";

// ---- tickets wire (契約は @dub/types lpTickets が唯一の定義) ----
export type LpTicketFieldType = lpTickets.LpTicketFieldType;
export type LpTicketField = lpTickets.LpTicketField;
export type LpTicketType = lpTickets.LpTicketType;
export type LpTicketTypeStats = lpTickets.LpTicketTypeStats;
export type LpTicketTypeSummary = lpTickets.LpTicketTypeSummary;
export type LpTicketPaymentMethod = lpTickets.LpTicketPaymentMethod;
export type LpTicketsState = lpTickets.LpTicketsState;
export type LpTicketOrderStatus = lpTickets.LpTicketOrderStatus;
export type LpTicketAnswer = lpTickets.LpTicketAnswer;
export type LpTicketOrderItem = lpTickets.LpTicketOrderItem;
export type LpTicketOrder = lpTickets.LpTicketOrder;
export type LpTicketOrdersPage = lpTickets.LpTicketOrdersPage;
export type LpTicketTypeInput = lpTickets.LpTicketTypeInput;
export type LpTicketCoupon = lpTickets.LpTicketCoupon;
export type LpTicketCouponsPage = lpTickets.LpTicketCouponsPage;
export type LpTicketReceipt = lpTickets.LpTicketReceipt;
export type LpTicketReceiptIssuer = lpTickets.LpTicketReceiptIssuer;

// ---- tickets persistence ----
export interface TicketSettingsRow {
  site: string;
  enabled: boolean;
  ctaEnabled: boolean;
  fields: LpTicketField[];
  updatedBy: string | null;
  updatedAt: string;
}
export interface TicketTypeRow extends LpTicketType {
  site: string;
}
export interface TicketOrderRow extends Omit<LpTicketOrder, "test"> {
  site: string;
  stripeSessionId: string | null;
  paymentIntentId: string | null;
  refundedAt: string | null;
  /** Who turned needs_review into paid ('stripe' = dispute won) and when. */
  resolvedBy: string | null;
  resolvedAt: string | null;
  /** Hashed sender IP from the public LP Worker (per-sender hold cap). Never the raw IP. */
  clientKey: string | null;
  /** 0003 migration. 領収書の宛名。null = 宛名なし（購入者名で代用しない）。 */
  receiptName: string | null;
}
export interface TicketCouponRow extends Omit<LpTicketCoupon, "used"> {
  site: string;
}
export interface TicketTypeAgg {
  ticketTypeId: string;
  sold: number;
  pending: number;
  revenueJpy: number;
}

/** 1 席 1 行。URL のトークンは保存しない（ticket-token.ts で導出する）。 */
export interface TicketRow {
  id: string;
  orderId: string;
  ticketTypeId: string;
  ticketTypeName: string;
  dayLabel: string;
  status: "valid" | "void";
  createdAt: string;
  voidedAt: string | null;
}
export type OutboxKind = "buyer_confirmation" | "ops_copy";
export interface OutboxRow {
  id: string;
  orderId: string;
  kind: OutboxKind;
  status: "pending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: string;
  /** A short reason code. Never a mail body, an address or a token. */
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}
export type OutboxUpdate = Pick<OutboxRow, "id" | "status" | "attempts" | "nextAttemptAt" | "lastError" | "sentAt">;
export interface OutboxClaim {
  now: string;
  /** Claimed rows are invisible to other drains until this time. */
  leaseUntil: string;
  kinds: readonly OutboxKind[];
  limit: number;
  /** Only this order's rows (the send right after payment). */
  orderId?: string;
}

export interface PaidSettlement {
  paidAt: string;
  sessionId: string | null;
  paymentIntentId: string | null;
  /**
   * Set (= pendingSince) for a late settle: in the SAME statement, if any item no longer fits its
   * type's capacity next to the other held orders, the order becomes needs_review "oversold" instead of paid.
   */
  capacitySince?: string;
}

export interface LpTicketRepo {
  getTicketSettings(site: string): Promise<TicketSettingsRow | null>;
  /** Upsert; only the given column changes. */
  setTicketEnabled(site: string, enabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  setTicketCta(site: string, ctaEnabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  setTicketFields(site: string, fields: LpTicketField[], updatedBy: string, updatedAt: string): Promise<void>;
  /** 公開設定の本番反映。enabled / cta のどちらかが変わる時だけ行を書く（変わらなければ更新者・日時も残す）。 */
  setTicketRelease(site: string, enabled: boolean, ctaEnabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  listTicketTypes(site: string): Promise<TicketTypeRow[]>;
  getTicketType(site: string, id: string): Promise<TicketTypeRow | null>;
  insertTicketType(row: TicketTypeRow): Promise<void>;
  updateTicketType(row: TicketTypeRow): Promise<void>;
  /** Per type: paid tickets/revenue + pending tickets of orders created at/after `pendingSince`. */
  ticketAggregates(site: string, pendingSince: string): Promise<TicketTypeAgg[]>;
  /** Tickets in this sender's pending orders created at/after `pendingSince` (seats it holds unpaid right now). */
  heldPendingByClient(site: string, clientKey: string, pendingSince: string): Promise<number>;
  countPendingOrdersSince(site: string, pendingSince: string): Promise<number>;
  /**
   * Seat hold for every item: held (paid + fresh pending) + quantity <= capacity per type
   * (capacity null = unlimited). All-or-nothing: on a short item nothing stays held and that
   * item's ticketTypeId is returned.
   */
  /**
   * With row.couponId: in the SAME batch, the order is only inserted while it is one line of the coupon's
   * type, the coupon is active, not expired at row.createdAt, and its held uses + row.quantity <= max_uses
   * (else "coupon_used_up").
   */
  insertOrderIfAvailable(
    row: TicketOrderRow,
    capacities: ReadonlyMap<string, number | null>,
    pendingSince: string,
  ): Promise<{ ok: true } | { ok: false; reason: "sold_out"; ticketTypeId: string } | { ok: false; reason: "coupon_used_up" }>;
  /** false when (site, code) already exists. */
  insertCoupon(row: TicketCouponRow): Promise<boolean>;
  getCoupon(site: string, id: string): Promise<TicketCouponRow | null>;
  /** `code` is already normalized. */
  getCouponByCode(site: string, code: string): Promise<TicketCouponRow | null>;
  setCouponActive(site: string, id: string, active: boolean, updatedAt: string): Promise<boolean>;
  /** Newest first. */
  listCoupons(site: string): Promise<TicketCouponRow[]>;
  /** Tickets used per coupon (held orders: paid / needs_review / fresh pending). */
  couponUses(site: string, pendingSince: string): Promise<Map<string, number>>;
  getOrder(site: string, id: string): Promise<TicketOrderRow | null>;
  getOrderBySession(sessionId: string): Promise<TicketOrderRow | null>;
  setOrderSession(id: string, sessionId: string): Promise<void>;
  getOrderByPaymentIntent(paymentIntentId: string): Promise<TicketOrderRow | null>;
  /** pending|expired -> paid, or needs_review "oversold" (see capacitySince). "Paid wins" over a late expiry. null = no transition. */
  markOrderPaid(id: string, p: PaidSettlement): Promise<"paid" | "needs_review" | null>;
  /** pending -> expired only (never from paid). */
  markOrderExpired(id: string): Promise<boolean>;
  /** pending|expired|paid -> needs_review. */
  markOrderNeedsReview(id: string, reason: string, paymentIntentId?: string | null): Promise<boolean>;
  /** paid|needs_review -> refunded (releases the seat) and, in the same transaction, voids the order's tickets. */
  markOrderRefunded(id: string, refundedAt: string): Promise<boolean>;
  /** needs_review -> paid (paid_at kept if set). `onlyReason` restricts it to that review_reason. */
  approveOrder(id: string, resolvedBy: string, resolvedAt: string, onlyReason?: string): Promise<boolean>;
  /** Fills payment_intent_id only where it is still NULL. */
  setOrderPaymentIntent(id: string, paymentIntentId: string): Promise<void>;
  /** Backfill: paid / needs_review orders with a session but no payment_intent_id (pre-0007), oldest first. */
  listMissingPaymentIntent(site: string, livemode: boolean, limit: number): Promise<TicketOrderRow[]>;
  /** Reconcile: pending orders with a Stripe session, from <= created_at < to, oldest first. */
  listPendingWithSession(site: string, from: string, to: string, limit: number): Promise<TicketOrderRow[]>;
  /** Reconcile: pending orders without a session created before `before` -> expired. Returns count. */
  expireSessionlessPending(site: string, before: string): Promise<number>;
  setOrderPaymentMethod(id: string, method: string): Promise<void>;
  /** 0006 migration. Display-only marker; callers swallow failures. */
  markOrderPreview(id: string): Promise<void>;
  /** 0003 migration. Sets the 宛名 only while it is still NULL (one statement). false = already set / no order. */
  setReceiptName(id: string, receiptName: string): Promise<boolean>;
  /** Newest first, keyset by (created_at, id). */
  listOrders(site: string, cursor: string | null, limit: number): Promise<TicketOrderRow[]>;
  /** Oldest first, keyset by (created_at, id). No per-id binds, so a page may be far larger than listOrders'. */
  listOrdersAscending(site: string, cursor: string | null, limit: number): Promise<TicketOrderRow[]>;

  // ---- 受け渡し（チケット + 送信 outbox） ----
  /**
   * One transaction, only while the order is still paid: inserts what is missing and leaves what
   * exists alone, so replays and concurrent calls end with the same rows.
   */
  issueFulfilment(orderId: string, tickets: readonly TicketRow[], outbox: readonly OutboxRow[]): Promise<void>;
  /** Paid orders missing tickets or an expected mail. `paidSince` null = all of them. Oldest first. */
  listUnfulfilled(site: string, paidSince: string | null, limit: number): Promise<TicketOrderRow[]>;
  getTicket(id: string): Promise<TicketRow | null>;
  /** By id, sequence order inside an order. */
  ticketsForOrders(orderIds: readonly string[]): Promise<TicketRow[]>;
  /** Keyset by id. */
  listTickets(cursor: string | null, limit: number): Promise<TicketRow[]>;
  ordersByIds(site: string, ids: readonly string[]): Promise<TicketOrderRow[]>;
  /** One conditional UPDATE: a row goes to exactly one caller however many drains run at once. */
  claimOutbox(c: OutboxClaim): Promise<OutboxRow[]>;
  countOutboxSentSince(since: string): Promise<number>;
  countOutboxQueued(kinds: readonly OutboxKind[]): Promise<number>;
  applyOutboxUpdates(updates: readonly OutboxUpdate[]): Promise<void>;
  /** Pending rows per kind with next_attempt_at <= before. */
  outboxDue(before: string): Promise<Map<OutboxKind, number>>;
  listOrderOutbox(orderId: string): Promise<OutboxRow[]>;
  getJobStates(): Promise<Map<string, string>>;
  setJobState(key: string, value: string, updatedAt: string): Promise<void>;
}

export interface ReqCtx {
  requestId: string;
  userId: common.UserId;
}

/** The R2 calls the daily backup needs (bucket dub-tickets-backup). */
export interface BackupStore {
  exists(key: string): Promise<boolean>;
  put(key: string, json: string): Promise<void>;
}

export interface AppDeps {
  repo: LpTicketRepo;
  /** Which of the requested permission keys the caller holds (identity /authz/check). */
  authz: PermissionGranter;
  /** 公開 LP の URL。 */
  lpBaseUrl: string;
  now: () => string;
  newTicketTypeId: () => string;
  newOrderId: () => string;
  newCouponId: () => string;
  /** null = STRIPE_SECRET_KEY 未設定（paymentReady=false）。 */
  stripe: StripeClient | null;
  /** STRIPE_WEBHOOK_SECRET。null なら webhook は常に 400。 */
  stripeWebhookSecret: string | null;
  /**
   * Free plan: arms the reconcile alarm loop (TicketReconcileDO). `soon` brings the next run forward
   * for a mail backlog. null = cron drives reconcile (paid) / tests.
   */
  armReconcile: ((opts?: { soon?: boolean }) => Promise<void>) | null;
  /**
   * LP管理「プレビュー」のテスト購入トークンの鍵（Stripe のテストキー sk_test_ / rk_test_）。
   * 未設定・本番キーなら null = テスト購入トークンを発行も検証もしない。
   */
  ticketPreviewKey: string | null;
  /** LP_PAYPAY_ENABLED="1": PayPay is on in the Stripe Dashboard, so the LP / LP管理 advertise it. */
  paypayEnabled: boolean;
  /** null = RESEND_API_KEY unset: nothing is sent, the outbox stays pending. */
  mailer: Mailer | null;
  /** null = TICKET_TOKEN_SECRET unset: no ticket URL can be produced, buyer mail stays pending. */
  ticketTokenSecret: string | null;
  /** null = TICKET_OPS_EMAIL unset: the ops copy stays pending. */
  ticketOpsEmail: string | null;
  ticketMailFrom: string;
  /** Mails per JST day. null = no limit. The Resend free plan is shared with the rest of Dub. */
  ticketMailDailyCap: number | null;
  /** null = no BACKUP binding. */
  backup: BackupStore | null;
  /** ctx.waitUntil of the current request. null outside a request (cron, alarm, tests). */
  defer: ((work: Promise<unknown>) => void) | null;
  sleep: (ms: number) => Promise<void>;
  /**
   * 会計アプリの発行者情報 (member-service の内部口)。null を返したら未設定 = 既定の RECEIPT_ISSUER。
   * 失敗は throw (領収書を古い発行者のまま出さず 503)。結線が無い環境 (テスト・未設定) は () => null。
   */
  loadIssuer: () => Promise<accounting.IssuerSettings | null>;
}
