// In-memory LpRepo for tests — same semantics as the D1 repo (bots excluded unless asked,
// link aggregation skips untagged visits, visits newest-first by id).
import type {
  AggregateBy,
  AggregateQuery,
  AggregateRow,
  LinkRow,
  LpProposalStatus,
  LpRepo,
  LpTicketField,
  LpTicketOrderStatus,
  PaidSettlement,
  ProposalRow,
  ProposalSettingsRow,
  PublishRow,
  TicketOrderRow,
  TicketCouponRow,
  TicketSettingsRow,
  TicketTypeAgg,
  TicketTypeRow,
  VisitRow,
} from "./types";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryLpRepo implements LpRepo {
  links: LinkRow[] = [];
  visits: VisitRow[] = [];
  publish = new Map<string, PublishRow>();
  ticketSettings = new Map<string, TicketSettingsRow>();
  ticketTypes: TicketTypeRow[] = [];
  orders: TicketOrderRow[] = [];
  coupons: TicketCouponRow[] = [];
  proposalSettings = new Map<string, ProposalSettingsRow>();
  proposals: ProposalRow[] = [];

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
  async countOrdersSince(site: string, since: string) {
    return this.orders.filter((o) => o.site === site && o.createdAt >= since).length;
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

  async getProposalSettings(site: string) {
    const r = this.proposalSettings.get(site);
    return r ? clone(r) : null;
  }
  private upsertProposalSettings(site: string, patch: Partial<ProposalSettingsRow>, updatedBy: string, updatedAt: string) {
    const cur = this.proposalSettings.get(site) ?? { site, enabled: false, fields: null, updatedBy: null, updatedAt };
    this.proposalSettings.set(site, { ...cur, ...clone(patch), updatedBy, updatedAt });
  }
  async setProposalEnabled(site: string, enabled: boolean, updatedBy: string, updatedAt: string) {
    this.upsertProposalSettings(site, { enabled }, updatedBy, updatedAt);
  }
  async setProposalFields(site: string, fields: LpTicketField[], updatedBy: string, updatedAt: string) {
    this.upsertProposalSettings(site, { fields }, updatedBy, updatedAt);
  }
  async insertProposal(row: ProposalRow) {
    this.proposals.push(clone(row));
  }
  async getProposal(site: string, id: string) {
    const p = this.proposals.find((x) => x.site === site && x.id === id);
    return p ? clone(p) : null;
  }
  async setProposalStatus(site: string, id: string, status: LpProposalStatus, reviewedBy: string, updatedAt: string) {
    const p = this.proposals.find((x) => x.site === site && x.id === id);
    if (!p) return false;
    Object.assign(p, { status, reviewedBy: status === "submitted" ? null : reviewedBy, updatedAt });
    return true;
  }
  async listProposals(site: string, cursor: string | null, limit: number) {
    const key = (p: ProposalRow) => `${p.createdAt}~${p.id}`;
    return this.proposals
      .filter((p) => p.site === site && (cursor ? key(p) < cursor : true))
      .sort((a, b) => (key(a) < key(b) ? 1 : -1))
      .slice(0, limit)
      .map(clone);
  }
  async proposalTotals(site: string) {
    const mine = this.proposals.filter((p) => p.site === site);
    return {
      total: mine.length,
      accepted: mine.filter((p) => p.status === "accepted").length,
      rejected: mine.filter((p) => p.status === "rejected").length,
    };
  }
  async countProposalsSince(site: string, since: string, clientKey?: string) {
    return this.proposals.filter(
      (p) => p.site === site && p.createdAt >= since && (!clientKey || p.clientKey === clientKey),
    ).length;
  }

  private inRange(v: VisitRow, q: Omit<AggregateQuery, "includeBots"> & { includeBots?: boolean }): boolean {
    return v.orgId === q.orgId && v.dayJst >= q.from && v.dayJst <= q.to && (q.includeBots === true || v.device !== "bot");
  }

  private agg(rows: VisitRow[], key: string): AggregateRow {
    const last = rows.reduce<string | null>((m, v) => (m === null || v.occurredAt > m ? v.occurredAt : m), null);
    return { key, visits: rows.length, uniques: new Set(rows.map((v) => v.visitorKey)).size, lastVisitAt: last };
  }

  async listLinks(orgId: string) {
    return this.links.filter((l) => l.orgId === orgId).map((l) => ({ ...l }));
  }
  async getLink(orgId: string, id: string) {
    return this.links.find((l) => l.orgId === orgId && l.id === id) ?? null;
  }
  async getLinkBySlug(orgId: string, slug: string) {
    return this.links.find((l) => l.orgId === orgId && l.slug === slug) ?? null;
  }
  async insertLink(row: LinkRow) {
    if (this.links.some((l) => l.orgId === row.orgId && l.slug === row.slug)) return false;
    this.links.push({ ...row });
    return true;
  }
  async setLinkActive(orgId: string, id: string, active: boolean, updatedAt: string) {
    const l = this.links.find((x) => x.orgId === orgId && x.id === id);
    if (l) Object.assign(l, { active, updatedAt });
  }
  recorded = new Map<string, number>();

  async insertVisit(row: VisitRow) {
    const dup = this.visits.some(
      (v) => v.visitorKey === row.visitorKey && v.dayJst === row.dayJst && v.source === row.source && v.path === row.path,
    );
    if (dup) return false;
    this.visits.push({ ...row });
    return true;
  }
  async recordedOn(dayJst: string) {
    return this.recorded.get(dayJst) ?? 0;
  }
  async bumpRecorded(dayJst: string) {
    this.recorded.set(dayJst, (this.recorded.get(dayJst) ?? 0) + 1);
  }
  async total(q: AggregateQuery) {
    return this.agg(this.visits.filter((v) => this.inRange(v, q)), "");
  }
  async countBots(q: Omit<AggregateQuery, "includeBots">) {
    return this.visits.filter((v) => this.inRange(v, { ...q, includeBots: true }) && v.device === "bot").length;
  }
  async aggregate(q: AggregateQuery, by: AggregateBy) {
    const keyOf = (v: VisitRow): string | null =>
      by === "source" ? v.source : by === "device" ? v.device : by === "day" ? v.dayJst : v.linkId;
    const groups = new Map<string, VisitRow[]>();
    for (const v of this.visits.filter((x) => this.inRange(x, q))) {
      const k = keyOf(v);
      if (k === null) continue;
      groups.set(k, [...(groups.get(k) ?? []), v]);
    }
    return [...groups.entries()].map(([k, rows]) => this.agg(rows, k));
  }
  async listVisits(q: { orgId: string; from: string; to: string; source?: string; cursor?: string; limit: number }) {
    return this.visits
      .filter((v) => this.inRange(v, q))
      .filter((v) => (q.source ? v.source === q.source : true))
      .filter((v) => (q.cursor ? `${v.dayJst}~${v.id}` < q.cursor : true))
      .sort((a, b) => (`${a.dayJst}~${a.id}` < `${b.dayJst}~${b.id}` ? 1 : -1))
      .slice(0, q.limit);
  }
  async getPublish(site: string) {
    const r = this.publish.get(site);
    return r ? { ...r } : null;
  }
  async setPublish(site: string, versionId: string, updatedBy: string, updatedAt: string) {
    this.publish.set(site, { site, versionId, updatedBy, updatedAt });
  }
}
