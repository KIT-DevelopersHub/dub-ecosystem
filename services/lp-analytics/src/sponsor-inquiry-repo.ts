// スポンサー募集の永続化: D1（lp_sponsor_inquiry_settings / lp_sponsor_inquiries）とテスト用のメモリ実装。
import type { DbClient } from "@dub/db";
import type { lpSponsor } from "@dub/types";
import type { SponsorInquiryRepo, SponsorInquiryRow, SponsorSettingsRow } from "./sponsor-inquiries";

interface InquiryDbRow {
  id: string;
  site: string;
  company_name: string;
  contact_name: string;
  email: string;
  message: string;
  status: string;
  notified_via: string;
  updated_by: string | null;
  client_key: string | null;
  created_at: string;
  updated_at: string;
}

const toRow = (r: InquiryDbRow): SponsorInquiryRow => ({
  id: r.id,
  site: r.site,
  companyName: r.company_name,
  contactName: r.contact_name,
  email: r.email,
  message: r.message,
  status: r.status as lpSponsor.LpSponsorInquiryStatus,
  notifiedVia: r.notified_via as lpSponsor.LpSponsorInquiry["notifiedVia"],
  updatedBy: r.updated_by,
  clientKey: r.client_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function parseCursor(raw: string): { at: string; id: string } | null {
  const i = raw.indexOf("~");
  return i > 0 ? { at: raw.slice(0, i), id: raw.slice(i + 1) } : null;
}

export function sponsorInquiryRepo(db: DbClient): SponsorInquiryRepo {
  return {
    async getSponsorSettings(site) {
      const r = await db.first<{
        site: string;
        enabled: number;
        notify_email: string | null;
        updated_by: string | null;
        updated_at: string;
      }>("SELECT * FROM lp_sponsor_inquiry_settings WHERE site = ?", site);
      return r
        ? {
            site: r.site,
            enabled: r.enabled === 1,
            notifyEmail: r.notify_email,
            updatedBy: r.updated_by,
            updatedAt: r.updated_at,
          }
        : null;
    },
    async setSponsorEnabled(site, enabled, updatedBy, updatedAt) {
      await db.run(
        `INSERT INTO lp_sponsor_inquiry_settings (site, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        site,
        enabled ? 1 : 0,
        updatedBy,
        updatedAt,
      );
    },
    async setSponsorNotify(site, n, updatedBy, updatedAt) {
      await db.run(
        `INSERT INTO lp_sponsor_inquiry_settings (site, notify_email, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET notify_email = excluded.notify_email,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        site,
        n.notifyEmail,
        updatedBy,
        updatedAt,
      );
    },
    async insertSponsorInquiry(p) {
      await db.run(
        `INSERT INTO lp_sponsor_inquiries (id, site, company_name, contact_name, email, message, status, notified_via, updated_by,
                                           client_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id,
        p.site,
        p.companyName,
        p.contactName,
        p.email,
        p.message,
        p.status,
        p.notifiedVia,
        p.updatedBy,
        p.clientKey,
        p.createdAt,
        p.updatedAt,
      );
    },
    async setSponsorInquiryNotified(site, id, via) {
      await db.run("UPDATE lp_sponsor_inquiries SET notified_via = ? WHERE site = ? AND id = ?", via, site, id);
    },
    async getSponsorInquiry(site, id) {
      const r = await db.first<InquiryDbRow>("SELECT * FROM lp_sponsor_inquiries WHERE site = ? AND id = ?", site, id);
      return r ? toRow(r) : null;
    },
    async setSponsorInquiryStatus(site, id, status, updatedBy, updatedAt) {
      const res = await db.run(
        "UPDATE lp_sponsor_inquiries SET status = ?, updated_by = ?, updated_at = ? WHERE site = ? AND id = ?",
        status,
        updatedBy,
        updatedAt,
        site,
        id,
      );
      return res.meta.changes > 0;
    },
    async listSponsorInquiries(site, cursor, limit) {
      const binds: unknown[] = [site];
      let sql = "SELECT * FROM lp_sponsor_inquiries WHERE site = ?";
      const c = cursor ? parseCursor(cursor) : null;
      if (c) {
        sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
        binds.push(c.at, c.at, c.id);
      }
      sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
      binds.push(limit);
      return (await db.all<InquiryDbRow>(sql, ...binds)).map(toRow);
    },
    async sponsorInquiryTotals(site) {
      const r = await db.first<{ total: number; open: number | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS open
         FROM lp_sponsor_inquiries WHERE site = ?`,
        site,
      );
      return { total: r?.total ?? 0, open: r?.open ?? 0 };
    },
    async countSponsorInquiriesSince(site, since, clientKey) {
      const r = clientKey
        ? await db.first<{ c: number }>(
            "SELECT COUNT(*) AS c FROM lp_sponsor_inquiries WHERE site = ? AND client_key = ? AND created_at >= ?",
            site,
            clientKey,
            since,
          )
        : await db.first<{ c: number }>(
            "SELECT COUNT(*) AS c FROM lp_sponsor_inquiries WHERE site = ? AND created_at >= ?",
            site,
            since,
          );
      return r?.c ?? 0;
    },
  };
}

/** Same semantics as the D1 repo. Mixed into InMemoryLpRepo. */
export function memorySponsorInquiryRepo(): SponsorInquiryRepo & { sponsorInquiries: SponsorInquiryRow[] } {
  const settings = new Map<string, SponsorSettingsRow>();
  const rows: SponsorInquiryRow[] = [];
  const upsert = (site: string, patch: Partial<SponsorSettingsRow>, updatedBy: string, updatedAt: string) => {
    const cur = settings.get(site) ?? { site, enabled: false, notifyEmail: null, updatedBy: null, updatedAt };
    settings.set(site, { ...cur, ...patch, updatedBy, updatedAt });
  };
  const key = (p: SponsorInquiryRow) => `${p.createdAt}~${p.id}`;
  return {
    sponsorInquiries: rows,
    async getSponsorSettings(site) {
      const s = settings.get(site);
      return s ? { ...s } : null;
    },
    async setSponsorEnabled(site, enabled, by, at) {
      upsert(site, { enabled }, by, at);
    },
    async setSponsorNotify(site, n, by, at) {
      upsert(site, { notifyEmail: n.notifyEmail }, by, at);
    },
    async insertSponsorInquiry(row) {
      rows.push({ ...row });
    },
    async setSponsorInquiryNotified(site, id, via) {
      const r = rows.find((x) => x.site === site && x.id === id);
      if (r) r.notifiedVia = via;
    },
    async getSponsorInquiry(site, id) {
      const r = rows.find((x) => x.site === site && x.id === id);
      return r ? { ...r } : null;
    },
    async setSponsorInquiryStatus(site, id, status, by, at) {
      const r = rows.find((x) => x.site === site && x.id === id);
      if (!r) return false;
      Object.assign(r, { status, updatedBy: by, updatedAt: at });
      return true;
    },
    async listSponsorInquiries(site, cursor, limit) {
      return rows
        .filter((p) => p.site === site && (!cursor || key(p) < cursor))
        .sort((a, b) => (key(a) < key(b) ? 1 : -1))
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },
    async sponsorInquiryTotals(site) {
      const mine = rows.filter((p) => p.site === site);
      return { total: mine.length, open: mine.filter((p) => p.status === "new").length };
    },
    async countSponsorInquiriesSince(site, since, clientKey) {
      return rows.filter((p) => p.site === site && p.createdAt >= since && (!clientKey || p.clientKey === clientKey)).length;
    },
  };
}
