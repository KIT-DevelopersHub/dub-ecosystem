// D1-backed LpTicketRepo on the dedicated dub-tickets DB. Tables keep their lp_ticket_* names, so
// namespace `lp_*` (enforced by @dub/db strict client) still fits.
import type { DbClient } from "@dub/db";
import type {
  LpTicketAnswer,
  LpTicketField,
  LpTicketOrderItem,
  LpTicketOrderStatus,
  LpTicketRepo,
  OutboxKind,
  OutboxRow,
  TicketOrderRow,
  TicketCouponRow,
  TicketRow,
  TicketTypeRow,
} from "./types";

interface TicketTypeDbRow {
  id: string;
  site: string;
  name: string;
  description: string;
  price_jpy: number;
  capacity: number | null;
  day_label: string;
  max_per_order: number;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
interface TicketOrderDbRow {
  id: string;
  site: string;
  quantity: number;
  amount_jpy: number;
  status: string;
  buyer_name: string;
  buyer_email: string;
  answers_json: string;
  stripe_session_id: string | null;
  created_at: string;
  paid_at: string | null;
  payment_intent_id: string | null;
  refunded_at: string | null;
  review_reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  client_key: string | null;
  /** 0005 migration. Absent (undefined) before it is applied. */
  payment_method?: string | null;
  /** 0006 migration. 1 = created from an LP管理 preview. */
  preview?: number | null;
  coupon_id: string | null;
}
interface TicketCouponDbRow {
  id: string;
  site: string;
  code: string;
  label: string;
  ticket_type_id: string;
  max_uses: number;
  expires_at: string | null;
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface TicketItemDbRow {
  order_id: string;
  ticket_type_id: string;
  ticket_type_name: string;
  day_label: string;
  unit_price_jpy: number;
  quantity: number;
}

interface TicketDbRow {
  id: string;
  order_id: string;
  ticket_type_id: string;
  ticket_type_name: string;
  day_label: string;
  status: string;
  created_at: string;
  voided_at: string | null;
}
interface OutboxDbRow {
  id: string;
  order_id: string;
  kind: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function parseCursor(raw: string): { day: string; id: string } | null {
  const i = raw.indexOf("~");
  return i > 0 ? { day: raw.slice(0, i), id: raw.slice(i + 1) } : null;
}

const toTicketType = (r: TicketTypeDbRow): TicketTypeRow => ({
  id: r.id,
  site: r.site,
  name: r.name,
  description: r.description,
  priceJpy: r.price_jpy,
  capacity: r.capacity,
  dayLabel: r.day_label,
  maxPerOrder: r.max_per_order,
  active: r.active === 1,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toItem = (r: TicketItemDbRow): LpTicketOrderItem => ({
  ticketTypeId: r.ticket_type_id,
  ticketTypeName: r.ticket_type_name,
  dayLabel: r.day_label,
  unitPriceJpy: r.unit_price_jpy,
  quantity: r.quantity,
});

const toTicketOrder = (r: TicketOrderDbRow, items: LpTicketOrderItem[]): TicketOrderRow => ({
  id: r.id,
  site: r.site,
  items,
  quantity: r.quantity,
  amountJpy: r.amount_jpy,
  status: r.status as LpTicketOrderStatus,
  buyerName: r.buyer_name,
  buyerEmail: r.buyer_email,
  answers: parseJsonArray<LpTicketAnswer>(r.answers_json),
  stripeSessionId: r.stripe_session_id,
  createdAt: r.created_at,
  paidAt: r.paid_at,
  paymentIntentId: r.payment_intent_id ?? null,
  refundedAt: r.refunded_at ?? null,
  reviewReason: r.review_reason ?? null,
  resolvedBy: r.resolved_by ?? null,
  resolvedAt: r.resolved_at ?? null,
  clientKey: r.client_key ?? null,
  paymentMethod: r.payment_method ?? null,
  preview: r.preview === 1,
  couponId: r.coupon_id ?? null,
});

const toCoupon = (r: TicketCouponDbRow): TicketCouponRow => ({
  id: r.id,
  site: r.site,
  code: r.code,
  label: r.label,
  ticketTypeId: r.ticket_type_id,
  maxUses: r.max_uses,
  expiresAt: r.expires_at,
  active: r.active === 1,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTicket = (r: TicketDbRow): TicketRow => ({
  id: r.id,
  orderId: r.order_id,
  ticketTypeId: r.ticket_type_id,
  ticketTypeName: r.ticket_type_name,
  dayLabel: r.day_label,
  status: r.status as TicketRow["status"],
  createdAt: r.created_at,
  voidedAt: r.voided_at,
});

const toOutbox = (r: OutboxDbRow): OutboxRow => ({
  id: r.id,
  orderId: r.order_id,
  kind: r.kind as OutboxKind,
  status: r.status as OutboxRow["status"],
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  sentAt: r.sent_at,
  createdAt: r.created_at,
});

/** Same order the drain and the memory repo use: every buyer mail before any ops copy. */
const outboxOrder = (a: OutboxRow, b: OutboxRow): number =>
  `${a.kind}~${a.nextAttemptAt}~${a.id}` < `${b.kind}~${b.nextAttemptAt}~${b.id}` ? -1 : 1;

// Seats held = items of paid / needs_review orders + of pending orders still inside the hold window (alias o).
const HELD = "(o.status IN ('paid', 'needs_review') OR (o.status = 'pending' AND o.created_at >= ?))";

export function createD1TicketRepo(db: DbClient): LpTicketRepo {
  const withItems = async (rows: TicketOrderDbRow[]): Promise<TicketOrderRow[]> => {
    if (rows.length === 0) return [];
    const items = await db.all<TicketItemDbRow>(
      `SELECT * FROM lp_ticket_order_items WHERE order_id IN (${rows.map(() => "?").join(", ")})
       ORDER BY order_id, rowid`,
      ...rows.map((r) => r.id),
    );
    const byOrder = new Map<string, LpTicketOrderItem[]>();
    for (const i of items) byOrder.set(i.order_id, [...(byOrder.get(i.order_id) ?? []), toItem(i)]);
    return rows.map((r) => toTicketOrder(r, byOrder.get(r.id) ?? []));
  };
  const one = async (r: TicketOrderDbRow | null): Promise<TicketOrderRow | null> => (r ? (await withItems([r]))[0]! : null);
  const upsertSetting = async (
    site: string,
    column: "enabled" | "cta_enabled" | "fields_json",
    value: unknown,
    updatedBy: string,
    updatedAt: string,
  ) => {
    await db.run(
      `INSERT INTO lp_ticket_settings (site, ${column}, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(site) DO UPDATE SET ${column} = excluded.${column}, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      site,
      value,
      updatedBy,
      updatedAt,
    );
  };

  return {
    async getTicketSettings(site) {
      const r = await db.first<{
        site: string;
        enabled: number;
        cta_enabled: number;
        fields_json: string;
        updated_by: string | null;
        updated_at: string;
      }>("SELECT site, enabled, cta_enabled, fields_json, updated_by, updated_at FROM lp_ticket_settings WHERE site = ?", site);
      return r
        ? {
            site: r.site,
            enabled: r.enabled === 1,
            ctaEnabled: r.cta_enabled === 1,
            fields: parseJsonArray<LpTicketField>(r.fields_json),
            updatedBy: r.updated_by,
            updatedAt: r.updated_at,
          }
        : null;
    },
    async setTicketEnabled(site, enabled, updatedBy, updatedAt) {
      await upsertSetting(site, "enabled", enabled ? 1 : 0, updatedBy, updatedAt);
    },
    async setTicketCta(site, ctaEnabled, updatedBy, updatedAt) {
      await upsertSetting(site, "cta_enabled", ctaEnabled ? 1 : 0, updatedBy, updatedAt);
    },
    async setTicketFields(site, fields, updatedBy, updatedAt) {
      await upsertSetting(site, "fields_json", JSON.stringify(fields), updatedBy, updatedAt);
    },
    async setTicketRelease(site, enabled, ctaEnabled, updatedBy, updatedAt) {
      await db.run(
        `INSERT INTO lp_ticket_settings (site, enabled, cta_enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET enabled = excluded.enabled, cta_enabled = excluded.cta_enabled,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at
         WHERE lp_ticket_settings.enabled IS NOT excluded.enabled OR lp_ticket_settings.cta_enabled IS NOT excluded.cta_enabled`,
        site,
        enabled ? 1 : 0,
        ctaEnabled ? 1 : 0,
        updatedBy,
        updatedAt,
      );
    },
    async listTicketTypes(site) {
      return (
        await db.all<TicketTypeDbRow>("SELECT * FROM lp_ticket_types WHERE site = ? ORDER BY sort_order, created_at", site)
      ).map(toTicketType);
    },
    async getTicketType(site, id) {
      const r = await db.first<TicketTypeDbRow>("SELECT * FROM lp_ticket_types WHERE site = ? AND id = ?", site, id);
      return r ? toTicketType(r) : null;
    },
    async insertTicketType(t) {
      await db.run(
        `INSERT INTO lp_ticket_types (id, site, name, description, price_jpy, capacity, day_label, max_per_order, active,
                                      sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id,
        t.site,
        t.name,
        t.description,
        t.priceJpy,
        t.capacity,
        t.dayLabel,
        t.maxPerOrder,
        t.active ? 1 : 0,
        t.sortOrder,
        t.createdAt,
        t.updatedAt,
      );
    },
    async updateTicketType(t) {
      await db.run(
        `UPDATE lp_ticket_types SET name = ?, description = ?, price_jpy = ?, capacity = ?, day_label = ?, max_per_order = ?,
                active = ?, sort_order = ?, updated_at = ?
         WHERE site = ? AND id = ?`,
        t.name,
        t.description,
        t.priceJpy,
        t.capacity,
        t.dayLabel,
        t.maxPerOrder,
        t.active ? 1 : 0,
        t.sortOrder,
        t.updatedAt,
        t.site,
        t.id,
      );
    },
    async ticketAggregates(site, pendingSince) {
      const rows = await db.all<{ k: string; sold: number | null; pending: number | null; revenue: number | null }>(
        `SELECT i.ticket_type_id AS k,
                SUM(CASE WHEN o.status = 'paid' THEN i.quantity ELSE 0 END) AS sold,
                SUM(CASE WHEN o.status = 'needs_review' OR (o.status = 'pending' AND o.created_at >= ?) THEN i.quantity ELSE 0 END) AS pending,
                SUM(CASE WHEN o.status = 'paid' THEN i.quantity * i.unit_price_jpy ELSE 0 END) AS revenue
         FROM lp_ticket_order_items i JOIN lp_ticket_orders o ON o.id = i.order_id
         WHERE o.site = ? AND o.status IN ('paid', 'needs_review', 'pending') GROUP BY i.ticket_type_id`,
        pendingSince,
        site,
      );
      return rows.map((r) => ({ ticketTypeId: r.k, sold: r.sold ?? 0, pending: r.pending ?? 0, revenueJpy: r.revenue ?? 0 }));
    },
    async heldPendingByClient(site, clientKey, pendingSince) {
      const r = await db.first<{ n: number | null }>(
        `SELECT SUM(quantity) AS n FROM lp_ticket_orders
         WHERE client_key = ? AND site = ? AND status = 'pending' AND created_at >= ?`,
        clientKey,
        site,
        pendingSince,
      );
      return r?.n ?? 0;
    },
    async insertOrderIfAvailable(o, capacities, pendingSince) {
      // One batch (= one transaction): the order, each item only if its type still has room, then
      // (still in the same batch) drop the order + its items when any item was short. No second
      // write = no ghost partial order if the Worker dies in between.
      // Concurrent checkouts serialize on D1's single writer, so no oversell.
      const n = o.items.length;
      const results = await db.batch([
        {
          // A coupon order is only written while the coupon still has room (same transaction as the
          // seat checks, so two buyers racing for the last use serialize and one gets coupon_used_up).
          sql: `INSERT INTO lp_ticket_orders (id, site, quantity, amount_jpy, status, buyer_name, buyer_email, answers_json,
                                             stripe_session_id, created_at, paid_at, client_key, coupon_id)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE ? IS NULL OR EXISTS (
                  SELECT 1 FROM lp_ticket_coupons c
                  WHERE c.id = ? AND c.site = ? AND c.active = 1 AND (c.expires_at IS NULL OR c.expires_at > ?)
                    AND ? = 1 AND c.ticket_type_id = ?
                    AND (SELECT COALESCE(SUM(o.quantity), 0) FROM lp_ticket_orders o WHERE o.coupon_id = c.id AND ${HELD}) + ? <= c.max_uses
                )`,
          binds: [
            o.id,
            o.site,
            o.quantity,
            o.amountJpy,
            o.status,
            o.buyerName,
            o.buyerEmail,
            JSON.stringify(o.answers),
            o.stripeSessionId,
            o.createdAt,
            o.paidAt,
            o.clientKey,
            o.couponId,
            o.couponId,
            o.couponId,
            o.site,
            o.createdAt,
            o.items.length,
            o.items[0]?.ticketTypeId ?? null,
            pendingSince,
            o.quantity,
          ],
        },
        ...o.items.map((i) => {
          const capacity = capacities.get(i.ticketTypeId) ?? null;
          return {
            sql: `INSERT INTO lp_ticket_order_items (order_id, ticket_type_id, ticket_type_name, day_label, unit_price_jpy, quantity)
                  SELECT ?, ?, ?, ?, ?, ?
                  WHERE ? IS NULL OR (
                    SELECT COALESCE(SUM(i.quantity), 0) FROM lp_ticket_order_items i JOIN lp_ticket_orders o ON o.id = i.order_id
                    WHERE o.site = ? AND i.ticket_type_id = ? AND o.id != ? AND ${HELD}
                  ) + ? <= ?`,
            binds: [
              o.id,
              i.ticketTypeId,
              i.ticketTypeName,
              i.dayLabel,
              i.unitPriceJpy,
              i.quantity,
              capacity,
              o.site,
              i.ticketTypeId,
              o.id,
              pendingSince,
              i.quantity,
              capacity,
            ],
          };
        }),
        {
          sql: "DELETE FROM lp_ticket_orders WHERE id = ? AND (SELECT COUNT(*) FROM lp_ticket_order_items WHERE order_id = ?) < ?",
          binds: [o.id, o.id, n],
        },
        {
          sql: "DELETE FROM lp_ticket_order_items WHERE order_id = ? AND NOT EXISTS (SELECT 1 FROM lp_ticket_orders WHERE id = ?)",
          binds: [o.id, o.id],
        },
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) return { ok: false, reason: "coupon_used_up" };
      const short = o.items.find((_, idx) => (results[idx + 1]?.meta.changes ?? 0) === 0);
      return short ? { ok: false, reason: "sold_out", ticketTypeId: short.ticketTypeId } : { ok: true };
    },
    async insertCoupon(c) {
      const r = await db.run(
        `INSERT INTO lp_ticket_coupons (id, site, code, label, ticket_type_id, max_uses, expires_at, active, created_by,
                                        created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site, code) DO NOTHING`,
        c.id,
        c.site,
        c.code,
        c.label,
        c.ticketTypeId,
        c.maxUses,
        c.expiresAt,
        c.active ? 1 : 0,
        c.createdBy,
        c.createdAt,
        c.updatedAt,
      );
      return r.meta.changes > 0;
    },
    async getCoupon(site, id) {
      const r = await db.first<TicketCouponDbRow>("SELECT * FROM lp_ticket_coupons WHERE site = ? AND id = ?", site, id);
      return r ? toCoupon(r) : null;
    },
    async getCouponByCode(site, code) {
      const r = await db.first<TicketCouponDbRow>("SELECT * FROM lp_ticket_coupons WHERE site = ? AND code = ?", site, code);
      return r ? toCoupon(r) : null;
    },
    async setCouponActive(site, id, active, updatedAt) {
      const r = await db.run(
        "UPDATE lp_ticket_coupons SET active = ?, updated_at = ? WHERE site = ? AND id = ?",
        active ? 1 : 0,
        updatedAt,
        site,
        id,
      );
      return r.meta.changes > 0;
    },
    async listCoupons(site) {
      return (
        await db.all<TicketCouponDbRow>("SELECT * FROM lp_ticket_coupons WHERE site = ? ORDER BY created_at DESC, id DESC", site)
      ).map(toCoupon);
    },
    async couponUses(site, pendingSince) {
      const rows = await db.all<{ k: string; n: number | null }>(
        `SELECT o.coupon_id AS k, SUM(o.quantity) AS n FROM lp_ticket_orders o
         WHERE o.site = ? AND o.coupon_id IS NOT NULL AND ${HELD} GROUP BY o.coupon_id`,
        site,
        pendingSince,
      );
      return new Map(rows.map((r) => [r.k, r.n ?? 0]));
    },
    async getOrder(site, id) {
      return one(await db.first<TicketOrderDbRow>("SELECT * FROM lp_ticket_orders WHERE site = ? AND id = ?", site, id));
    },
    async getOrderBySession(sessionId) {
      return one(await db.first<TicketOrderDbRow>("SELECT * FROM lp_ticket_orders WHERE stripe_session_id = ?", sessionId));
    },
    async setOrderSession(id, sessionId) {
      await db.run("UPDATE lp_ticket_orders SET stripe_session_id = ? WHERE id = ?", sessionId, id);
    },
    async getOrderByPaymentIntent(paymentIntentId) {
      return one(
        await db.first<TicketOrderDbRow>("SELECT * FROM lp_ticket_orders WHERE payment_intent_id = ?", paymentIntentId),
      );
    },
    async markOrderPaid(id, p) {
      // One statement = atomic on D1's single writer: two late settles racing for the last seat
      // serialize here, so the second sees the first as held and goes to needs_review.
      const over = `? IS NOT NULL AND EXISTS (
        SELECT 1 FROM lp_ticket_order_items mine JOIN lp_ticket_types t ON t.id = mine.ticket_type_id
        WHERE mine.order_id = ? AND t.capacity IS NOT NULL AND (
          SELECT COALESCE(SUM(i.quantity), 0) FROM lp_ticket_order_items i JOIN lp_ticket_orders o ON o.id = i.order_id
          WHERE i.ticket_type_id = mine.ticket_type_id AND o.id != ? AND ${HELD}
        ) + mine.quantity > t.capacity)`;
      const since = p.capacitySince ?? null;
      const overBinds = [since, id, id, since];
      const r = await db.first<{ status: "paid" | "needs_review" }>(
        `UPDATE lp_ticket_orders SET
                status = CASE WHEN ${over} THEN 'needs_review' ELSE 'paid' END,
                review_reason = CASE WHEN ${over} THEN 'oversold' ELSE NULL END,
                paid_at = ?, stripe_session_id = COALESCE(stripe_session_id, ?),
                payment_intent_id = COALESCE(payment_intent_id, ?)
         WHERE id = ? AND status IN ('pending', 'expired')
         RETURNING status`,
        ...overBinds,
        ...overBinds,
        p.paidAt,
        p.sessionId,
        p.paymentIntentId,
        id,
      );
      return r?.status ?? null;
    },
    async markOrderPreview(id) {
      await db.run("UPDATE lp_ticket_orders SET preview = 1 WHERE id = ?", id);
    },
    async setOrderPaymentMethod(id, method) {
      await db.run("UPDATE lp_ticket_orders SET payment_method = ? WHERE id = ?", method, id);
    },
    async markOrderExpired(id) {
      const res = await db.run("UPDATE lp_ticket_orders SET status = 'expired' WHERE id = ? AND status = 'pending'", id);
      return res.meta.changes > 0;
    },
    async markOrderNeedsReview(id, reason, paymentIntentId = null) {
      const res = await db.run(
        `UPDATE lp_ticket_orders SET status = 'needs_review', review_reason = ?, payment_intent_id = COALESCE(payment_intent_id, ?)
         WHERE id = ? AND status IN ('pending', 'expired', 'paid')`,
        reason,
        paymentIntentId,
        id,
      );
      return res.meta.changes > 0;
    },
    async markOrderRefunded(id, refundedAt) {
      const [res] = await db.batch([
        {
          sql: "UPDATE lp_ticket_orders SET status = 'refunded', refunded_at = ? WHERE id = ? AND status IN ('paid', 'needs_review')",
          binds: [refundedAt, id],
        },
        {
          sql: "UPDATE lp_tickets SET status = 'void', voided_at = ? WHERE order_id = ? AND status = 'valid'",
          binds: [refundedAt, id],
        },
      ]);
      return (res?.meta.changes ?? 0) > 0;
    },
    async approveOrder(id, resolvedBy, resolvedAt, onlyReason) {
      const res = await db.run(
        `UPDATE lp_ticket_orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), resolved_by = ?, resolved_at = ?
         WHERE id = ? AND status = 'needs_review' AND (? IS NULL OR review_reason = ?)`,
        resolvedAt,
        resolvedBy,
        resolvedAt,
        id,
        onlyReason ?? null,
        onlyReason ?? null,
      );
      return res.meta.changes > 0;
    },
    async setOrderPaymentIntent(id, paymentIntentId) {
      await db.run(
        "UPDATE lp_ticket_orders SET payment_intent_id = ? WHERE id = ? AND payment_intent_id IS NULL",
        paymentIntentId,
        id,
      );
    },
    async listMissingPaymentIntent(site, livemode, limit) {
      return withItems(
        await db.all<TicketOrderDbRow>(
          `SELECT * FROM lp_ticket_orders
           WHERE site = ? AND status IN ('paid', 'needs_review') AND stripe_session_id LIKE ? AND payment_intent_id IS NULL
           ORDER BY created_at, id LIMIT ?`,
          site,
          livemode ? "cs_live_%" : "cs_test_%",
          limit,
        ),
      );
    },
    async listPendingWithSession(site, from, to, limit) {
      return withItems(
        await db.all<TicketOrderDbRow>(
          `SELECT * FROM lp_ticket_orders
           WHERE site = ? AND status = 'pending' AND stripe_session_id IS NOT NULL AND created_at >= ? AND created_at < ?
           ORDER BY created_at, id LIMIT ?`,
          site,
          from,
          to,
          limit,
        ),
      );
    },
    async expireSessionlessPending(site, before) {
      const res = await db.run(
        `UPDATE lp_ticket_orders SET status = 'expired'
         WHERE site = ? AND status = 'pending' AND stripe_session_id IS NULL AND created_at < ?`,
        site,
        before,
      );
      return res.meta.changes;
    },
    async listOrders(site, cursor, limit) {
      const binds: unknown[] = [site];
      let sql = "SELECT * FROM lp_ticket_orders WHERE site = ?";
      const c = cursor ? parseCursor(cursor) : null;
      if (c) {
        sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
        binds.push(c.day, c.day, c.id);
      }
      sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
      binds.push(limit);
      return withItems(await db.all<TicketOrderDbRow>(sql, ...binds));
    },
    async listOrdersAscending(site, cursor, limit) {
      // Items come through the same page as a subquery: D1 caps bound parameters, so no IN (?, ?, ...) here.
      const c = cursor ? parseCursor(cursor) : null;
      const after = c ? " AND (created_at > ? OR (created_at = ? AND id > ?))" : "";
      const afterBinds = c ? [c.day, c.day, c.id] : [];
      const page = `FROM lp_ticket_orders WHERE site = ?${after} ORDER BY created_at, id LIMIT ?`;
      const rows = await db.all<TicketOrderDbRow>(`SELECT * ${page}`, site, ...afterBinds, limit);
      const items = await db.all<TicketItemDbRow>(
        `SELECT * FROM lp_ticket_order_items WHERE order_id IN (SELECT id ${page}) ORDER BY order_id, rowid`,
        site,
        ...afterBinds,
        limit,
      );
      const byOrder = new Map<string, LpTicketOrderItem[]>();
      for (const i of items) {
        const list = byOrder.get(i.order_id);
        if (list) list.push(toItem(i));
        else byOrder.set(i.order_id, [toItem(i)]);
      }
      return rows.map((r) => toTicketOrder(r, byOrder.get(r.id) ?? []));
    },
    async issueFulfilment(orderId, tickets, outbox) {
      const paid = "EXISTS (SELECT 1 FROM lp_ticket_orders WHERE id = ? AND status = 'paid')";
      await db.batch([
        ...tickets.map((t) => ({
          sql: `INSERT OR IGNORE INTO lp_tickets (id, order_id, ticket_type_id, ticket_type_name, day_label, status, created_at)
                SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${paid}`,
          binds: [t.id, t.orderId, t.ticketTypeId, t.ticketTypeName, t.dayLabel, t.status, t.createdAt, orderId],
        })),
        ...outbox.map((r) => ({
          sql: `INSERT OR IGNORE INTO lp_ticket_outbox (id, order_id, kind, status, attempts, next_attempt_at, created_at)
                SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${paid}`,
          binds: [r.id, r.orderId, r.kind, r.status, r.attempts, r.nextAttemptAt, r.createdAt, orderId],
        })),
      ]);
    },
    async listUnfulfilled(site, paidSince, limit) {
      return withItems(
        await db.all<TicketOrderDbRow>(
          `SELECT o.* FROM lp_ticket_orders o
           WHERE o.site = ? AND o.status = 'paid' AND (? IS NULL OR o.paid_at >= ?)
             AND (
               (SELECT COUNT(*) FROM lp_tickets t WHERE t.order_id = o.id) < o.quantity
               OR NOT EXISTS (SELECT 1 FROM lp_ticket_outbox r WHERE r.order_id = o.id AND r.kind = 'buyer_confirmation')
               OR (
                 COALESCE(o.preview, 0) = 0 AND COALESCE(o.stripe_session_id, '') NOT LIKE 'cs_test_%'
                 AND NOT EXISTS (SELECT 1 FROM lp_ticket_outbox r WHERE r.order_id = o.id AND r.kind = 'ops_copy')
               )
             )
           ORDER BY o.paid_at, o.id LIMIT ?`,
          site,
          paidSince,
          paidSince,
          limit,
        ),
      );
    },
    async getTicket(id) {
      const r = await db.first<TicketDbRow>("SELECT * FROM lp_tickets WHERE id = ?", id);
      return r ? toTicket(r) : null;
    },
    async ticketsForOrders(orderIds) {
      if (orderIds.length === 0) return [];
      return (
        await db.all<TicketDbRow>(
          `SELECT * FROM lp_tickets WHERE order_id IN (${orderIds.map(() => "?").join(", ")}) ORDER BY order_id, rowid`,
          ...orderIds,
        )
      ).map(toTicket);
    },
    async listTickets(cursor, limit) {
      return (
        await db.all<TicketDbRow>("SELECT * FROM lp_tickets WHERE id > ? ORDER BY id LIMIT ?", cursor ?? "", limit)
      ).map(toTicket);
    },
    async ordersByIds(site, ids) {
      if (ids.length === 0) return [];
      return withItems(
        await db.all<TicketOrderDbRow>(
          `SELECT * FROM lp_ticket_orders WHERE site = ? AND id IN (${ids.map(() => "?").join(", ")})`,
          site,
          ...ids,
        ),
      );
    },
    async countOutboxSentSince(since) {
      const r = await db.first<{ c: number }>("SELECT COUNT(*) AS c FROM lp_ticket_outbox WHERE status = 'sent' AND sent_at >= ?", since);
      return r?.c ?? 0;
    },
    async claimOutbox(c) {
      if (c.kinds.length === 0) return [];
      const rows = await db.all<OutboxDbRow>(
        `UPDATE lp_ticket_outbox SET next_attempt_at = ?
         WHERE id IN (
           SELECT id FROM lp_ticket_outbox
           WHERE status = 'pending' AND next_attempt_at <= ? AND kind IN (${c.kinds.map(() => "?").join(", ")})
             AND (? IS NULL OR order_id = ?)
           ORDER BY kind, next_attempt_at, id LIMIT ?
         )
         RETURNING *`,
        c.leaseUntil,
        c.now,
        ...c.kinds,
        c.orderId ?? null,
        c.orderId ?? null,
        c.limit,
      );
      return rows.map(toOutbox).sort(outboxOrder);
    },
    async applyOutboxUpdates(updates) {
      if (updates.length === 0) return;
      await db.batch(
        updates.map((u) => ({
          sql: "UPDATE lp_ticket_outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, sent_at = ? WHERE id = ?",
          binds: [u.status, u.attempts, u.nextAttemptAt, u.lastError, u.sentAt, u.id],
        })),
      );
    },
    async outboxDue(before) {
      const rows = await db.all<{ kind: OutboxKind; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM lp_ticket_outbox WHERE status = 'pending' AND next_attempt_at <= ? GROUP BY kind",
        before,
      );
      return new Map(rows.map((r) => [r.kind, r.n]));
    },
    async listOrderOutbox(orderId) {
      return (await db.all<OutboxDbRow>("SELECT * FROM lp_ticket_outbox WHERE order_id = ? ORDER BY kind", orderId)).map(toOutbox);
    },
    async getJobStates() {
      const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM lp_ticket_jobs");
      return new Map(rows.map((r) => [r.key, r.value]));
    },
    async setJobState(key, value, updatedAt) {
      await db.run(
        `INSERT INTO lp_ticket_jobs (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        value,
        updatedAt,
      );
    },
  };
}
