// LP チケット購入: validation + TicketService (settings / types / orders / checkout / Stripe confirm).
// Prices always come from D1; the client never supplies an amount.
import { DubError, errors, type FieldError } from "@dub/errors";
import { consoleSink, type LogLevel } from "@dub/observability";
import { lp } from "@dub/types";
import { dayJst } from "./domain";
import { stripeId, toCheckoutSession, verifyStripeSignature, type CheckoutSession } from "./stripe";
import type {
  AppDeps,
  LpTicketAnswer,
  LpTicketCoupon,
  LpTicketCouponsPage,
  LpTicketField,
  LpTicketFieldType,
  LpTicketOrder,
  LpTicketOrderItem,
  LpTicketOrderStatus,
  LpTicketOrdersPage,
  LpTicketsState,
  LpTicketType,
  LpTicketTypeInput,
  LpTicketTypeStats,
  LpTicketTypeSummary,
  ReqCtx,
  TicketCouponRow,
  TicketOrderRow,
  TicketTypeAgg,
  TicketTypeRow,
} from "./types";

export const TICKET_SITE = lp.LP_PUBLISH_SITE;
export const TICKET_NAME_MAX = 60;
export const TICKET_DESC_MAX = 300;
export const TICKET_PRICE_MAX = 1_000_000;
/** Stripe JPY minimum charge. 1..49 is rejected; 0 = free. */
export const STRIPE_JPY_MIN = 50;
export const TICKET_CAPACITY_MAX = 100_000;
export const DAY_LABEL_MAX = 30;
export const MAX_PER_ORDER_MAX = 20;
export const DEFAULT_MAX_PER_ORDER = 10;
/** 1 回の購入の合計枚数上限（券種をまたいで）。 */
export const ORDER_QTY_MAX = 20;
export const FIELDS_MAX = 20;
export const FIELD_LABEL_MAX = 60;
export const FIELD_OPTIONS_MAX = 20;
export const FIELD_OPTION_MAX = 60;
const FIELD_ID_RE = /^[a-z0-9_-]{1,40}$/;
/** 氏名・メールは固定項目なのでカスタム項目の id に使わせない。 */
const RESERVED_FIELD_IDS: ReadonlySet<string> = new Set(["name", "email"]);
const FIELD_TYPES: ReadonlySet<LpTicketFieldType> = new Set(["text", "textarea", "select", "checkbox"]);
export const CHECKBOX_YES = "はい";

export const BUYER_NAME_MAX = 100;
export const BUYER_EMAIL_MAX = 254;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Hashed sender IP from the public LP Worker (clientKeyFor). Anything else is treated as absent. */
export const CLIENT_KEY_RE = /^[a-f0-9]{16,64}$/;
/**
 * Unpaid seats one sender may hold at once (pending orders inside the hold window). Stops one source
 * from locking a type's capacity with abandoned checkouts; real buyers pay within minutes, and a shared
 * campus IP still fits 20 tickets in flight at the same moment.
 */
export const PER_CLIENT_HELD_MAX = 20;
/**
 * Coupon codes are generated here, never typed by staff: 10 chars from 31 symbols (no 0/O/1/I/L)
 * = ~8e14 codes, so guessing one through the public form is not a practical attack.
 */
export const COUPON_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const COUPON_CODE_LEN = 10;
/** Accepted on input after normalizing (upper case, spaces / hyphens dropped). */
const COUPON_CODE_RE = /^[A-Z0-9]{4,32}$/;
export const COUPON_LABEL_MAX = 60;
export const COUPON_MAX_USES_MAX = 1000;
const ANSWER_MAX: Record<LpTicketFieldType, number> = { text: 200, textarea: 2000, select: FIELD_OPTION_MAX, checkbox: 10 };

/** Stripe session lifetime. Stripe requires >= 30 min, so a minute of headroom for clock/network skew. */
export const CHECKOUT_TTL_SEC = 31 * 60;
/** A pending order holds its seat this long (> session lifetime). */
export const PENDING_HOLD_MS = 35 * 60 * 1000;

/** completed / async_payment_succeeded settle via payment_status; expired / async_payment_failed release. */
const SESSION_EVENTS: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);
const RELEASE_EVENTS: ReadonlySet<string> = new Set(["checkout.session.expired", "checkout.session.async_payment_failed"]);
const CHARGE_EVENTS: ReadonlySet<string> = new Set(["charge.refunded", "charge.dispute.created", "charge.dispute.closed"]);

/** Reconcile window: younger sessions are still in flight; older ones are long settled at Stripe. */
export const RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;
export const RECONCILE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const RECONCILE_LIMIT = 50;

export type SettleOutcome = "paid" | "needs_review" | "expired" | "unchanged" | "ignored";

export interface ReconcileSummary {
  checked: number;
  paid: number;
  needsReview: number;
  expired: number;
  unchanged: number;
  ignored: number;
  errors: number;
  /** Session-less pending past the hold (Stripe create never finished). */
  sessionlessExpired: number;
  /** Pre-0005 paid orders that got their payment_intent_id (so refunds / disputes match them). */
  paymentIntentBackfilled: number;
}

function log(level: LogLevel, message: string, fields: Record<string, unknown>): void {
  consoleSink({ level, message, service: "lp-analytics", fields });
}

const DEFAULT_ORDERS_PAGE = 50;
const MAX_ORDERS_PAGE = 200;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

// ---- validation (pure) ----

