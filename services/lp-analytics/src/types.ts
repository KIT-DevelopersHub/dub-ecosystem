// Service-local types for lp-analytics (LP管理: 流入URL + LP 訪問ログ). The wire shapes
// mirror the contract frozen by fe2 (apps/fe2-app-shell/src/features/lp/lpApi.tsx) —
// that file and the demo transport answer exactly these, so keep them in lockstep.
import type { MiddlewareHandler, Context } from "hono";
import type { common, identity, policy } from "@dub/types";
import type { SiteTrafficSource } from "./site-traffic";
import type { StripeClient } from "./stripe";

export type LpDevice = "mobile" | "desktop" | "bot" | "unknown";
/** redirect = arrived through an issued 流入URL (linkId set); ingest = no matching link. */
export type LpVisitKind = "redirect" | "ingest";

// ---- wire ----
export interface LpVisit {
  id: string;
  linkId: string | null;
  source: string;
  lpVersion: string | null;
  path: string | null;
  referrerHost: string | null;
  country: string | null;
  device: LpDevice;
  kind: LpVisitKind;
  occurredAt: string;
}

export interface LpStatsBucket {
  key: string;
  label: string;
  visits: number;
  uniques: number;
}

export interface LpStats {
  range: { from: string; to: string };
  totals: { visits: number; uniques: number; botExcluded: number };
  bySource: LpStatsBucket[];
  byDay: { date: string; visits: number }[];
  byDevice: LpStatsBucket[];
}

/** Site-wide traffic from Cloudflare Web Analytics (exists from before lp-analytics).
 *  configured=false: the token / site tag is not set in this environment. */
export interface LpSiteTraffic {
  configured: boolean;
  range: { from: string; to: string };
  totals: { pageViews: number; visits: number };
  byDay: { date: string; pageViews: number; visits: number }[];
  byReferrer: { key: string; label: string; pageViews: number; visits: number }[];
}

export interface LpVisitsPage {
  items: LpVisit[];
  nextCursor: string | null;
}

export interface LpLink {
  id: string;
  name: string;
  slug: string;
  url: string;
  active: boolean;
  createdAt: string;
}

export interface LpLinkStats {
  visits: number;
  uniques: number;
  lastVisitAt: string | null;
}

export interface LpLinkSummary extends LpLink {
  stats: LpLinkStats;
}

/** What the gateway's public beacon forwards (already sanitized + classified there). */
export interface IngestVisitRequest {
  source: string | null;
  path: string | null;
  lpVersion: string | null;
  referrerHost: string | null;
  country: string | null;
  device: LpDevice;
  visitorKey: string;
}

