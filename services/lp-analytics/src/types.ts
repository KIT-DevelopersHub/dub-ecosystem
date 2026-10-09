// Service-local types for lp-analytics (LP管理: 流入URL + LP 訪問ログ). The wire shapes
// mirror the contract frozen by fe2 (apps/fe2-app-shell/src/features/lp/lpApi.tsx) —
// that file and the demo transport answer exactly these, so keep them in lockstep.
import type { MiddlewareHandler, Context } from "hono";
import type { common, identity, policy } from "@dub/types";
import type { SiteTrafficSource } from "./site-traffic";

export type LpDevice = "mobile" | "desktop" | "bot" | "unknown";
/** redirect = arrived through an issued 流入URL (linkId set); ingest = no matching link. */
export type LpVisitKind = "redirect" | "ingest";

// ---- wire ----
export interface LpVisit {
  id: string;
  linkId: string | null;
  source: string;
  lpVersion: string | null;
  path: string | null;
  referrerHost: string | null;
  country: string | null;
  device: LpDevice;
  kind: LpVisitKind;
  occurredAt: string;
}

export interface LpStatsBucket {
  key: string;
  label: string;
  visits: number;
  uniques: number;
}

export interface LpStats {
  range: { from: string; to: string };
  totals: { visits: number; uniques: number; botExcluded: number };
  bySource: LpStatsBucket[];
  byDay: { date: string; visits: number }[];
  byDevice: LpStatsBucket[];
}

/** Site-wide traffic from Cloudflare Web Analytics (exists from before lp-analytics).
 *  configured=false: the token / site tag is not set in this environment. */
export interface LpSiteTraffic {
  configured: boolean;
  range: { from: string; to: string };
  totals: { pageViews: number; visits: number };
  byDay: { date: string; pageViews: number; visits: number }[];
  byReferrer: { key: string; label: string; pageViews: number; visits: number }[];
}

export interface LpVisitsPage {
  items: LpVisit[];
  nextCursor: string | null;
}

export interface LpLink {
  id: string;
  name: string;
  slug: string;
  url: string;
  active: boolean;
  createdAt: string;
}

export interface LpLinkStats {
  visits: number;
  uniques: number;
  lastVisitAt: string | null;
}

export interface LpLinkSummary extends LpLink {
  stats: LpLinkStats;
}

/** What the gateway's public beacon forwards (already sanitized + classified there). */
export interface IngestVisitRequest {
  source: string | null;
  path: string | null;
  lpVersion: string | null;
  referrerHost: string | null;
  country: string | null;
  device: LpDevice;
  visitorKey: string;
}

// ---- persistence ----
export interface LinkRow {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisitRow extends LpVisit {
  orgId: string;
  visitorKey: string;
  dayJst: string;
}

export type AggregateBy = "source" | "device" | "day" | "link";

export interface AggregateQuery {
  orgId: string;
  from: string;
  to: string;
  includeBots: boolean;
}

export interface AggregateRow {
  key: string;
  visits: number;
  uniques: number;
  lastVisitAt: string | null;
}

export interface LpRepo {
  listLinks(orgId: string): Promise<LinkRow[]>;
  getLink(orgId: string, id: string): Promise<LinkRow | null>;
  getLinkBySlug(orgId: string, slug: string): Promise<LinkRow | null>;
  /** false when (org, slug) already exists. */
  insertLink(row: LinkRow): Promise<boolean>;
  setLinkActive(orgId: string, id: string, active: boolean, updatedAt: string): Promise<void>;
  /** false when the (visitor, day, source, path) dedupe key already exists. */
  insertVisit(row: VisitRow): Promise<boolean>;
  /** Visits recorded on a JST day (the daily ingest cap's counter). */
  recordedOn(dayJst: string): Promise<number>;
  bumpRecorded(dayJst: string, now: string): Promise<void>;
  /** Grand total over the range (one row, key ""). */
  total(q: AggregateQuery): Promise<AggregateRow>;
  countBots(q: Omit<AggregateQuery, "includeBots">): Promise<number>;
  aggregate(q: AggregateQuery, by: AggregateBy): Promise<AggregateRow[]>;
  /** Non-bot visits, newest first, keyset-paged by (day_jst, id) — see visitCursor. */
  listVisits(q: { orgId: string; from: string; to: string; source?: string; cursor?: string; limit: number }): Promise<VisitRow[]>;
}

export interface ReqCtx {
  requestId: string;
  userId: common.UserId;
}

export interface Authz {
  requireAuth(): MiddlewareHandler;
  requireAppAccess(
    app: string,
    level: policy.AppAccessLevel,
    extra?: { permission?: identity.PermissionKey; resolve?: (c: Context) => { orgId?: string } },
  ): MiddlewareHandler;
}

export interface AppDeps {
  repo: LpRepo;
  authz: Authz;
  orgId: common.OrgId;
  /** 公開 LP の URL。流入URL はこれ + ?utm_source=<slug>。 */
  lpBaseUrl: string;
  now: () => string;
  newLinkId: () => string;
  newVisitId: () => string;
  /** 1 日に記録する訪問の上限。匿名ビーコンが共有 D1 の書き込み枠を食い潰さないための天井。 */
  dailyVisitCap: number;
  /** Cloudflare Web Analytics reader. null when not configured in this environment. */
  siteTraffic: SiteTrafficSource | null;
}