/** Full input (create) or partial (patch). Throws 400 with per-field reasons. */
export function parseTicketTypeInput(body: unknown, partial: false): LpTicketTypeInput;
export function parseTicketTypeInput(body: unknown, partial: true): Partial<LpTicketTypeInput>;
export function parseTicketTypeInput(body: unknown, partial: boolean): Partial<LpTicketTypeInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<LpTicketTypeInput> = {};
  const bad: FieldError[] = [];
  const has = (k: string) => b[k] !== undefined;

  if (has("name") || !partial) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length === 0) bad.push({ field: "name", reason: "required" });
    else if (name.length > TICKET_NAME_MAX) bad.push({ field: "name", reason: "too_long" });
    else out.name = name;
  }
  if (has("description") || !partial) {
    const d = b.description === undefined || b.description === null ? "" : b.description;
    if (typeof d !== "string") bad.push({ field: "description", reason: "invalid" });
    else if (d.trim().length > TICKET_DESC_MAX) bad.push({ field: "description", reason: "too_long" });
    else out.description = d.trim();
  }
  if (has("priceJpy") || !partial) {
    const p = b.priceJpy;
    if (!isInt(p) || p < 0 || p > TICKET_PRICE_MAX) bad.push({ field: "priceJpy", reason: "invalid" });
    else if (p > 0 && p < STRIPE_JPY_MIN) bad.push({ field: "priceJpy", reason: "below_stripe_minimum" });
    else out.priceJpy = p;
  }
  if (has("capacity") || !partial) {
    const c = b.capacity === undefined ? null : b.capacity;
    if (c !== null && (!isInt(c) || c < 1 || c > TICKET_CAPACITY_MAX)) bad.push({ field: "capacity", reason: "invalid" });
    else out.capacity = c;
  }
  if (has("dayLabel") || !partial) {
    const d = b.dayLabel === undefined || b.dayLabel === null ? "" : b.dayLabel;
    if (typeof d !== "string") bad.push({ field: "dayLabel", reason: "invalid" });
    else if (d.trim().length > DAY_LABEL_MAX) bad.push({ field: "dayLabel", reason: "too_long" });
    else out.dayLabel = d.trim();
  }
  if (has("maxPerOrder") || !partial) {
    const m = b.maxPerOrder === undefined ? DEFAULT_MAX_PER_ORDER : b.maxPerOrder;
    if (!isInt(m) || m < 1 || m > MAX_PER_ORDER_MAX) bad.push({ field: "maxPerOrder", reason: "invalid" });
    else out.maxPerOrder = m;
  }
  if (has("active") || !partial) {
    const a = b.active === undefined ? true : b.active;
    if (typeof a !== "boolean") bad.push({ field: "active", reason: "invalid" });
    else out.active = a;
  }
  if (bad.length > 0) throw errors.validationFailed(bad);
  return out;
}

/** `reserved` = fixed-field ids the caller's form already has (custom fields must not reuse them). */
export function parseFields(body: unknown, reserved: ReadonlySet<string> = RESERVED_FIELD_IDS): LpTicketField[] {
  const raw = (body as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(raw)) throw errors.validationFailed([{ field: "fields", reason: "required" }]);
  if (raw.length > FIELDS_MAX) throw errors.validationFailed([{ field: "fields", reason: "too_many" }]);
  const bad: FieldError[] = [];
  const seen = new Set<string>();
  const out: LpTicketField[] = [];
  raw.forEach((f0, i) => {
    const f = (f0 ?? {}) as Record<string, unknown>;
    const at = (k: string) => `fields[${i}].${k}`;
    const before = bad.length;
    const id = typeof f.id === "string" ? f.id : "";
    if (!FIELD_ID_RE.test(id) || reserved.has(id)) bad.push({ field: at("id"), reason: "invalid" });
    else if (seen.has(id)) bad.push({ field: at("id"), reason: "duplicate" });
    seen.add(id);
    const label = typeof f.label === "string" ? f.label.trim() : "";
    if (label.length === 0) bad.push({ field: at("label"), reason: "required" });
    else if (label.length > FIELD_LABEL_MAX) bad.push({ field: at("label"), reason: "too_long" });
    const type = f.type as LpTicketFieldType;
    if (!FIELD_TYPES.has(type)) bad.push({ field: at("type"), reason: "invalid" });
    if (typeof f.required !== "boolean") bad.push({ field: at("required"), reason: "invalid" });
    let options: string[] = [];
    if (type === "select") {
      const opts = Array.isArray(f.options) ? f.options : [];
      options = opts.map((o) => (typeof o === "string" ? o.trim() : ""));
      if (options.length < 1 || options.length > FIELD_OPTIONS_MAX) bad.push({ field: at("options"), reason: "invalid_count" });
      else if (options.some((o) => o.length === 0 || o.length > FIELD_OPTION_MAX)) bad.push({ field: at("options"), reason: "invalid" });
      else if (new Set(options).size !== options.length) bad.push({ field: at("options"), reason: "duplicate" });
    }
    if (bad.length === before) out.push({ id, label, type, required: f.required as boolean, options });
  });
  if (bad.length > 0) throw errors.validationFailed(bad);
  return out;
}

export interface CheckoutItemInput {
  ticketTypeId: string;
  quantity: number;
}

export interface CheckoutInput {
  items: CheckoutItemInput[];
  name: string;
  email: string;
  answers: LpTicketAnswer[];
  origin: string;
  /** null when absent / malformed (local dev): only the per-sender hold cap is skipped. */
  clientKey: string | null;
  /** Normalized coupon code; null = none entered. */
  couponCode: string | null;
}

/** "abcde-12345 " -> "ABCDE12345"; null when it can not be a code. */
export function normalizeCouponCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  return COUPON_CODE_RE.test(code) ? code : null;
}

/** Uniform over COUPON_ALPHABET (rejection sampling: no modulo bias). */
export function generateCouponCode(): string {
  const n = COUPON_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < COUPON_CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < COUPON_CODE_LEN) out += COUPON_ALPHABET[b % n];
    }
  }
  return out;
}

