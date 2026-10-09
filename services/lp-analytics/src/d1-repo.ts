// D1-backed LpRepo. Owns namespace `lp_*` only (enforced by @dub/db strict client).
import type { DbClient } from "@dub/db";
import type { AggregateBy, AggregateQuery, AggregateRow, LinkRow, LpDevice, LpRepo, LpVisitKind, VisitRow } from "./types";

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
  };
}
