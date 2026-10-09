// LpService — business rules over LpRepo. Reads aggregate in SQL (GROUP BY) so a range
// costs one indexed scan per bucket kind, never a row-by-row pull into the Worker.
import { errors } from "@dub/errors";
import {
  DEVICE_LABELS,
  DIRECT_LABEL,
  DIRECT_SOURCE,
  LP_NAME_MAX,
  buildTrackingUrl,
  dayJst,
  eachDay,
  isValidSlug,
  normalizeSlug,
  parseRange,
  sourceFromParam,
} from "./domain";
import { visitCursor } from "./d1-repo";
import { referrerLabel } from "./site-traffic";
import type {
  AppDeps,
  IngestVisitRequest,
  LinkRow,
  LpLink,
  LpLinkStats,
  LpLinkSummary,
  LpStats,
  LpSiteTraffic,
  LpVisitsPage,
  ReqCtx,
} from "./types";

const EMPTY_STATS: LpLinkStats = { visits: 0, uniques: 0, lastVisitAt: null };
const DEFAULT_PAGE = 25;
const MAX_PAGE = 200;

export interface RangeQuery {
  from?: string;
  to?: string;
}

export class LpService {
  constructor(private readonly deps: AppDeps) {}

  private toLink(row: LinkRow): LpLink {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      url: buildTrackingUrl(this.deps.lpBaseUrl, row.slug),
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  private async linkStats(range: { from: string; to: string }): Promise<Map<string, LpLinkStats>> {
    const rows = await this.deps.repo.aggregate({ orgId: this.deps.orgId, ...range, includeBots: false }, "link");
    return new Map(rows.map((r) => [r.key, { visits: r.visits, uniques: r.uniques, lastVisitAt: r.lastVisitAt }]));
  }

  async listLinks(q: RangeQuery): Promise<{ items: LpLinkSummary[] }> {
    const range = parseRange(q.from, q.to);
    const [links, stats] = await Promise.all([this.deps.repo.listLinks(this.deps.orgId), this.linkStats(range)]);
    const items = links
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((l) => ({ ...this.toLink(l), stats: stats.get(l.id) ?? EMPTY_STATS }));
    return { items };
  }

  async createLink(ctx: ReqCtx, body: unknown, q: RangeQuery): Promise<LpLinkSummary> {
    const range = parseRange(q.from, q.to);
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const slug = typeof b.slug === "string" ? normalizeSlug(b.slug) : "";
    const bad: { field: string; reason: string }[] = [];
    if (name.length === 0) bad.push({ field: "name", reason: "required" });
    else if (name.length > LP_NAME_MAX) bad.push({ field: "name", reason: "too_long" });
    if (!isValidSlug(slug)) bad.push({ field: "slug", reason: "invalid" });
    // "direct" is the bucket for untagged visits — issuing it would merge two meanings.
    else if (slug === DIRECT_SOURCE) bad.push({ field: "slug", reason: "reserved" });
    if (bad.length > 0) throw errors.validationFailed(bad);

    const now = this.deps.now();
    const row: LinkRow = {
      id: this.deps.newLinkId(),
      orgId: this.deps.orgId,
      name,
      slug,
      active: true,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.deps.repo.insertLink(row))) throw errors.conflict(`「${slug}」は既に発行済みです`);
    // 発行前に同じ値で流入していた訪問は link に紐付いていない（記録時点で link が無い）ので
    // 実績は常に 0 から始まる。後付けで過去分を寄せると「発行前の数字」が混ざるため寄せない。
    const stats = (await this.linkStats(range)).get(row.id) ?? EMPTY_STATS;
    return { ...this.toLink(row), stats };
  }

  async setLinkActive(id: string, body: unknown, q: RangeQuery): Promise<LpLinkSummary> {
    const range = parseRange(q.from, q.to);
    const active = (body as { active?: unknown } | null)?.active;
    if (typeof active !== "boolean") throw errors.validationFailed([{ field: "active", reason: "required" }]);
    const link = await this.deps.repo.getLink(this.deps.orgId, id);
    if (!link) throw errors.notFound("lp_link", id);
    const now = this.deps.now();
    await this.deps.repo.setLinkActive(this.deps.orgId, id, active, now);
    const stats = (await this.linkStats(range)).get(id) ?? EMPTY_STATS;
    return { ...this.toLink({ ...link, active, updatedAt: now }), stats };
  }