export interface CouponInput {
  ticketTypeId: string;
  maxUses: number;
  label: string;
  expiresAt: string | null;
}

/** LP管理: a new coupon. `now` rejects an expiry already in the past. */
export function parseCouponInput(body: unknown, now: string): CouponInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad: FieldError[] = [];
  const ticketTypeId = typeof b.ticketTypeId === "string" ? b.ticketTypeId.trim() : "";
  if (!ticketTypeId) bad.push({ field: "ticketTypeId", reason: "required" });
  const maxUses = b.maxUses;
  if (!isInt(maxUses) || maxUses < 1 || maxUses > COUPON_MAX_USES_MAX) bad.push({ field: "maxUses", reason: "invalid" });
  const l = b.label === undefined || b.label === null ? "" : b.label;
  let label = "";
  if (typeof l !== "string") bad.push({ field: "label", reason: "invalid" });
  else if (l.trim().length > COUPON_LABEL_MAX) bad.push({ field: "label", reason: "too_long" });
  else label = l.trim();
  let expiresAt: string | null = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null && b.expiresAt !== "") {
    const ms = typeof b.expiresAt === "string" ? Date.parse(b.expiresAt) : NaN;
    if (!Number.isFinite(ms)) bad.push({ field: "expiresAt", reason: "invalid" });
    else if (ms <= Date.parse(now)) bad.push({ field: "expiresAt", reason: "in_past" });
    else expiresAt = new Date(ms).toISOString();
  }
  if (bad.length > 0) throw errors.validationFailed(bad);
  return { ticketTypeId, maxUses: maxUses as number, label, expiresAt };
}

/** Validates the public form against the configured fields. Answers keep a label snapshot. */
export function parseCheckout(body: unknown, fields: LpTicketField[]): CheckoutInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad: FieldError[] = [];
  const items: CheckoutItemInput[] = [];
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length === 0) bad.push({ field: "items", reason: "required" });
  for (const r0 of rawItems) {
    const r = (r0 ?? {}) as Record<string, unknown>;
    const ticketTypeId = typeof r.ticketTypeId === "string" ? r.ticketTypeId.trim() : "";
    const key = `items.${ticketTypeId}`;
    if (!ticketTypeId) bad.push({ field: "items", reason: "invalid" });
    else if (items.some((i) => i.ticketTypeId === ticketTypeId)) bad.push({ field: key, reason: "duplicate" });
    else if (!isInt(r.quantity) || r.quantity < 1 || r.quantity > ORDER_QTY_MAX) bad.push({ field: key, reason: "invalid" });
    else items.push({ ticketTypeId, quantity: r.quantity });
  }
  if (items.reduce((n, i) => n + i.quantity, 0) > ORDER_QTY_MAX) bad.push({ field: "items", reason: "too_many" });
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) bad.push({ field: "name", reason: "required" });
  else if (name.length > BUYER_NAME_MAX) bad.push({ field: "name", reason: "too_long" });
  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (!email) bad.push({ field: "email", reason: "required" });
  else if (email.length > BUYER_EMAIL_MAX || !EMAIL_RE.test(email)) bad.push({ field: "email", reason: "invalid" });

  let origin = "";
  try {
    const u = new URL(typeof b.origin === "string" ? b.origin : "");
    if (u.protocol === "https:" || u.protocol === "http:") origin = u.origin;
  } catch {
    // fallthrough
  }
  if (!origin) bad.push({ field: "origin", reason: "invalid" });

  const answers = parseAnswers(b.answers, fields, bad);
  const rawCoupon = typeof b.couponCode === "string" ? b.couponCode.trim() : "";
  const couponCode = rawCoupon ? normalizeCouponCode(rawCoupon) : null;
  if (rawCoupon && !couponCode) bad.push({ field: "couponCode", reason: "invalid" });
  if (bad.length > 0) throw errors.validationFailed(bad);
  const clientKey = typeof b.clientKey === "string" && CLIENT_KEY_RE.test(b.clientKey) ? b.clientKey : null;
  return { items, name, email, answers, origin, clientKey, couponCode };
}

/** Answers to the configured custom fields (label snapshot kept). Problems go to `bad`. */
export function parseAnswers(raw: unknown, fields: readonly LpTicketField[], bad: FieldError[]): LpTicketAnswer[] {
  const rawAnswers = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const answers: LpTicketAnswer[] = [];
  for (const f of fields) {
    const v0 = rawAnswers[f.id];
    const value = typeof v0 === "string" ? v0.trim() : "";
    const key = `answers.${f.id}`;
    if (f.required && value === "") bad.push({ field: key, reason: "required" });
    else if (value.length > ANSWER_MAX[f.type]) bad.push({ field: key, reason: "too_long" });
    else if (value !== "" && f.type === "select" && !f.options.includes(value)) bad.push({ field: key, reason: "invalid" });
    else if (value !== "" && f.type === "checkbox" && value !== CHECKBOX_YES) bad.push({ field: key, reason: "invalid" });
    answers.push({ fieldId: f.id, label: f.label, value });
  }
  return answers;
}

export function statsFor(t: Pick<LpTicketType, "capacity">, agg: TicketTypeAgg | undefined): LpTicketTypeStats {
  const sold = agg?.sold ?? 0;
  const pending = agg?.pending ?? 0;
  return {
    sold,
    pending,
    revenueJpy: agg?.revenueJpy ?? 0,
    remaining: t.capacity === null ? null : Math.max(0, t.capacity - sold - pending),
  };
}

