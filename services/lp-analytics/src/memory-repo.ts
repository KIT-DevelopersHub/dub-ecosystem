// In-memory LpRepo for tests — same semantics as the D1 repo (bots excluded unless asked,
// link aggregation skips untagged visits, visits newest-first by id).
import type {
  AggregateBy,
  AggregateQuery,
  AggregateRow,
  LinkRow,
  LpProposalStatus,
  LpRepo,
  LpFormField,
  ProposalRow,
  ProposalSettingsRow,
  PublishRow,
  SiteConfigHistoryRow,
  SiteConfigPublishInput,
  SiteConfigRow,
  VisitRow,
} from "./types";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryLpRepo implements LpRepo {
  links: LinkRow[] = [];
  visits: VisitRow[] = [];
  publish = new Map<string, PublishRow>();
  proposalSettings = new Map<string, ProposalSettingsRow>();
  proposals: ProposalRow[] = [];
  siteConfig = new Map<string, SiteConfigRow>();
  siteConfigHistory: SiteConfigHistoryRow[] = [];

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
  async setProposalFields(site: string, fields: LpFormField[], updatedBy: string, updatedAt: string) {
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
    return (
      v.orgId === q.orgId &&
      v.dayJst >= q.from &&
      v.dayJst <= q.to &&
      (q.includeBots === true || v.device !== "bot") &&
      (!q.source || v.source === q.source)
    );
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

  // ---- 公開設定: D1 と同じ規則（revision 照合・本番反映は全部書くか何も書かないか・値が変わる行だけ更新）----
  private siteConfigOf(site: string): SiteConfigRow {
    return (
      this.siteConfig.get(site) ?? {
        site,
        draftJson: "{}",
        publishedJson: "{}",
        revision: 0,
        draftUpdatedBy: null,
        draftUpdatedAt: null,
        publishedBy: null,
        publishedAt: null,
      }
    );
  }
  async getSiteConfig(site: string) {
    const r = this.siteConfig.get(site);
    return r ? clone(r) : null;
  }
  async saveSiteConfigDraft(site: string, draftJson: string, expectedRevision: number | null, updatedBy: string, updatedAt: string) {
    const cur = this.siteConfigOf(site);
    if (expectedRevision !== null && cur.revision !== expectedRevision) return false;
    this.siteConfig.set(site, { ...cur, draftJson, revision: cur.revision + 1, draftUpdatedBy: updatedBy, draftUpdatedAt: updatedAt });
    return true;
  }
  async publishSiteConfig(p: SiteConfigPublishInput) {
    const cur = this.siteConfigOf(p.site);
    if (cur.revision !== p.expectedRevision) return false;
    const r = p.release;
    this.siteConfig.set(p.site, {
      ...cur,
      publishedJson: p.layoutJson,
      revision: cur.revision + 1,
      publishedBy: p.updatedBy,
      publishedAt: p.updatedAt,
    });
    this.siteConfigHistory.push({
      id: p.historyId,
      site: p.site,
      configJson: p.configJson,
      publishedBy: p.updatedBy,
      publishedAt: p.updatedAt,
    });
    const pub = this.publish.get(p.site);
    if (!pub || pub.versionId !== r.versionId) await this.setPublish(p.site, r.versionId, p.updatedBy, p.updatedAt);
    const ps = this.proposalSettings.get(p.site);
    if (!ps || ps.enabled !== r.proposalsEnabled) await this.setProposalEnabled(p.site, r.proposalsEnabled, p.updatedBy, p.updatedAt);
    return true;
  }
  async listSiteConfigHistory(site: string, limit: number) {
    return this.siteConfigHistory
      .filter((h) => h.site === site)
      .sort((a, b) => (a.publishedAt === b.publishedAt ? (a.id < b.id ? 1 : -1) : a.publishedAt < b.publishedAt ? 1 : -1))
      .slice(0, limit)
      .map(clone);
  }
}