  async getStats(q: RangeQuery & { includeBots?: string }): Promise<LpStats> {
    const range = parseRange(q.from, q.to);
    const includeBots = q.includeBots === "true";
    const base = { orgId: this.deps.orgId, ...range, includeBots };
    const [total, bots, bySource, byDevice, byDay, links] = await Promise.all([
      this.deps.repo.total(base),
      includeBots ? Promise.resolve(0) : this.deps.repo.countBots({ orgId: this.deps.orgId, ...range }),
      this.deps.repo.aggregate(base, "source"),
      this.deps.repo.aggregate(base, "device"),
      this.deps.repo.aggregate(base, "day"),
      this.deps.repo.listLinks(this.deps.orgId),
    ]);
    const nameBySlug = new Map(links.map((l) => [l.slug, l.name]));
    const sourceLabel = (key: string): string => (key === DIRECT_SOURCE ? DIRECT_LABEL : (nameBySlug.get(key) ?? key));
    const perDay = new Map(byDay.map((r) => [r.key, r.visits]));
    const byVisits = <T extends { visits: number }>(a: T, b: T): number => b.visits - a.visits;

    return {
      range,
      totals: { visits: total.visits, uniques: total.uniques, botExcluded: bots },
      bySource: bySource
        .map((r) => ({ key: r.key, label: sourceLabel(r.key), visits: r.visits, uniques: r.uniques }))
        .sort(byVisits),
      byDay: eachDay(range.from, range.to).map((date) => ({ date, visits: perDay.get(date) ?? 0 })),
      byDevice: byDevice
        .map((r) => ({ key: r.key, label: DEVICE_LABELS[r.key] ?? r.key, visits: r.visits, uniques: r.uniques }))
        .sort(byVisits),
    };
  }

  /** Cloudflare Web Analytics for the LP site, per JST day + referrer (hosts merged by label).
   *  The referrer split is sampled separately, so its sum can differ a little from the totals. */
  async getSiteTraffic(q: RangeQuery): Promise<LpSiteTraffic> {
    const range = parseRange(q.from, q.to);
    const days = eachDay(range.from, range.to);
    const empty = { range, totals: { pageViews: 0, visits: 0 }, byReferrer: [] };
    const zeroDays = days.map((date) => ({ date, pageViews: 0, visits: 0 }));
    if (!this.deps.siteTraffic) return { configured: false, ...empty, byDay: zeroDays };

    const data = await this.deps.siteTraffic.fetchDays(days);
    const lpHost = new URL(this.deps.lpBaseUrl).host;
    const perDay = new Map(zeroDays.map((d) => [d.date, { ...d }]));
    const totals = { pageViews: 0, visits: 0 };
    for (const r of data.days) {
      const day = perDay.get(r.date);
      if (!day) continue;
      day.pageViews += r.pageViews;
      day.visits += r.visits;
      totals.pageViews += r.pageViews;
      totals.visits += r.visits;
    }
    const perLabel = new Map<string, { key: string; label: string; pageViews: number; visits: number }>();
    for (const r of data.referrers) {
      const label = referrerLabel(r.host, lpHost);
      const bucket = perLabel.get(label) ?? { key: r.host || "direct", label, pageViews: 0, visits: 0 };
      bucket.pageViews += r.pageViews;
      bucket.visits += r.visits;
      perLabel.set(label, bucket);
    }
    return {
      configured: true,
      range,
      totals,
      byDay: [...perDay.values()],
      byReferrer: [...perLabel.values()].sort((a, b) => b.pageViews - a.pageViews),
    };
  }

  async listVisits(q: RangeQuery & { source?: string; cursor?: string; limit?: string }): Promise<LpVisitsPage> {
    const range = parseRange(q.from, q.to);
    const parsed = Number(q.limit ?? DEFAULT_PAGE);
    const limit = Number.isFinite(parsed) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(parsed))) : DEFAULT_PAGE;
    // Fetch one extra row to know whether another page exists without a COUNT(*).
    const rows = await this.deps.repo.listVisits({
      orgId: this.deps.orgId,
      ...range,
      ...(q.source ? { source: q.source } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ orgId: _o, visitorKey: _v, dayJst: _d, ...v }) => v),
      nextCursor: rows.length > limit && page.length > 0 ? visitCursor(page[page.length - 1]!) : null,
    };
  }

  /** Public beacon landing (s2s from the gateway). Matching is by slug at record time.
   *  Over the daily cap the visit is dropped silently (1 row read, zero writes). */
  async ingestVisit(body: IngestVisitRequest): Promise<void> {
    const occurredAt = this.deps.now();
    const day = dayJst(occurredAt);
    if ((await this.deps.repo.recordedOn(day)) >= this.deps.dailyVisitCap) return;
    const source = sourceFromParam(body.source);
    const link = source === DIRECT_SOURCE ? null : await this.deps.repo.getLinkBySlug(this.deps.orgId, source);
    const inserted = await this.deps.repo.insertVisit({
      id: this.deps.newVisitId(),
      orgId: this.deps.orgId,
      // 停止中の流入URLも紐付ける: 停止は「新しい共有に使わない」印で、既に貼られた URL
      // からの流入は実績として数え続ける（集計は消さない、と画面で約束している）。
      linkId: link?.id ?? null,
      source,
      lpVersion: body.lpVersion,
      path: body.path ?? "/",
      referrerHost: body.referrerHost,
      country: body.country,
      device: body.device,
      kind: link ? "redirect" : "ingest",
      visitorKey: body.visitorKey,
      dayJst: day,
      occurredAt,
    });
    if (inserted) await this.deps.repo.bumpRecorded(day, occurredAt);
  }
}