/** JST midnight of the day containing `iso`, as a UTC ISO string (comparable to created_at). */
export function jstDayStartIso(iso: string): string {
  return new Date(`${dayJst(iso)}T00:00:00+09:00`).toISOString();
}

export function orderCursor(o: { createdAt: string; id: string }): string {
  return `${o.createdAt}~${o.id}`;
}

const sortTypes = (a: TicketTypeRow, b: TicketTypeRow): number =>
  a.sortOrder - b.sortOrder || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

const toType = ({ site: _s, ...t }: TicketTypeRow): LpTicketType => t;
const toOrder = ({
  site: _s,
  stripeSessionId: _ss,
  paymentIntentId: _pi,
  refundedAt: _ra,
  resolvedBy: _rb,
  resolvedAt: _rt,
  clientKey: _ck,
  ...o
}: TicketOrderRow): LpTicketOrder => o;

const toCoupon = ({ site: _s, ...c }: TicketCouponRow, used: number): LpTicketCoupon => ({ ...c, used });

/** 409: not enough seats left for one of the items (contract: sold_out). */
export const soldOut = (ticketTypeId: string): DubError =>
  new DubError("LP_TICKET_SOLD_OUT", "このチケットは残りが足りません", {
    status: 409,
    details: { reason: "sold_out", ticketTypeId },
  });

/** "一般 Day 1 ×2、学生 Day 2 ×1" — the thanks page line. */
export function orderSummary(items: readonly LpTicketOrderItem[]): string {
  return items.map((i) => `${i.dayLabel ? `${i.ticketTypeName} ${i.dayLabel}` : i.ticketTypeName} ×${i.quantity}`).join("、");
}
/** 409: the coupon has no uses left for this quantity (contract: coupon_used_up). */
export const couponUsedUp = (): DubError =>
  new DubError("LP_TICKET_COUPON_USED_UP", "このクーポンは使用上限に達しています", {
    status: 409,
    details: { reason: "coupon_used_up" },
  });
/** One answer for unknown / paused / expired codes and paused target types: no hint which it was. */
const couponInvalid = (): DubError => errors.validationFailed([{ field: "couponCode", reason: "invalid" }]);

/** 503: STRIPE_SECRET_KEY not configured (contract: payment_not_configured). */
export const paymentNotConfigured = (): DubError =>
  new DubError("LP_PAYMENT_NOT_CONFIGURED", "決済は準備中です", {
    status: 503,
    retryable: false,
    details: { reason: "payment_not_configured" },
  });

export interface PublicTicketType {
  id: string;
  name: string;
  description: string;
  priceJpy: number;
  dayLabel: string;
  maxPerOrder: number;
  /** Left after paid + held. null = no capacity. */
  remaining: number | null;
  soldOut: boolean;
  /** 0-yen type: only bought with a coupon code (the LP hides it from the normal list). */
  couponOnly: boolean;
}

export interface PublicCoupon {
  ticketTypeId: string;
  /** Tickets this code can still get. */
  remainingUses: number;
}

export interface ConfirmResult {
  status: LpTicketOrderStatus | "unknown";
  summary?: string;
}

export class TicketService {
  constructor(private readonly deps: AppDeps) {}

  private get repo() {
    return this.deps.repo;
  }

  private pendingSince(): string {
    return new Date(Date.parse(this.deps.now()) - PENDING_HOLD_MS).toISOString();
  }

  private async summaries(): Promise<LpTicketTypeSummary[]> {
    const [types, aggs] = await Promise.all([
      this.repo.listTicketTypes(TICKET_SITE),
      this.repo.ticketAggregates(TICKET_SITE, this.pendingSince()),
    ]);
    const byId = new Map(aggs.map((a) => [a.ticketTypeId, a]));
    return types.sort(sortTypes).map((t) => ({ ...toType(t), stats: statsFor(t, byId.get(t.id)) }));
  }

  private async summary(row: TicketTypeRow): Promise<LpTicketTypeSummary> {
    const aggs = await this.repo.ticketAggregates(TICKET_SITE, this.pendingSince());
    return { ...toType(row), stats: statsFor(row, aggs.find((a) => a.ticketTypeId === row.id)) };
  }

  async getState(): Promise<LpTicketsState> {
    const [settings, types] = await Promise.all([this.repo.getTicketSettings(TICKET_SITE), this.summaries()]);
    return {
      site: TICKET_SITE,
      enabled: settings?.enabled ?? false,
      ctaEnabled: settings?.ctaEnabled ?? false,
      paymentReady: this.deps.stripe !== null,
      publicUrl: `${this.deps.lpBaseUrl.replace(/\/+$/, "")}/tickets`,
      fields: settings?.fields ?? [],
      types,
      totals: types.reduce((t, x) => ({ sold: t.sold + x.stats.sold, revenueJpy: t.revenueJpy + x.stats.revenueJpy }), {
        sold: 0,
        revenueJpy: 0,
      }),
      updatedAt: settings?.updatedAt ?? null,
      updatedBy: settings?.updatedBy ?? null,
    };
  }

  async setEnabled(ctx: ReqCtx, body: unknown): Promise<LpTicketsState> {
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") throw errors.validationFailed([{ field: "enabled", reason: "required" }]);
    await this.repo.setTicketEnabled(TICKET_SITE, enabled, ctx.userId, this.deps.now());
    return this.getState();
  }

  async setCta(ctx: ReqCtx, body: unknown): Promise<LpTicketsState> {
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") throw errors.validationFailed([{ field: "enabled", reason: "required" }]);
    await this.repo.setTicketCta(TICKET_SITE, enabled, ctx.userId, this.deps.now());
    return this.getState();
  }

