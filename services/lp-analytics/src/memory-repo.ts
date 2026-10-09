// In-memory LpRepo for tests — same semantics as the D1 repo (bots excluded unless asked,
// link aggregation skips untagged visits, visits newest-first by id).
import type { AggregateBy, AggregateQuery, AggregateRow, LinkRow, LpRepo, VisitRow } from "./types";

export class InMemoryLpRepo implements LpRepo {
  links: LinkRow[] = [];
  visits: VisitRow[] = [];

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
}
