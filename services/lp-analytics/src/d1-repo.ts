// D1-backed LpRepo. Owns namespace `lp_*` only (enforced by @dub/db strict client).
import type { DbClient } from "@dub/db";
import type {
  AggregateBy,
  AggregateQuery,
  AggregateRow,
  LinkRow,
  LpDevice,
  LpRepo,
  LpTicketAnswer,
  LpTicketField,
  LpTicketOrderItem,
  LpTicketOrderStatus,
  LpTicketRepo,
  LpVisitKind,
  TicketOrderRow,
  TicketTypeRow,
  VisitRow,
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
}
interface TicketItemDbRow {
  order_id: string;
  ticket_type_id: string;
  ticket_type_name: string;
  day_label: string;
  unit_price_jpy: number;
  quantity: number;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
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
});

// Seats held = items of paid orders + of pending orders still inside the hold window (alias o).
const HELD = "(o.status = 'paid' OR (o.status = 'pending' AND o.created_at >= ?))";

function ticketRepo(db: DbClient): LpTicketRepo {
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
                SUM(CASE WHEN o.status = 'pending' AND o.created_at >= ? THEN i.quantity ELSE 0 END) AS pending,
                SUM(CASE WHEN o.status = 'paid' THEN i.quantity * i.unit_price_jpy ELSE 0 END) AS revenue
         FROM lp_ticket_order_items i JOIN lp_ticket_orders o ON o.id = i.order_id
         WHERE o.site = ? AND o.status != 'expired' GROUP BY i.ticket_type_id`,
        pendingSince,
        site,
      );
      return rows.map((r) => ({ ticketTypeId: r.k, sold: r.sold ?? 0, pending: r.pending ?? 0, revenueJpy: r.revenue ?? 0 }));
    },
    async countOrdersSince(site, since) {
      const r = await db.first<{ c: number }>(
        "SELECT COUNT(*) AS c FROM lp_ticket_orders WHERE site = ? AND created_at >= ?",
        site,
        since,
      );
      return r?.c ?? 0;
    },
    async insertOrderIfAvailable(o, capacities, pendingSince) {
      // One batch (= one transaction): the order, then each item only if its type still has room.
      // Concurrent checkouts serialize on D1's single writer, so no oversell.
      const results = await db.batch([
        {
          sql: `INSERT INTO lp_ticket_orders (id, site, quantity, amount_jpy, status, buyer_name, buyer_email, answers_json,
                                             stripe_session_id, created_at, paid_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]);
      const short = o.items.find((_, idx) => (results[idx + 1]?.meta.changes ?? 0) === 0);
      if (!short) return { ok: true };
      // Roll back the partial hold so the other items are released immediately.
      await db.batch([
        { sql: "DELETE FROM lp_ticket_order_items WHERE order_id = ?", binds: [o.id] },
        { sql: "DELETE FROM lp_ticket_orders WHERE id = ?", binds: [o.id] },
      ]);
      return { ok: false, ticketTypeId: short.ticketTypeId };
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
    async markOrderPaid(id, paidAt, sessionId) {
      const res = await db.run(
        `UPDATE lp_ticket_orders SET status = 'paid', paid_at = ?, stripe_session_id = COALESCE(stripe_session_id, ?)
         WHERE id = ? AND status = 'pending'`,
        paidAt,
        sessionId,
        id,
      );
      return res.meta.changes > 0;
    },
    async markOrderExpired(id) {
      const res = await db.run("UPDATE lp_ticket_orders SET status = 'expired' WHERE id = ? AND status = 'pending'", id);
      return res.meta.changes > 0;
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
  };
}

interface LinkDbRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface VisitDbRow {
  id: string;
  org_id: string;
  link_id: string | null;
  source: string;
  lp_version: string | null;
  path: string | null;
  referrer_host: string | null;
  country: string | null;
  device: string;
  kind: string;
  visitor_key: string;
  day_jst: string;
  occurred_at: string;
}
interface AggDbRow {
  k: string | null;
  visits: number;
  uniques: number;
  last_at: string | null;
}

const toLink = (r: LinkDbRow): LinkRow => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  slug: r.slug,
  active: r.active === 1,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toVisit = (r: VisitDbRow): VisitRow => ({
  id: r.id,
  orgId: r.org_id,
  linkId: r.link_id,
  source: r.source,
  lpVersion: r.lp_version,
  path: r.path,
  referrerHost: r.referrer_host,
  country: r.country,
  device: r.device as LpDevice,
  kind: r.kind as LpVisitKind,
  visitorKey: r.visitor_key,
  dayJst: r.day_jst,
  occurredAt: r.occurred_at,
});

// Whitelisted GROUP BY columns — `by` never reaches SQL as free text.
const GROUP_COLUMN: Record<AggregateBy, string> = { source: "source", device: "device", day: "day_jst", link: "link_id" };

const AGG_SELECT = "COUNT(*) AS visits, COUNT(DISTINCT visitor_key) AS uniques, MAX(occurred_at) AS last_at";

function rangeWhere(q: AggregateQuery): { sql: string; binds: unknown[] } {
  return {
    sql: `org_id = ? AND day_jst >= ? AND day_jst <= ?${q.includeBots ? "" : " AND device != 'bot'"}`,
    binds: [q.orgId, q.from, q.to],
  };
}

/** Cursor = "<day_jst>~<id>" of the previous page's last row (opaque to the client). */
export function visitCursor(v: { dayJst: string; id: string }): string {
  return `${v.dayJst}~${v.id}`;
}