  async setFields(ctx: ReqCtx, body: unknown): Promise<LpTicketsState> {
    await this.repo.setTicketFields(TICKET_SITE, parseFields(body), ctx.userId, this.deps.now());
    return this.getState();
  }

  async createType(body: unknown): Promise<LpTicketTypeSummary> {
    const input = parseTicketTypeInput(body, false);
    const existing = await this.repo.listTicketTypes(TICKET_SITE);
    const now = this.deps.now();
    const row: TicketTypeRow = {
      id: this.deps.newTicketTypeId(),
      site: TICKET_SITE,
      ...input,
      sortOrder: existing.reduce((m, t) => Math.max(m, t.sortOrder + 1), 0),
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertTicketType(row);
    return this.summary(row);
  }

  async patchType(id: string, body: unknown): Promise<LpTicketTypeSummary> {
    const patch = parseTicketTypeInput(body, true);
    const cur = await this.repo.getTicketType(TICKET_SITE, id);
    if (!cur) throw errors.notFound("lp_ticket_type", id);
    const row: TicketTypeRow = { ...cur, ...patch, updatedAt: this.deps.now() };
    await this.repo.updateTicketType(row);
    return this.summary(row);
  }

  async listOrders(q: { cursor?: string; limit?: string }): Promise<LpTicketOrdersPage> {
    const parsed = Number(q.limit ?? DEFAULT_ORDERS_PAGE);
    const limit = Number.isFinite(parsed) ? Math.min(MAX_ORDERS_PAGE, Math.max(1, Math.floor(parsed))) : DEFAULT_ORDERS_PAGE;
    const rows = await this.repo.listOrders(TICKET_SITE, q.cursor || null, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toOrder),
      nextCursor: rows.length > limit && page.length > 0 ? orderCursor(page[page.length - 1]!) : null,
    };
  }

  // ---- internal (public LP Worker) ----

