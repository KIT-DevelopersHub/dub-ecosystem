// LP チケット購入: validation + TicketService (settings / types / orders / checkout / Stripe confirm).
// Prices always come from D1; the client never supplies an amount.
import { DubError, errors, type FieldError } from "@dub/errors";
import { lp } from "@dub/types";
import { dayJst } from "./domain";
import { toCheckoutSession, verifyStripeSignature, type CheckoutSession } from "./stripe";
import type {
  AppDeps,
  LpTicketAnswer,
  LpTicketField,
  LpTicketFieldType,
  LpTicketOrder,
  LpTicketOrderItem,
  LpTicketOrderStatus,
  LpTicketOrdersPage,
  LpTicketPaymentMethod,
  LpTicketsState,
  LpTicketType,
  LpTicketTypeInput,
  LpTicketTypeStats,
  LpTicketTypeSummary,
  ReqCtx,
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

/**
 * What the LP / LP管理 advertise. Stripe decides per session (dynamic payment methods): PayPay is
 * JPY one-time only, 50..1,000,000 JPY per payment, and is hidden by Stripe outside that.
 */
export function advertisedPaymentMethods(paypayEnabled: boolean): LpTicketPaymentMethod[] {
  return paypayEnabled ? ["card", "paypay"] : ["card"];
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
  if (bad.length > 0) throw errors.validationFailed(bad);
  return { items, name, email, answers, origin };
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
const toOrder = ({ site: _s, stripeSessionId: _ss, ...o }: TicketOrderRow): LpTicketOrder => o;

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
      paymentMethods: advertisedPaymentMethods(this.deps.paypayEnabled),
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
    paymentMethods: LpTicketPaymentMethod[];
    fields: LpTicketField[];
    types: PublicTicketType[];
  }> {
    const [settings, types] = await Promise.all([this.repo.getTicketSettings(TICKET_SITE), this.summaries()]);
    return {
      enabled: settings?.enabled ?? false,
      ctaEnabled: settings?.ctaEnabled ?? false,
      paymentReady: this.deps.stripe !== null,
      paymentMethods: advertisedPaymentMethods(this.deps.paypayEnabled),
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
        })),
    };
  }

  async checkout(body: unknown): Promise<{ redirectUrl: string }> {
    const settings = await this.repo.getTicketSettings(TICKET_SITE);
    if (!settings?.enabled) throw errors.notFound("lp_tickets");
    const input = parseCheckout(body, settings.fields);
    const types = new Map((await this.repo.listTicketTypes(TICKET_SITE)).map((t) => [t.id, t]));
    const bad: FieldError[] = [];
    const items: LpTicketOrderItem[] = [];
    for (const i of input.items) {
      const t = types.get(i.ticketTypeId);
      if (!t || !t.active) bad.push({ field: `items.${i.ticketTypeId}`, reason: "unavailable" });
      else if (i.quantity > t.maxPerOrder) bad.push({ field: `items.${i.ticketTypeId}`, reason: "too_many" });
      else
        items.push({
          ticketTypeId: t.id,
          ticketTypeName: t.name,
          dayLabel: t.dayLabel,
          unitPriceJpy: t.priceJpy,
          quantity: i.quantity,
        });
    }
    if (bad.length > 0) throw errors.validationFailed(bad);
    const amountJpy = items.reduce((n, i) => n + i.unitPriceJpy * i.quantity, 0);
    const free = amountJpy === 0;
    const stripe = this.deps.stripe;
    if (!free && !stripe) throw paymentNotConfigured();

    const now = this.deps.now();
    if ((await this.repo.countOrdersSince(TICKET_SITE, jstDayStartIso(now))) >= this.deps.dailyCheckoutCap) {
      throw errors.rateLimited(60);
    }

    const row: TicketOrderRow = {
      id: this.deps.newOrderId(),
      site: TICKET_SITE,
      items,
      quantity: items.reduce((n, i) => n + i.quantity, 0),
      amountJpy,
      status: free ? "paid" : "pending",
      buyerName: input.name,
      buyerEmail: input.email,
      answers: input.answers,
      stripeSessionId: null,
      createdAt: now,
      paidAt: free ? now : null,
      paymentMethod: null,
    };
    const capacities = new Map(items.map((i) => [i.ticketTypeId, types.get(i.ticketTypeId)!.capacity]));
    const held = await this.repo.insertOrderIfAvailable(row, capacities, this.pendingSince());
    if (!held.ok) throw soldOut(held.ticketTypeId);
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
    await this.repo.setOrderSession(row.id, session.id);
    return { redirectUrl: session.url };
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
        await this.applySession(order.id, s);
        order = (await this.repo.getOrder(TICKET_SITE, order.id)) ?? order;
      } catch {
        // Stripe unreachable: answer the stored state; the webhook will settle it.
      }
    }
    return { status: order.status, summary: orderSummary(order.items) };
  }

  /** Only payment_status "paid" settles: a completed-but-unpaid (async) session stays pending. */
  private async applySession(orderId: string, s: CheckoutSession): Promise<void> {
    if (s.paymentStatus === "paid") {
      await this.repo.markOrderPaid(orderId, this.deps.now(), s.id || null);
      if (s.paymentMethodType) {
        try {
          await this.repo.setOrderPaymentMethod(orderId, s.paymentMethodType);
        } catch {
          // Display-only (e.g. 0005 migration not applied yet): never block settling the order.
        }
      }
    } else if (s.status === "expired") await this.repo.markOrderExpired(orderId);
  }

  /** Webhook payloads don't expand payment_intent: fetch the used method (best effort, display only). */
  private async withPaymentMethod(s: CheckoutSession): Promise<CheckoutSession> {
    if (s.paymentMethodType || !this.deps.stripe || !s.id) return s;
    try {
      return { ...s, paymentMethodType: (await this.deps.stripe.getCheckoutSession(s.id)).paymentMethodType };
    } catch {
      return s;
    }
  }

  /** Stripe webhook (raw body). Bad / missing signature → 400. Unknown events / orders → ignored. */
  async webhook(rawBody: string, signature: string | undefined): Promise<{ received: true }> {
    const secret = this.deps.stripeWebhookSecret;
    const nowSec = Math.floor(Date.parse(this.deps.now()) / 1000);
    if (!secret || !(await verifyStripeSignature(signature, rawBody, secret, nowSec))) {
      throw errors.validationFailed([{ field: "stripe-signature", reason: "invalid" }]);
    }
    let event: { type?: unknown; data?: { object?: unknown } };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
    }
    if (!SESSION_EVENTS.has(event.type as string)) return { received: true };
    const obj = (event.data?.object ?? {}) as Record<string, unknown>;
    const session = toCheckoutSession(obj);
    const metaOrder = (obj.metadata as Record<string, unknown> | undefined)?.order_id;
    const orderId = session.clientReferenceId ?? (typeof metaOrder === "string" ? metaOrder : null);
    const order =
      (orderId ? await this.repo.getOrder(TICKET_SITE, orderId) : null) ??
      (session.id ? await this.repo.getOrderBySession(session.id) : null);
    if (!order) return { received: true };
    if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      await this.repo.markOrderExpired(order.id);
    }
    else await this.applySession(order.id, session.paymentStatus === "paid" ? await this.withPaymentMethod(session) : session);
    return { received: true };
  }
}
