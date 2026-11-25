// Service-local types for lp-analytics (LP管理: 流入URL + LP 訪問ログ). The wire shapes
// mirror the contract frozen by fe2 (apps/fe2-app-shell/src/features/lp/lpApi.tsx) —
// that file and the demo transport answer exactly these, so keep them in lockstep.
import type { MiddlewareHandler, Context } from "hono";
import type { PermissionGranter } from "@dub/policy-gate";
import type { common, identity, lp } from "@dub/types";
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
/** lp_publish row: the version live on a public site (公開版切り替え). */
export interface PublishRow {
  site: string;
  versionId: string;
  updatedBy: string | null;
  updatedAt: string;
}

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
  /** Narrow to one source (utm_source slug / "direct"). Omitted = every source. */
  source?: string;
}

export interface AggregateRow {
  key: string;
  visits: number;
  uniques: number;
  lastVisitAt: string | null;
}

// ---- custom form fields (shared with lp-tickets via @dub/types) ----
export type LpFormField = lp.LpFormField;
export type LpFormAnswer = lp.LpFormAnswer;

// ---- proposals wire (lockstep with fe2 lpApi.tsx) ----
/** submitted = 未対応 / accepted = 採択 / rejected = 見送り。 */
export type LpProposalStatus = "submitted" | "accepted" | "rejected";
export interface LpProposalsState {
  site: string;
  enabled: boolean;
  publicUrl: string;
  /** 追加の入力項目（氏名・メール・タイトル・概要は固定なので含めない）。未保存なら既定の項目。 */
  fields: LpFormField[];
  totals: { total: number; accepted: number; rejected: number };
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface LpProposal {
  id: string;
  speakerName: string;
  email: string;
  title: string;
  abstract: string;
  answers: LpFormAnswer[];
  status: LpProposalStatus;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface LpProposalsPage {
  items: LpProposal[];
  nextCursor: string | null;
}

// ---- proposals persistence ----
export interface ProposalSettingsRow {
  site: string;
  enabled: boolean;
  /** null = never saved (use the service default). */
  fields: LpFormField[] | null;
  updatedBy: string | null;
  updatedAt: string;
}
export interface ProposalRow extends LpProposal {
  site: string;
  /** 送信元 IP のハッシュ（LP Worker が計算）。応募一覧には出さない。 */
  clientKey: string | null;
}

export interface LpProposalRepo {
  getProposalSettings(site: string): Promise<ProposalSettingsRow | null>;
  /** Upsert; only the given column changes. */
  setProposalEnabled(site: string, enabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  setProposalFields(site: string, fields: LpFormField[], updatedBy: string, updatedAt: string): Promise<void>;
  insertProposal(row: ProposalRow): Promise<void>;
  getProposal(site: string, id: string): Promise<ProposalRow | null>;
  /** false when the proposal does not exist. */
  setProposalStatus(site: string, id: string, status: LpProposalStatus, reviewedBy: string, updatedAt: string): Promise<boolean>;
  /** Newest first, keyset by (created_at, id). */
  listProposals(site: string, cursor: string | null, limit: number): Promise<ProposalRow[]>;
  proposalTotals(site: string): Promise<{ total: number; accepted: number; rejected: number }>;
  /** Proposals created at/after `since` (daily submit cap). With clientKey: only that sender's. */
  countProposalsSince(site: string, since: string, clientKey?: string): Promise<number>;
}

// ---- 公開設定（lp_site_config）----
export interface SiteConfigRow {
  site: string;
  /** LpSiteConfig の JSON。"{}" = まだ保存していない（本番と同じ）。 */
  draftJson: string;
  /** LpLayout の JSON。 */
  publishedJson: string;
  revision: number;
  draftUpdatedBy: string | null;
  draftUpdatedAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
}

export interface SiteConfigHistoryRow {
  id: string;
  site: string;
  configJson: string;
  publishedBy: string;
  publishedAt: string;
}

export interface SiteConfigPublishInput {
  site: string;
  expectedRevision: number;
  layoutJson: string;
  /** 履歴に残す LpSiteConfig 全体。 */
  configJson: string;
  release: lp.LpRelease;
  historyId: string;
  updatedBy: string;
  updatedAt: string;
}

export interface LpSiteConfigRepo {
  getSiteConfig(site: string): Promise<SiteConfigRow | null>;
  /** 下書きを保存して revision を 1 進める。expectedRevision が null なら照合しない。false = revision 不一致。 */
  saveSiteConfigDraft(
    site: string,
    draftJson: string,
    expectedRevision: number | null,
    updatedBy: string,
    updatedAt: string,
  ): Promise<boolean>;
  /**
   * 本番反映を 1 トランザクションで書く: lp_site_config.published_json + revision、lp_publish、
   * lp_proposal_settings.enabled、履歴 1 行。チケットの販売状態は別 D1（lp-tickets）なのでここでは書かない。
   * 既存 2 テーブルは値が変わる行だけ更新する（変わらない項目の更新者・日時は残す）。false = revision 不一致（何も書かない）。
   */
  publishSiteConfig(input: SiteConfigPublishInput): Promise<boolean>;
  /** 本番反映の履歴（新しい順）。 */
  listSiteConfigHistory(site: string, limit: number): Promise<SiteConfigHistoryRow[]>;
}

export interface LpRepo extends LpProposalRepo, LpSiteConfigRepo {
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
  /** null when the site has no row yet (callers fall back to the default version). */
  getPublish(site: string): Promise<PublishRow | null>;
  /** Upsert the live version for a site. */
  setPublish(site: string, versionId: string, updatedBy: string, updatedAt: string): Promise<void>;
}

export interface ReqCtx {
  requestId: string;
  userId: common.UserId;
}

/** lp-tickets が正本の release 2 項目（チケット販売 on/off・LP の CTA 差し替え）。 */
export interface TicketRelease {
  ticketsEnabled: boolean;
  ticketsCtaEnabled: boolean;
}

/** lp-tickets への s2s（SVC_LP_TICKETS）。読めない時は throw する = 不明な値で本番を書き換えない。 */
export interface TicketReleaseClient {
  get(): Promise<TicketRelease>;
  set(release: TicketRelease, updatedBy: common.UserId): Promise<void>;
}

export interface AppDeps {
  repo: LpRepo;
  /** Which of the requested permission keys the caller holds (identity /authz/check). */
  authz: PermissionGranter;
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
  ticketRelease: TicketReleaseClient;
  newProposalId: () => string;
  /** 本番反映の履歴 id（lp_site_config_history）。 */
  newSiteConfigHistoryId: () => string;
  /** 1 日 (JST) に受け付ける登壇応募の上限。公開フォームからの書き込み濫用の天井。 */
  dailyProposalCap: number;
}