  async getPublic(): Promise<{
    enabled: boolean;
    ctaEnabled: boolean;
    paymentReady: boolean;
    fields: LpTicketField[];
    types: PublicTicketType[];
  }> {
    const [settings, types] = await Promise.all([this.repo.getTicketSettings(TICKET_SITE), this.summaries()]);
    return {
      enabled: settings?.enabled ?? false,
      ctaEnabled: settings?.ctaEnabled ?? false,
      paymentReady: this.deps.stripe !== null,
      fields: settings?.fields ?? [],
      types: types
        .filter((t) => t.active)
        .map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          priceJpy: t.priceJpy,
          dayLabel: t.dayLabel,
          maxPerOrder: t.maxPerOrder,
          remaining: t.stats.remaining,
          soldOut: t.stats.remaining === 0,
          couponOnly: t.priceJpy === 0,
        })),
    };
  }

  async checkout(body: unknown): Promise<{ redirectUrl: string }> {
    const settings = await this.repo.getTicketSettings(TICKET_SITE);
    if (!settings?.enabled) throw errors.notFound("lp_tickets");
    const input = parseCheckout(body, settings.fields);
    const types = new Map((await this.repo.listTicketTypes(TICKET_SITE)).map((t) => [t.id, t]));
    const now = this.deps.now();
    // A coupon order is exactly one line of the coupon's type at 0 yen: it never mixes with paid
    // items, so a coupon can never touch the Stripe path (no partial discounts to get wrong).
    const coupon = input.couponCode ? await this.usableCoupon(input.couponCode, types, now) : null;
    if (coupon && (input.items.length !== 1 || input.items[0]!.ticketTypeId !== coupon.ticketTypeId)) {
      throw errors.validationFailed([{ field: "couponCode", reason: "not_applicable" }]);
    }
    const bad: FieldError[] = [];
    const items: LpTicketOrderItem[] = [];
    for (const i of input.items) {
      const t = types.get(i.ticketTypeId);
      if (!t || !t.active) bad.push({ field: `items.${i.ticketTypeId}`, reason: "unavailable" });
      else if (i.quantity > t.maxPerOrder) bad.push({ field: `items.${i.ticketTypeId}`, reason: "too_many" });
      else if (!coupon && t.priceJpy === 0) bad.push({ field: `items.${i.ticketTypeId}`, reason: "coupon_required" });
      else
        items.push({
          ticketTypeId: t.id,
          ticketTypeName: t.name,
          dayLabel: t.dayLabel,
          unitPriceJpy: coupon ? 0 : t.priceJpy,
          quantity: i.quantity,
        });
    }
    if (bad.length > 0) throw errors.validationFailed(bad);
    const amountJpy = items.reduce((n, i) => n + i.unitPriceJpy * i.quantity, 0);
    const free = amountJpy === 0;
    const stripe = this.deps.stripe;
    if (!free && !stripe) throw paymentNotConfigured();

    if ((await this.repo.countOrdersSince(TICKET_SITE, jstDayStartIso(now))) >= this.deps.dailyCheckoutCap) {
      throw errors.rateLimited(60);
    }
    const quantity = items.reduce((n, i) => n + i.quantity, 0);
    if (
      !free &&
      input.clientKey &&
      (await this.repo.heldPendingByClient(TICKET_SITE, input.clientKey, this.pendingSince())) + quantity > PER_CLIENT_HELD_MAX
    ) {
      throw errors.rateLimited(60);
    }

    const row: TicketOrderRow = {
      id: this.deps.newOrderId(),
      site: TICKET_SITE,
      items,
      quantity,
      amountJpy,
      status: free ? "paid" : "pending",
      buyerName: input.name,
      buyerEmail: input.email,
      answers: input.answers,
      stripeSessionId: null,
      createdAt: now,
      paidAt: free ? now : null,
      paymentIntentId: null,
      refundedAt: null,
      reviewReason: null,
      resolvedBy: null,
      resolvedAt: null,
      clientKey: input.clientKey,
      couponId: coupon?.id ?? null,
    };
    const capacities = new Map(items.map((i) => [i.ticketTypeId, types.get(i.ticketTypeId)!.capacity]));
    const held = await this.repo.insertOrderIfAvailable(row, capacities, this.pendingSince());
    if (!held.ok) {
      if (held.reason === "coupon_used_up") throw couponUsedUp();
      throw soldOut(held.ticketTypeId);
    }
    if (coupon) log("info", "lp ticket coupon used", { orderId: row.id, couponId: coupon.id, quantity });
    if (free || !stripe) return { redirectUrl: `${input.origin}/tickets/thanks?order=${encodeURIComponent(row.id)}` };

    let session: CheckoutSession;
    try {
      session = await stripe.createCheckoutSession({
        orderId: row.id,
        lineItems: items
          .filter((i) => i.unitPriceJpy > 0)
          .map((i) => ({
            name: i.dayLabel ? `${i.ticketTypeName}（${i.dayLabel}）` : i.ticketTypeName,
            unitAmountJpy: i.unitPriceJpy,
            quantity: i.quantity,
          })),
        customerEmail: input.email,
        successUrl: `${input.origin}/tickets/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${input.origin}/tickets?canceled=1`,
        expiresAt: Math.floor(Date.parse(now) / 1000) + CHECKOUT_TTL_SEC,
      });
      if (!session.id || !session.url) throw errors.upstreamUnavailable("stripe", new Error("session without id/url"));
    } catch (e) {
      // Release the held seat right away instead of waiting out the hold window.
      await this.repo.markOrderExpired(row.id);
      throw e;
    }
    // The buyer only gets the payment URL once the session is stored: if this write throws, nobody
    // can pay this session, so there is no "money taken, order unknown" state to reconcile.
    await this.repo.setOrderSession(row.id, session.id);
    await this.armReconcile();
    return { redirectUrl: session.url };
  }

  /** The coupon behind a normalized code, or 400 couponCode invalid (unknown / paused / expired / type off). */
  private async usableCoupon(code: string, types: ReadonlyMap<string, TicketTypeRow>, now: string): Promise<TicketCouponRow> {
    const c = await this.repo.getCouponByCode(TICKET_SITE, code);
    const t = c ? types.get(c.ticketTypeId) : undefined;
    if (!c || !c.active || (c.expiresAt !== null && c.expiresAt <= now) || !t || !t.active) {
      log("warn", "lp ticket coupon rejected", { found: c !== null });
      throw couponInvalid();
    }
    return c;
  }

  /** Public LP: what a code unlocks, before the buyer fills the form. Same rules as checkout. */
  async checkCoupon(body: unknown): Promise<PublicCoupon> {
    const settings = await this.repo.getTicketSettings(TICKET_SITE);
    if (!settings?.enabled) throw errors.notFound("lp_tickets");
    const code = normalizeCouponCode((body as { code?: unknown } | null)?.code);
    if (!code) throw couponInvalid();
    const types = new Map((await this.repo.listTicketTypes(TICKET_SITE)).map((t) => [t.id, t]));
    const c = await this.usableCoupon(code, types, this.deps.now());
    const used = (await this.repo.couponUses(TICKET_SITE, this.pendingSince())).get(c.id) ?? 0;
    const remainingUses = Math.max(0, c.maxUses - used);
    if (remainingUses === 0) throw couponUsedUp();
    return { ticketTypeId: c.ticketTypeId, remainingUses };
  }

  async listCoupons(): Promise<LpTicketCouponsPage> {
    const [rows, uses] = await Promise.all([
      this.repo.listCoupons(TICKET_SITE),
      this.repo.couponUses(TICKET_SITE, this.pendingSince()),
    ]);
    return { items: rows.map((r) => toCoupon(r, uses.get(r.id) ?? 0)) };
  }

  async createCoupon(ctx: ReqCtx, body: unknown): Promise<LpTicketCoupon> {
    const now = this.deps.now();
    const input = parseCouponInput(body, now);
    if (!(await this.repo.getTicketType(TICKET_SITE, input.ticketTypeId))) {
      throw errors.validationFailed([{ field: "ticketTypeId", reason: "unknown" }]);
    }
    // A collision in ~8e14 codes is practically impossible; retry instead of failing if it happens.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row: TicketCouponRow = {
        id: this.deps.newCouponId(),
        site: TICKET_SITE,
        code: generateCouponCode(),
        ...input,
        active: true,
        createdBy: ctx.userId,
        createdAt: now,
        updatedAt: now,
      };
      if (await this.repo.insertCoupon(row)) {
        log("info", "lp ticket coupon created", { couponId: row.id, ticketTypeId: row.ticketTypeId, maxUses: row.maxUses, by: ctx.userId });
        return toCoupon(row, 0);
      }
    }
    throw errors.conflict("クーポンコードを作れませんでした。もう一度お試しください", { reason: "code_collision" });
  }

  async setCouponActive(ctx: ReqCtx, id: string, body: unknown): Promise<LpTicketCoupon> {
    const active = (body as { active?: unknown } | null)?.active;
    if (typeof active !== "boolean") throw errors.validationFailed([{ field: "active", reason: "required" }]);
    if (!(await this.repo.setCouponActive(TICKET_SITE, id, active, this.deps.now()))) throw errors.notFound("lp_ticket_coupon", id);
    log("info", "lp ticket coupon toggled", { couponId: id, active, by: ctx.userId });
    const row = (await this.repo.getCoupon(TICKET_SITE, id))!;
    const used = (await this.repo.couponUses(TICKET_SITE, this.pendingSince())).get(id) ?? 0;
    return toCoupon(row, used);
  }

  /** Best effort: a failure to arm must never fail a checkout (the next paid checkout retries). */
  private async armReconcile(): Promise<void> {
    if (!this.deps.armReconcile) return;
    try {
      await this.deps.armReconcile();
    } catch (e) {
      log("error", "lp ticket reconcile alarm could not be armed", { error: String(e) });
    }
  }

  /**
   * LP管理: a human resolves needs_review as paid (after checking the money in the Stripe dashboard).
   * The only other way out is a refund in Stripe (webhook -> refunded): there is deliberately no
   * "cancel" here, since that would keep the money with no ticket.
   */
  async approve(ctx: ReqCtx, id: string): Promise<LpTicketOrder> {
    const order = await this.repo.getOrder(TICKET_SITE, id);
    if (!order) throw errors.notFound("lp_ticket_order", id);
    // An open dispute is decided by Stripe (dispute.closed settles it automatically), not by us.
    if (order.status === "needs_review" && order.reviewReason === "dispute") {
      throw errors.conflict("チャージバックの審理中です。結果は Stripe から自動で反映されます", { reason: "dispute_open" });
    }
    if (!(await this.repo.approveOrder(id, ctx.userId, this.deps.now()))) {
      throw errors.conflict("この注文は要確認ではありません", { reason: "not_needs_review", status: order.status });
    }
    log("warn", "lp ticket needs_review approved", { orderId: id, by: ctx.userId, reviewReason: order.reviewReason });
    return toOrder((await this.repo.getOrder(TICKET_SITE, id))!);
  }

  /** thanks page: by Stripe session (paid) or order id (free). Idempotent. */
  async confirm(body: unknown): Promise<ConfirmResult> {
    const b = (body ?? {}) as { sessionId?: unknown; orderId?: unknown };
    const sessionId = typeof b.sessionId === "string" ? b.sessionId.trim() : "";
    const orderId = typeof b.orderId === "string" ? b.orderId.trim() : "";
    if (!sessionId && !orderId) throw errors.validationFailed([{ field: "sessionId", reason: "required" }]);

    let order = sessionId
      ? await this.repo.getOrderBySession(sessionId)
      : await this.repo.getOrder(TICKET_SITE, orderId);
    if (!order) return { status: "unknown" };
    if (order.status === "pending" && sessionId && this.deps.stripe) {
      try {
        const s = await this.deps.stripe.getCheckoutSession(sessionId);
        await this.settle(order, s, { source: "confirm" });
        order = (await this.repo.getOrder(TICKET_SITE, order.id)) ?? order;
      } catch {
        // Stripe unreachable: answer the stored state; the webhook will settle it.
      }
    }
    return { status: order.status, summary: orderSummary(order.items) };
  }

  /**
   * The ONE settlement rule for webhook / confirm / reconcile.
   * - session mode must match the key mode (test never touches live and vice versa)
   * - paid only when payment_status=paid AND amount_total = order amount AND currency = jpy;
   *   a mismatch goes to needs_review (money may be taken; a human looks)
   * - paid wins: pending|expired -> paid; a late settle that no longer fits capacity -> needs_review "oversold"
   * - release (expired / async failed) only moves pending -> expired, never paid -> expired
   */
  private async settle(
    order: TicketOrderRow,
    s: CheckoutSession,
    o: { source: string; release?: boolean },
  ): Promise<SettleOutcome> {
    const ctx = { source: o.source, orderId: order.id, sessionId: s.id };
    const stripe = this.deps.stripe;
    if (!stripe || s.livemode !== stripe.livemode) {
      log("warn", "lp ticket settle ignored: livemode mismatch", { ...ctx, sessionLivemode: s.livemode });
      return "ignored";
    }
    if (order.status !== "pending" && order.status !== "expired") return "unchanged";
    if (s.paymentStatus === "paid") {
      const reason =
        s.currency !== "jpy" ? "currency_mismatch" : s.amountTotal !== order.amountJpy ? "amount_mismatch" : null;
      if (reason) {
        await this.repo.markOrderNeedsReview(order.id, reason, s.paymentIntentId);
        log("error", "lp ticket payment needs review", {
          ...ctx,
          reason,
          amountTotal: s.amountTotal,
          currency: s.currency,
          expectedJpy: order.amountJpy,
        });
        return "needs_review";
      }
      const late = order.status === "expired" || order.createdAt < this.pendingSince();
      const result = await this.repo.markOrderPaid(order.id, {
        paidAt: this.deps.now(),
        sessionId: s.id || null,
        paymentIntentId: s.paymentIntentId,
        ...(late ? { capacitySince: this.pendingSince() } : {}),
      });
      if (!result) return "unchanged";
      if (result === "needs_review") {
        log("error", "lp ticket paid after hold lapsed and over capacity", { ...ctx, reason: "oversold" });
        return "needs_review";
      }
      if (late) log("warn", "lp ticket settled paid after hold lapsed", ctx);
      return "paid";
    }
    if (o.release || s.status === "expired") {
      return (await this.repo.markOrderExpired(order.id)) ? "expired" : "unchanged";
    }
    return "unchanged";
  }

  /**
   * Cron safety net for a missing / misconfigured webhook: re-reads Stripe for pending orders and
   * settles them with the same rule. One failure never aborts the loop.
   */
  async reconcile(): Promise<ReconcileSummary> {
    const sum: ReconcileSummary = {
      checked: 0,
      paid: 0,
      needsReview: 0,
      expired: 0,
      unchanged: 0,
      ignored: 0,
      errors: 0,
      sessionlessExpired: await this.repo.expireSessionlessPending(TICKET_SITE, this.pendingSince()),
      paymentIntentBackfilled: 0,
    };
    const stripe = this.deps.stripe;
    if (stripe) {
      const nowMs = Date.parse(this.deps.now());
      const rows = await this.repo.listPendingWithSession(
        TICKET_SITE,
        new Date(nowMs - RECONCILE_MAX_AGE_MS).toISOString(),
        new Date(nowMs - RECONCILE_MIN_AGE_MS).toISOString(),
        RECONCILE_LIMIT,
      );
      const key = {
        paid: "paid",
        needs_review: "needsReview",
        expired: "expired",
        unchanged: "unchanged",
        ignored: "ignored",
      } as const satisfies Record<SettleOutcome, keyof ReconcileSummary>;
      for (const order of rows) {
        sum.checked++;
        try {
          const s = await stripe.getCheckoutSession(order.stripeSessionId!);
          sum[key[await this.settle(order, s, { source: "reconcile" })]]++;
        } catch (e) {
          sum.errors++;
          log("error", "lp ticket reconcile failed for order", { orderId: order.id, error: String(e) });
        }
      }
      // Orders paid before 0005 have no payment_intent_id: without it a refund / dispute webhook
      // cannot find them. Bounded per run; only sessions of the key's mode (cs_live_ / cs_test_) so
      // rows Stripe would 404 never clog the batch. The list empties once every order is filled.
      for (const order of await this.repo.listMissingPaymentIntent(TICKET_SITE, stripe.livemode, RECONCILE_LIMIT)) {
        try {
          const s = await stripe.getCheckoutSession(order.stripeSessionId!);
          if (s.livemode !== stripe.livemode || !s.paymentIntentId) continue;
          await this.repo.setOrderPaymentIntent(order.id, s.paymentIntentId);
          sum.paymentIntentBackfilled++;
        } catch (e) {
          sum.errors++;
          log("error", "lp ticket payment_intent backfill failed", { orderId: order.id, error: String(e) });
        }
      }
    }
    log(sum.errors > 0 || sum.needsReview > 0 ? "warn" : "info", "lp ticket reconcile finished", { ...sum });
    return sum;
  }

  /**
   * Matched by payment_intent. charge.refunded (full only) -> refunded; charge.dispute.created -> needs_review;
   * charge.dispute.closed: lost -> refunded (the money went back to the buyer), won / warning_closed -> paid again.
   */
  private async applyCharge(type: string, obj: Record<string, unknown>): Promise<void> {
    const pi = stripeId(obj.payment_intent);
    const order = pi ? await this.repo.getOrderByPaymentIntent(pi) : null;
    if (!order) {
      log("warn", "lp ticket charge event without a matching order", { type, paymentIntent: pi });
      return;
    }
    if (type === "charge.dispute.created") {
      await this.repo.markOrderNeedsReview(order.id, "dispute");
      log("error", "lp ticket payment disputed", { orderId: order.id, paymentIntent: pi });
      return;
    }
    if (type === "charge.dispute.closed") {
      const status = typeof obj.status === "string" ? obj.status : "";
      if (status === "lost") await this.repo.markOrderRefunded(order.id, this.deps.now());
      // warning_closed = an inquiry that never became a chargeback: the money stayed with us.
      else if (status === "won" || status === "warning_closed") await this.repo.approveOrder(order.id, "stripe", this.deps.now(), "dispute");
      log("warn", "lp ticket dispute closed", { orderId: order.id, paymentIntent: pi, status });
      return;
    }
    const amount = typeof obj.amount === "number" ? obj.amount : null;
    const refunded = typeof obj.amount_refunded === "number" ? obj.amount_refunded : 0;
    if (amount === null || refunded < amount) {
      log("info", "lp ticket partial refund: order unchanged", { orderId: order.id, amount, refunded });
      return;
    }
    await this.repo.markOrderRefunded(order.id, this.deps.now());
  }

  /** Stripe webhook (raw body). Bad / missing signature → 400. Unknown events / orders / other mode → ignored. */
  async webhook(rawBody: string, signature: string | undefined): Promise<{ received: true }> {
    const secret = this.deps.stripeWebhookSecret;
    const nowSec = Math.floor(Date.parse(this.deps.now()) / 1000);
    if (!secret || !(await verifyStripeSignature(signature, rawBody, secret, nowSec))) {
      throw errors.validationFailed([{ field: "stripe-signature", reason: "invalid" }]);
    }
    let event: { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: unknown } };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (!SESSION_EVENTS.has(type) && !CHARGE_EVENTS.has(type)) return { received: true };
    const stripe = this.deps.stripe;
    if (!stripe || event.livemode !== stripe.livemode) {
      log("warn", "lp ticket webhook ignored: livemode mismatch", { eventId: event.id, type, livemode: event.livemode });
      return { received: true };
    }
    // Any verified event also (re)arms the free-plan reconcile loop, so refunds / disputes on old
    // orders get their payment_intent backfilled even before the next paid checkout.
    await this.armReconcile();
    const obj = (event.data?.object ?? {}) as Record<string, unknown>;
    if (CHARGE_EVENTS.has(type)) {
      await this.applyCharge(type, obj);
      return { received: true };
    }
    const session = toCheckoutSession(obj);
    const metaOrder = (obj.metadata as Record<string, unknown> | undefined)?.order_id;
    const orderId = session.clientReferenceId ?? (typeof metaOrder === "string" ? metaOrder : null);
    const order =
      (orderId ? await this.repo.getOrder(TICKET_SITE, orderId) : null) ??
      (session.id ? await this.repo.getOrderBySession(session.id) : null);
    if (!order) return { received: true };
    await this.settle(order, session, { source: "webhook", release: RELEASE_EVENTS.has(type) });
    return { received: true };
  }
}
