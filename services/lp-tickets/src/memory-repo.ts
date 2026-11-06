// In-memory LpTicketRepo for tests — same semantics as the D1 repo.
import type {
  LpTicketField,
  LpTicketOrderStatus,
  LpTicketRepo,
  PaidSettlement,
  TicketOrderRow,
  TicketCouponRow,
  TicketSettingsRow,
  TicketTypeAgg,
  TicketTypeRow,
} from "./types";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryLpTicketRepo implements LpTicketRepo {
  ticketSettings = new Map<string, TicketSettingsRow>();
  ticketTypes: TicketTypeRow[] = [];
  orders: TicketOrderRow[] = [];
  coupons: TicketCouponRow[] = [];

  async getTicketSettings(site: string) {
    const r = this.ticketSettings.get(site);
    return r ? clone(r) : null;
  }
  private upsertSettings(site: string, patch: Partial<TicketSettingsRow>, updatedBy: string, updatedAt: string) {
    const cur = this.ticketSettings.get(site) ?? { site, enabled: false, ctaEnabled: false, fields: [], updatedBy: null, updatedAt };
    this.ticketSettings.set(site, { ...cur, ...clone(patch), updatedBy, updatedAt });
  }
  async setTicketEnabled(site: string, enabled: boolean, updatedBy: string, updatedAt: string) {
    this.upsertSettings(site, { enabled }, updatedBy, updatedAt);
  }
  async setTicketCta(site: string, ctaEnabled: boolean, updatedBy: string, updatedAt: string) {
    this.upsertSettings(site, { ctaEnabled }, updatedBy, updatedAt);
  }
  async setTicketFields(site: string, fields: LpTicketField[], updatedBy: string, updatedAt: string) {
    this.upsertSettings(site, { fields }, updatedBy, updatedAt);
  }
  async setTicketRelease(site: string, enabled: boolean, ctaEnabled: boolean, updatedBy: string, updatedAt: string) {
    const t = this.ticketSettings.get(site);
    if (!t || t.enabled !== enabled || t.ctaEnabled !== ctaEnabled) this.upsertSettings(site, { enabled, ctaEnabled }, updatedBy, updatedAt);
  }
  async listTicketTypes(site: string) {
    return this.ticketTypes.filter((t) => t.site === site).map(clone);
  }
  async getTicketType(site: string, id: string) {
    const t = this.ticketTypes.find((x) => x.site === site && x.id === id);
    return t ? clone(t) : null;
  }
  async insertTicketType(row: TicketTypeRow) {
    this.ticketTypes.push(clone(row));
  }
  async updateTicketType(row: TicketTypeRow) {
    const i = this.ticketTypes.findIndex((x) => x.site === row.site && x.id === row.id);
    if (i >= 0) this.ticketTypes[i] = clone(row);
  }
  private isHeld(o: TicketOrderRow, pendingSince: string): boolean {
    return o.status === "paid" || o.status === "needs_review" || (o.status === "pending" && o.createdAt >= pendingSince);
  }
  private held(site: string, ticketTypeId: string, pendingSince: string): number {
    return this.orders
      .filter((o) => o.site === site && this.isHeld(o, pendingSince))
      .flatMap((o) => o.items)
      .filter((i) => i.ticketTypeId === ticketTypeId)
      .reduce((n, i) => n + i.quantity, 0);
  }
  async ticketAggregates(site: string, pendingSince: string) {
    const m = new Map<string, TicketTypeAgg>();
    for (const o of this.orders.filter((x) => x.site === site && ["paid", "needs_review", "pending"].includes(x.status))) {
      for (const i of o.items) {
        const a = m.get(i.ticketTypeId) ?? { ticketTypeId: i.ticketTypeId, sold: 0, pending: 0, revenueJpy: 0 };
        if (o.status === "paid") {
          a.sold += i.quantity;
          a.revenueJpy += i.quantity * i.unitPriceJpy;
        } else if (this.isHeld(o, pendingSince)) a.pending += i.quantity;
        m.set(i.ticketTypeId, a);
      }
    }
    return [...m.values()];
  }
  async heldPendingByClient(site: string, clientKey: string, pendingSince: string) {
    return this.orders
      .filter((o) => o.site === site && o.clientKey === clientKey && o.status === "pending" && o.createdAt >= pendingSince)
      .reduce((n, o) => n + o.quantity, 0);
  }
  async insertOrderIfAvailable(row: TicketOrderRow, capacities: ReadonlyMap<string, number | null>, pendingSince: string) {
    const short = row.items.find((i) => {
      const capacity = capacities.get(i.ticketTypeId) ?? null;
      return capacity !== null && this.held(row.site, i.ticketTypeId, pendingSince) + i.quantity > capacity;
    });
    if (row.couponId !== null) {
      const c = this.coupons.find((x) => x.site === row.site && x.id === row.couponId);
      const fits =
        c !== undefined &&
        c.active &&
        row.items.length === 1 &&
        row.items[0]!.ticketTypeId === c.ticketTypeId &&
        (c.expiresAt === null || c.expiresAt > row.createdAt) &&
        this.usedBy(c.id, pendingSince) + row.quantity <= c.maxUses;
      if (!fits) return { ok: false as const, reason: "coupon_used_up" as const };
    }
    if (short) return { ok: false as const, reason: "sold_out" as const, ticketTypeId: short.ticketTypeId };
    this.orders.push(clone(row));
    return { ok: true as const };
  }
  private usedBy(couponId: string, pendingSince: string): number {
    return this.orders
      .filter((o) => o.couponId === couponId && this.isHeld(o, pendingSince))
      .reduce((n, o) => n + o.quantity, 0);
  }
  async insertCoupon(row: TicketCouponRow) {
    if (this.coupons.some((x) => x.site === row.site && x.code === row.code)) return false;
    this.coupons.push(clone(row));
    return true;
  }
  async getCoupon(site: string, id: string) {
    const c = this.coupons.find((x) => x.site === site && x.id === id);
    return c ? clone(c) : null;
  }
  async getCouponByCode(site: string, code: string) {
    const c = this.coupons.find((x) => x.site === site && x.code === code);
    return c ? clone(c) : null;
  }
  async setCouponActive(site: string, id: string, active: boolean, updatedAt: string) {
    const c = this.coupons.find((x) => x.site === site && x.id === id);
    if (!c) return false;
    Object.assign(c, { active, updatedAt });
    return true;
  }
  async listCoupons(site: string) {
    return this.coupons
      .filter((c) => c.site === site)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
      .map(clone);
  }
  async couponUses(site: string, pendingSince: string) {
    const m = new Map<string, number>();
    for (const c of this.coupons.filter((x) => x.site === site)) {
      const n = this.usedBy(c.id, pendingSince);
      if (n > 0) m.set(c.id, n);
    }
    return m;
  }
  async getOrder(site: string, id: string) {
    const o = this.orders.find((x) => x.site === site && x.id === id);
    return o ? clone(o) : null;
  }
  async getOrderBySession(sessionId: string) {
    const o = this.orders.find((x) => x.stripeSessionId === sessionId);
    return o ? clone(o) : null;
  }
  async setOrderSession(id: string, sessionId: string) {
    const o = this.orders.find((x) => x.id === id);
    if (o) o.stripeSessionId = sessionId;
  }
  async getOrderByPaymentIntent(paymentIntentId: string) {
    const o = this.orders.find((x) => x.paymentIntentId === paymentIntentId);
    return o ? clone(o) : null;
  }
  private transition(id: string, from: readonly LpTicketOrderStatus[], patch: Partial<TicketOrderRow>): boolean {
    const o = this.orders.find((x) => x.id === id && from.includes(x.status));
    if (!o) return false;
    Object.assign(o, patch);
    return true;
  }
  async markOrderPaid(id: string, p: PaidSettlement) {
    const o = this.orders.find((x) => x.id === id);
    const since = p.capacitySince;
    const over =
      since !== undefined &&
      (o?.items ?? []).some((i) => {
        const cap = this.ticketTypes.find((t) => t.id === i.ticketTypeId)?.capacity ?? null;
        const others = this.orders
          .filter((x) => x.id !== id && this.isHeld(x, since))
          .flatMap((x) => x.items)
          .filter((x) => x.ticketTypeId === i.ticketTypeId)
          .reduce((n, x) => n + x.quantity, 0);
        return cap !== null && others + i.quantity > cap;
      });
    const status = over ? "needs_review" : "paid";
    const ok = this.transition(id, ["pending", "expired"], {
      status,
      paidAt: p.paidAt,
      stripeSessionId: o?.stripeSessionId ?? p.sessionId,
      paymentIntentId: o?.paymentIntentId ?? p.paymentIntentId,
      reviewReason: over ? "oversold" : null,
    });
    return ok ? status : null;
  }
  async markOrderPreview(id: string) {
    const o = this.orders.find((x) => x.id === id);
    if (o) o.preview = true;
  }
  async setOrderPaymentMethod(id: string, method: string) {
    const o = this.orders.find((x) => x.id === id);
    if (o) o.paymentMethod = method;
  }
  async markOrderExpired(id: string) {
    return this.transition(id, ["pending"], { status: "expired" });
  }
  async markOrderNeedsReview(id: string, reason: string, paymentIntentId: string | null = null) {
    const o = this.orders.find((x) => x.id === id);
    return this.transition(id, ["pending", "expired", "paid"], {
      status: "needs_review",
      reviewReason: reason,
      paymentIntentId: o?.paymentIntentId ?? paymentIntentId,
    });
  }
  async markOrderRefunded(id: string, refundedAt: string) {
    return this.transition(id, ["paid", "needs_review"], { status: "refunded", refundedAt });
  }
  async approveOrder(id: string, resolvedBy: string, resolvedAt: string, onlyReason?: string) {
    const o = this.orders.find((x) => x.id === id);
    if (!o || (onlyReason !== undefined && o.reviewReason !== onlyReason)) return false;
    return this.transition(id, ["needs_review"], { status: "paid", paidAt: o.paidAt ?? resolvedAt, resolvedBy, resolvedAt });
  }
  async setOrderPaymentIntent(id: string, paymentIntentId: string) {
    const o = this.orders.find((x) => x.id === id);
    if (o && o.paymentIntentId === null) o.paymentIntentId = paymentIntentId;
  }
  async listMissingPaymentIntent(site: string, livemode: boolean, limit: number) {
    const prefix = livemode ? "cs_live_" : "cs_test_";
    return this.orders
      .filter(
        (o) =>
          o.site === site &&
          (o.status === "paid" || o.status === "needs_review") &&
          o.stripeSessionId?.startsWith(prefix) &&
          !o.paymentIntentId,
      )
      .sort((a, b) => (`${a.createdAt}~${a.id}` < `${b.createdAt}~${b.id}` ? -1 : 1))
      .slice(0, limit)
      .map(clone);
  }
  async listPendingWithSession(site: string, from: string, to: string, limit: number) {
    return this.orders
      .filter((o) => o.site === site && o.status === "pending" && o.stripeSessionId && o.createdAt >= from && o.createdAt < to)
      .sort((a, b) => (`${a.createdAt}~${a.id}` < `${b.createdAt}~${b.id}` ? -1 : 1))
      .slice(0, limit)
      .map(clone);
  }
  async expireSessionlessPending(site: string, before: string) {
    let n = 0;
    for (const o of this.orders) {
      if (o.site === site && o.status === "pending" && !o.stripeSessionId && o.createdAt < before) {
        o.status = "expired";
        n++;
      }
    }
    return n;
  }
  async listOrders(site: string, cursor: string | null, limit: number) {
    const key = (o: TicketOrderRow) => `${o.createdAt}~${o.id}`;
    return this.orders
      .filter((o) => o.site === site && (cursor ? key(o) < cursor : true))
      .sort((a, b) => (key(a) < key(b) ? 1 : -1))
      .slice(0, limit)
      .map(clone);
  }
}
