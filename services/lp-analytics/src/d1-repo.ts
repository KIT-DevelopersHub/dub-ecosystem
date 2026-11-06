// D1-backed LpRepo. Owns namespace `lp_*` only (enforced by @dub/db strict client).
import type { DbClient } from "@dub/db";
import type {
  AggregateBy,
  AggregateQuery,
  AggregateRow,
  LinkRow,
  LpDevice,
  LpProposalRepo,
  LpProposalStatus,
  LpRepo,
  LpFormAnswer,
  LpFormField,
  LpVisitKind,
  LpSiteConfigRepo,
  ProposalRow,
  SiteConfigHistoryRow,
  SiteConfigRow,
  VisitRow,
} from "./types";

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
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
  const bot = q.includeBots ? "" : " AND device != 'bot'";
  if (!q.source) return { sql: `org_id = ? AND day_jst >= ? AND day_jst <= ?${bot}`, binds: [q.orgId, q.from, q.to] };
  return {
    sql: `org_id = ? AND day_jst >= ? AND day_jst <= ?${bot} AND source = ?`,
    binds: [q.orgId, q.from, q.to, q.source],
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

interface ProposalDbRow {
  id: string;
  site: string;
  speaker_name: string;
  email: string;
  title: string;
  abstract: string;
  answers_json: string;
  status: string;
  reviewed_by: string | null;
  client_key: string | null;
  created_at: string;
  updated_at: string;
}

const toProposal = (r: ProposalDbRow): ProposalRow => ({
  id: r.id,
  site: r.site,
  speakerName: r.speaker_name,
  email: r.email,
  title: r.title,
  abstract: r.abstract,
  answers: parseJsonArray<LpFormAnswer>(r.answers_json),
  status: r.status as LpProposalStatus,
  reviewedBy: r.reviewed_by,
  clientKey: r.client_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function proposalRepo(db: DbClient): LpProposalRepo {
  const upsertSetting = async (column: "enabled" | "fields_json", site: string, value: unknown, by: string, at: string) => {
    await db.run(
      `INSERT INTO lp_proposal_settings (site, ${column}, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(site) DO UPDATE SET ${column} = excluded.${column}, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      site,
      value,
      by,
      at,
    );
  };
  return {
    async getProposalSettings(site) {
      const r = await db.first<{ site: string; enabled: number; fields_json: string | null; updated_by: string | null; updated_at: string }>(
        "SELECT site, enabled, fields_json, updated_by, updated_at FROM lp_proposal_settings WHERE site = ?",
        site,
      );
      return r
        ? {
            site: r.site,
            enabled: r.enabled === 1,
            fields: r.fields_json === null ? null : parseJsonArray<LpFormField>(r.fields_json),
            updatedBy: r.updated_by,
            updatedAt: r.updated_at,
          }
        : null;
    },
    async setProposalEnabled(site, enabled, updatedBy, updatedAt) {
      await upsertSetting("enabled", site, enabled ? 1 : 0, updatedBy, updatedAt);
    },
    async setProposalFields(site, fields, updatedBy, updatedAt) {
      await upsertSetting("fields_json", site, JSON.stringify(fields), updatedBy, updatedAt);
    },
    async insertProposal(p) {
      await db.run(
        `INSERT INTO lp_proposals (id, site, speaker_name, email, title, abstract, answers_json, status, reviewed_by, client_key,
                                   created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id,
        p.site,
        p.speakerName,
        p.email,
        p.title,
        p.abstract,
        JSON.stringify(p.answers),
        p.status,
        p.reviewedBy,
        p.clientKey,
        p.createdAt,
        p.updatedAt,
      );
    },
    async getProposal(site, id) {
      const r = await db.first<ProposalDbRow>("SELECT * FROM lp_proposals WHERE site = ? AND id = ?", site, id);
      return r ? toProposal(r) : null;
    },
    async setProposalStatus(site, id, status, reviewedBy, updatedAt) {
      const res = await db.run(
        "UPDATE lp_proposals SET status = ?, reviewed_by = ?, updated_at = ? WHERE site = ? AND id = ?",
        status,
        status === "submitted" ? null : reviewedBy,
        updatedAt,
        site,
        id,
      );
      return res.meta.changes > 0;
    },
    async listProposals(site, cursor, limit) {
      const binds: unknown[] = [site];
      let sql = "SELECT * FROM lp_proposals WHERE site = ?";
      const c = cursor ? parseCursor(cursor) : null;
      if (c) {
        sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
        binds.push(c.day, c.day, c.id);
      }
      sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
      binds.push(limit);
      return (await db.all<ProposalDbRow>(sql, ...binds)).map(toProposal);
    },
    async proposalTotals(site) {
      const r = await db.first<{ total: number; accepted: number | null; rejected: number | null }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM lp_proposals WHERE site = ?`,
        site,
      );
      return { total: r?.total ?? 0, accepted: r?.accepted ?? 0, rejected: r?.rejected ?? 0 };
    },
    async countProposalsSince(site, since, clientKey) {
      const r = clientKey
        ? await db.first<{ c: number }>(
            "SELECT COUNT(*) AS c FROM lp_proposals WHERE site = ? AND client_key = ? AND created_at >= ?",
            site,
            clientKey,
            since,
          )
        : await db.first<{ c: number }>(
            "SELECT COUNT(*) AS c FROM lp_proposals WHERE site = ? AND created_at >= ?",
            site,
            since,
          );
      return r?.c ?? 0;
    },
  };
}

interface SiteConfigDbRow {
  site: string;
  draft_json: string;
  published_json: string;
  revision: number;
  draft_updated_by: string | null;
  draft_updated_at: string | null;
  published_by: string | null;
  published_at: string | null;
}

function siteConfigRepo(db: DbClient): LpSiteConfigRepo {
  // 行が無いときの土台（revision 0・下書き/本番とも "{}"）。行が無い = この行がある、と同じ意味。
  const ensureRow = (site: string, at: string) => ({
    sql: "INSERT OR IGNORE INTO lp_site_config (site, created_at, updated_at) VALUES (?, ?, ?)",
    binds: [site, at, at],
  });
  return {
    async getSiteConfig(site): Promise<SiteConfigRow | null> {
      const r = await db.first<SiteConfigDbRow>(
        `SELECT site, draft_json, published_json, revision, draft_updated_by, draft_updated_at, published_by, published_at
         FROM lp_site_config WHERE site = ?`,
        site,
      );
      return r
        ? {
            site: r.site,
            draftJson: r.draft_json,
            publishedJson: r.published_json,
            revision: r.revision,
            draftUpdatedBy: r.draft_updated_by,
            draftUpdatedAt: r.draft_updated_at,
            publishedBy: r.published_by,
            publishedAt: r.published_at,
          }
        : null;
    },
    async saveSiteConfigDraft(site, draftJson, expectedRevision, updatedBy, updatedAt) {
      const check = expectedRevision === null ? "" : " AND revision = ?";
      const results = await db.batch([
        ensureRow(site, updatedAt),
        {
          sql: `UPDATE lp_site_config
                SET draft_json = ?, revision = revision + 1, draft_updated_by = ?, draft_updated_at = ?, updated_at = ?
                WHERE site = ?${check}`,
          binds: [draftJson, updatedBy, updatedAt, updatedAt, site, ...(expectedRevision === null ? [] : [expectedRevision])],
        },
      ]);
      return results[1]?.meta.changes === 1;
    },
    async publishSiteConfig(p) {
      // One batch (= one transaction). The history row is inserted only when the revision still
      // matches, and every later write is gated on that row existing: a stale revision writes nothing
      // (batch statements cannot abort each other, so the history id is the per-request token).
      const gate = "EXISTS (SELECT 1 FROM lp_site_config_history WHERE id = ?)";
      const r = p.release;
      const results = await db.batch([
        ensureRow(p.site, p.updatedAt),
        {
          sql: `INSERT INTO lp_site_config_history (id, site, config_json, published_by, published_at)
                SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM lp_site_config WHERE site = ? AND revision = ?)`,
          binds: [p.historyId, p.site, p.configJson, p.updatedBy, p.updatedAt, p.site, p.expectedRevision],
        },
        {
          sql: `UPDATE lp_site_config
                SET published_json = ?, revision = revision + 1, published_by = ?, published_at = ?, updated_at = ?
                WHERE site = ? AND ${gate}`,
          binds: [p.layoutJson, p.updatedBy, p.updatedAt, p.updatedAt, p.site, p.historyId],
        },
        {
          sql: `INSERT INTO lp_publish (site, version_id, updated_by, updated_at) SELECT ?, ?, ?, ? WHERE ${gate}
                ON CONFLICT(site) DO UPDATE SET version_id = excluded.version_id, updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at
                WHERE lp_publish.version_id IS NOT excluded.version_id`,
          binds: [p.site, r.versionId, p.updatedBy, p.updatedAt, p.historyId],
        },
        {
          sql: `INSERT INTO lp_proposal_settings (site, enabled, updated_by, updated_at) SELECT ?, ?, ?, ? WHERE ${gate}
                ON CONFLICT(site) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at
                WHERE lp_proposal_settings.enabled IS NOT excluded.enabled`,
          binds: [p.site, r.proposalsEnabled ? 1 : 0, p.updatedBy, p.updatedAt, p.historyId],
        },
      ]);
      return results[1]?.meta.changes === 1;
    },
    async listSiteConfigHistory(site, limit): Promise<SiteConfigHistoryRow[]> {
      const rows = await db.all<{ id: string; site: string; config_json: string; published_by: string; published_at: string }>(
        `SELECT id, site, config_json, published_by, published_at FROM lp_site_config_history
         WHERE site = ? ORDER BY published_at DESC, id DESC LIMIT ?`,
        site,
        limit,
      );
      return rows.map((x) => ({
        id: x.id,
        site: x.site,
        configJson: x.config_json,
        publishedBy: x.published_by,
        publishedAt: x.published_at,
      }));
    },
  };
}

export function createD1LpRepo(db: DbClient): LpRepo {
  return {
    ...proposalRepo(db),
    ...siteConfigRepo(db),
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
      const w = rangeWhere({ ...q, includeBots: true });
      const r = await db.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM lp_visits WHERE ${w.sql} AND device = 'bot'`,
        ...w.binds,
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