function parseCursor(raw: string): { day: string; id: string } | null {
  const i = raw.indexOf("~");
  return i > 0 ? { day: raw.slice(0, i), id: raw.slice(i + 1) } : null;
}

export function createD1LpRepo(db: DbClient): LpRepo {
  return {
    ...ticketRepo(db),
    async listLinks(orgId) {
      return (await db.all<LinkDbRow>("SELECT * FROM lp_links WHERE org_id = ?", orgId)).map(toLink);
    },
    async getLink(orgId, id) {
      const r = await db.first<LinkDbRow>("SELECT * FROM lp_links WHERE org_id = ? AND id = ?", orgId, id);
      return r ? toLink(r) : null;
    },
    async getLinkBySlug(orgId, slug) {
      const r = await db.first<LinkDbRow>("SELECT * FROM lp_links WHERE org_id = ? AND slug = ?", orgId, slug);
      return r ? toLink(r) : null;
    },
    async insertLink(row) {
      // ON CONFLICT DO NOTHING keeps the duplicate check atomic under concurrent issues.
      const res = await db.run(
        `INSERT INTO lp_links (id, org_id, name, slug, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, slug) DO NOTHING`,
        row.id,
        row.orgId,
        row.name,
        row.slug,
        row.active ? 1 : 0,
        row.createdBy,
        row.createdAt,
        row.updatedAt,
      );
      return res.meta.changes > 0;
    },
    async setLinkActive(orgId, id, active, updatedAt) {
      await db.run("UPDATE lp_links SET active = ?, updated_at = ? WHERE org_id = ? AND id = ?", active ? 1 : 0, updatedAt, orgId, id);
    },
    async insertVisit(v) {
      const res = await db.run(
        `INSERT INTO lp_visits (id, org_id, link_id, source, lp_version, path, referrer_host, country, device, kind,
                                visitor_key, day_jst, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        v.id,
        v.orgId,
        v.linkId,
        v.source,
        v.lpVersion,
        v.path,
        v.referrerHost,
        v.country,
        v.device,
        v.kind,
        v.visitorKey,
        v.dayJst,
        v.occurredAt,
      );
      return res.meta.changes > 0;
    },
    async recordedOn(dayJst) {
      const r = await db.first<{ recorded: number }>("SELECT recorded FROM lp_ingest_days WHERE day_jst = ?", dayJst);
      return r?.recorded ?? 0;
    },
    async bumpRecorded(dayJst, now) {
      await db.run(
        `INSERT INTO lp_ingest_days (day_jst, recorded, created_at, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(day_jst) DO UPDATE SET recorded = recorded + 1, updated_at = excluded.updated_at`,
        dayJst,
        now,
        now,
      );
    },
    async total(q) {
      const w = rangeWhere(q);
      const r = await db.first<AggDbRow>(`SELECT '' AS k, ${AGG_SELECT} FROM lp_visits WHERE ${w.sql}`, ...w.binds);
      return { key: "", visits: r?.visits ?? 0, uniques: r?.uniques ?? 0, lastVisitAt: r?.last_at ?? null };
    },
    async countBots(q) {
      const r = await db.first<{ c: number }>(
        "SELECT COUNT(*) AS c FROM lp_visits WHERE org_id = ? AND day_jst >= ? AND day_jst <= ? AND device = 'bot'",
        q.orgId,
        q.from,
        q.to,
      );
      return r?.c ?? 0;
    },
    async aggregate(q, by) {
      const col = GROUP_COLUMN[by];
      const w = rangeWhere(q);
      const nonNull = by === "link" ? " AND link_id IS NOT NULL" : "";
      const rows = await db.all<AggDbRow>(
        `SELECT ${col} AS k, ${AGG_SELECT} FROM lp_visits WHERE ${w.sql}${nonNull} GROUP BY ${col}`,
        ...w.binds,
      );
      return rows.map(
        (r): AggregateRow => ({ key: r.k ?? "", visits: r.visits, uniques: r.uniques, lastVisitAt: r.last_at }),
      );
    },
    async listVisits(q) {
      const binds: unknown[] = [q.orgId, q.from, q.to];
      let sql = "SELECT * FROM lp_visits WHERE org_id = ? AND day_jst >= ? AND day_jst <= ? AND device != 'bot'";
      if (q.source) {
        sql += " AND source = ?";
        binds.push(q.source);
      }
      const cursor = q.cursor ? parseCursor(q.cursor) : null;
      if (cursor) {
        sql += " AND (day_jst < ? OR (day_jst = ? AND id < ?))";
        binds.push(cursor.day, cursor.day, cursor.id);
      }
      // Matches idx_lp_visits_org_day (org_id, day_jst, id) walked backwards: no sort step,
      // and LIMIT stops the scan after one page instead of reading the whole range.
      sql += " ORDER BY day_jst DESC, id DESC LIMIT ?";
      binds.push(q.limit);
      return (await db.all<VisitDbRow>(sql, ...binds)).map(toVisit);
    },
    async getPublish(site) {
      const r = await db.first<{ site: string; version_id: string; updated_by: string | null; updated_at: string }>(
        "SELECT site, version_id, updated_by, updated_at FROM lp_publish WHERE site = ?",
        site,
      );
      return r ? { site: r.site, versionId: r.version_id, updatedBy: r.updated_by, updatedAt: r.updated_at } : null;
    },
    async setPublish(site, versionId, updatedBy, updatedAt) {
      await db.run(
        `INSERT INTO lp_publish (site, version_id, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET version_id = excluded.version_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        site,
        versionId,
        updatedBy,
        updatedAt,
      );
    },
  };
}