// ---- persistence ----
/** lp_publish row: the version live on a public site (公開版切り替え). */
export interface PublishRow {
  site: string;
  versionId: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface LinkRow {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisitRow extends LpVisit {
  orgId: string;
  visitorKey: string;
  dayJst: string;
}

export type AggregateBy = "source" | "device" | "day" | "link";

export interface AggregateQuery {
  orgId: string;
  from: string;
  to: string;
  includeBots: boolean;
}

export interface AggregateRow {
  key: string;
  visits: number;
  uniques: number;
  lastVisitAt: string | null;
}

// ---- tickets wire (lockstep with fe2 lpApi.tsx) ----
export type LpTicketFieldType = "text" | "textarea" | "select" | "checkbox";
export interface LpTicketField {
  id: string;
  label: string;
  type: LpTicketFieldType;
  required: boolean;
  options: string[];
}
export interface LpTicketType {
  id: string;
  name: string;
  description: string;
  priceJpy: number;
  capacity: number | null;
  /** 対象日（例 "Day 1"）。"" = 通し/共通。 */
  dayLabel: string;
  /** 1 回の購入で買える上限枚数。 */
  maxPerOrder: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
/** sold / pending are ticket counts (sum of quantities), not orders. pending = held but not sold (fresh pending + needs_review). */
export interface LpTicketTypeStats {
  sold: number;
  pending: number;
  revenueJpy: number;
  remaining: number | null;
}
export interface LpTicketTypeSummary extends LpTicketType {
  stats: LpTicketTypeStats;
}
export interface LpTicketsState {
  site: string;
  enabled: boolean;
  /** LP の「参加登録」ボタンを「参加チケットを購入」に差し替える（enabled の間だけ効く）。 */
  ctaEnabled: boolean;
  paymentReady: boolean;
  publicUrl: string;
  fields: LpTicketField[];
  types: LpTicketTypeSummary[];
  totals: { sold: number; revenueJpy: number };
  updatedAt: string | null;
  updatedBy: string | null;
}
/** needs_review = Stripe says paid but amount/currency mismatched, or disputed: a human must look (seat kept). */
export type LpTicketOrderStatus = "pending" | "paid" | "expired" | "refunded" | "needs_review";
export interface LpTicketAnswer {
  fieldId: string;
  label: string;
  value: string;
}
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
}
export interface LpTicketOrdersPage {
  items: LpTicketOrder[];
  nextCursor: string | null;
}
export interface LpTicketTypeInput {
  name: string;
  description: string;
  priceJpy: number;
  capacity: number | null;
  dayLabel: string;
  maxPerOrder: number;
  active: boolean;
}

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
export interface TicketOrderRow extends LpTicketOrder {
  site: string;
  stripeSessionId: string | null;
  paymentIntentId: string | null;
  refundedAt: string | null;
  reviewReason: string | null;
}
export interface TicketTypeAgg {
  ticketTypeId: string;
  sold: number;
  pending: number;
  revenueJpy: number;
}

export interface PaidSettlement {
  paidAt: string;
  sessionId: string | null;
  paymentIntentId: string | null;
  /** Set => money taken but a human must look (e.g. "oversold"): status needs_review instead of paid. */
  reviewReason?: string;
}

export interface LpTicketRepo {
  getTicketSettings(site: string): Promise<TicketSettingsRow | null>;
  /** Upsert; only the given column changes. */
  setTicketEnabled(site: string, enabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  setTicketCta(site: string, ctaEnabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  setTicketFields(site: string, fields: LpTicketField[], updatedBy: string, updatedAt: string): Promise<void>;
  listTicketTypes(site: string): Promise<TicketTypeRow[]>;
  getTicketType(site: string, id: string): Promise<TicketTypeRow | null>;
  insertTicketType(row: TicketTypeRow): Promise<void>;
  updateTicketType(row: TicketTypeRow): Promise<void>;
  /** Per type: paid tickets/revenue + pending tickets of orders created at/after `pendingSince`. */
  ticketAggregates(site: string, pendingSince: string): Promise<TicketTypeAgg[]>;
  /** Orders created at/after `since` (daily checkout cap). */
  countOrdersSince(site: string, since: string): Promise<number>;
  /**
   * Seat hold for every item: held (paid + fresh pending) + quantity <= capacity per type
   * (capacity null = unlimited). All-or-nothing: on a short item nothing stays held and that
   * item's ticketTypeId is returned.
   */
  insertOrderIfAvailable(
    row: TicketOrderRow,
    capacities: ReadonlyMap<string, number | null>,
    pendingSince: string,
  ): Promise<{ ok: true } | { ok: false; ticketTypeId: string }>;
  getOrder(site: string, id: string): Promise<TicketOrderRow | null>;
  getOrderBySession(sessionId: string): Promise<TicketOrderRow | null>;
  setOrderSession(id: string, sessionId: string): Promise<void>;
  getOrderByPaymentIntent(paymentIntentId: string): Promise<TicketOrderRow | null>;
  /** pending|expired -> paid, or needs_review with reviewReason ("paid wins" over a late expiry). true = this call made the transition. */
  markOrderPaid(id: string, p: PaidSettlement): Promise<boolean>;
  /** pending -> expired only (never from paid). */
  markOrderExpired(id: string): Promise<boolean>;
  /** pending|expired|paid -> needs_review. */
  markOrderNeedsReview(id: string, reason: string, paymentIntentId?: string | null): Promise<boolean>;
  /** paid|needs_review -> refunded (releases the seat). */
  markOrderRefunded(id: string, refundedAt: string): Promise<boolean>;
  /** Reconcile: pending orders with a Stripe session, from <= created_at < to, oldest first. */
  listPendingWithSession(site: string, from: string, to: string, limit: number): Promise<TicketOrderRow[]>;
  /** Reconcile: pending orders without a session created before `before` -> expired. Returns count. */
  expireSessionlessPending(site: string, before: string): Promise<number>;
  /** Newest first, keyset by (created_at, id). */
  listOrders(site: string, cursor: string | null, limit: number): Promise<TicketOrderRow[]>;
}

// ---- proposals wire (lockstep with fe2 lpApi.tsx) ----
/** submitted = 未対応 / accepted = 採択 / rejected = 見送り。 */
export type LpProposalStatus = "submitted" | "accepted" | "rejected";
export interface LpProposalsState {
  site: string;
  enabled: boolean;
  publicUrl: string;
  /** 追加の入力項目（氏名・メール・タイトル・概要は固定なので含めない）。未保存なら既定の項目。 */
  fields: LpTicketField[];
  totals: { total: number; accepted: number; rejected: number };
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface LpProposal {
  id: string;
  speakerName: string;
  email: string;
  title: string;
  abstract: string;
  answers: LpTicketAnswer[];
  status: LpProposalStatus;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface LpProposalsPage {
  items: LpProposal[];
  nextCursor: string | null;
}

// ---- proposals persistence ----
export interface ProposalSettingsRow {
  site: string;
  enabled: boolean;
  /** null = never saved (use the service default). */
  fields: LpTicketField[] | null;
  updatedBy: string | null;
  updatedAt: string;
}
export interface ProposalRow extends LpProposal {
  site: string;
  /** 送信元 IP のハッシュ（LP Worker が計算）。応募一覧には出さない。 */
  clientKey: string | null;
}

export interface LpProposalRepo {
  getProposalSettings(site: string): Promise<ProposalSettingsRow | null>;
  /** Upsert; only the given column changes. */
  setProposalEnabled(site: string, enabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  setProposalFields(site: string, fields: LpTicketField[], updatedBy: string, updatedAt: string): Promise<void>;
  insertProposal(row: ProposalRow): Promise<void>;
  getProposal(site: string, id: string): Promise<ProposalRow | null>;
  /** false when the proposal does not exist. */
  setProposalStatus(site: string, id: string, status: LpProposalStatus, reviewedBy: string, updatedAt: string): Promise<boolean>;
  /** Newest first, keyset by (created_at, id). */
  listProposals(site: string, cursor: string | null, limit: number): Promise<ProposalRow[]>;
  proposalTotals(site: string): Promise<{ total: number; accepted: number; rejected: number }>;
  /** Proposals created at/after `since` (daily submit cap). With clientKey: only that sender's. */
  countProposalsSince(site: string, since: string, clientKey?: string): Promise<number>;
}

export interface LpRepo extends LpTicketRepo, LpProposalRepo {
  listLinks(orgId: string): Promise<LinkRow[]>;
  getLink(orgId: string, id: string): Promise<LinkRow | null>;
  getLinkBySlug(orgId: string, slug: string): Promise<LinkRow | null>;
  /** false when (org, slug) already exists. */
  insertLink(row: LinkRow): Promise<boolean>;
  setLinkActive(orgId: string, id: string, active: boolean, updatedAt: string): Promise<void>;
  /** false when the (visitor, day, source, path) dedupe key already exists. */
  insertVisit(row: VisitRow): Promise<boolean>;
  /** Visits recorded on a JST day (the daily ingest cap's counter). */
  recordedOn(dayJst: string): Promise<number>;
  bumpRecorded(dayJst: string, now: string): Promise<void>;
  /** Grand total over the range (one row, key ""). */
  total(q: AggregateQuery): Promise<AggregateRow>;
  countBots(q: Omit<AggregateQuery, "includeBots">): Promise<number>;
  aggregate(q: AggregateQuery, by: AggregateBy): Promise<AggregateRow[]>;
  /** Non-bot visits, newest first, keyset-paged by (day_jst, id) — see visitCursor. */
  listVisits(q: { orgId: string; from: string; to: string; source?: string; cursor?: string; limit: number }): Promise<VisitRow[]>;
  /** null when the site has no row yet (callers fall back to the default version). */
  getPublish(site: string): Promise<PublishRow | null>;
  /** Upsert the live version for a site. */
  setPublish(site: string, versionId: string, updatedBy: string, updatedAt: string): Promise<void>;
}

export interface ReqCtx {
  requestId: string;
  userId: common.UserId;
}

export interface Authz {
  requireAuth(): MiddlewareHandler;
  requireAppAccess(
    app: string,
    level: policy.AppAccessLevel,
    extra?: { permission?: identity.PermissionKey; resolve?: (c: Context) => { orgId?: string } },
  ): MiddlewareHandler;
}

export interface AppDeps {
  repo: LpRepo;
  authz: Authz;
  orgId: common.OrgId;
  /** 公開 LP の URL。流入URL はこれ + ?utm_source=<slug>。 */
  lpBaseUrl: string;
  now: () => string;
  newLinkId: () => string;
  newVisitId: () => string;
  /** 1 日に記録する訪問の上限。匿名ビーコンが共有 D1 の書き込み枠を食い潰さないための天井。 */
  dailyVisitCap: number;
  /** Cloudflare Web Analytics reader. null when not configured in this environment. */
  siteTraffic: SiteTrafficSource | null;
  newTicketTypeId: () => string;
  newOrderId: () => string;
  /** 1 日 (JST) に作れる checkout の上限。公開フォームからの書き込み濫用の天井。 */
  dailyCheckoutCap: number;
  /** null = STRIPE_SECRET_KEY 未設定（paymentReady=false）。 */
  stripe: StripeClient | null;
  /** STRIPE_WEBHOOK_SECRET。null なら webhook は常に 400。 */
  stripeWebhookSecret: string | null;
  newProposalId: () => string;
  /** 1 日 (JST) に受け付ける登壇応募の上限。公開フォームからの書き込み濫用の天井。 */
  dailyProposalCap: number;
}
