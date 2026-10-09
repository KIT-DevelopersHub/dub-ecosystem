// LP管理 feature api adapter (流入ログ). Like mail/driveshare it rides the ONE shell
// api-client (src/lib/api-client.tsx): session cookie, 401→refresh, requestId, error
// normalization. Callers never write fetch and never paste a token.
//
// SCOPE: read-only. This file freezes the WIRE CONTRACT the (not yet built) LP visit
// backend must serve — `GET /api/v1/lp/stats` and `GET /api/v1/lp/visits` under
// /api/v1/lp. The demo transport (lib/demo-seed.tsx createLpStore) answers exactly
// these two shapes, so the screen is exercisable offline before the backend lands.
//
// Types are declared locally (not in @dub/types): the LP visit shapes are not in the
// frozen contract yet, exactly like driveshare's drive:read/drive:write shapes.
import type { ApiClient } from "../../lib/api-client.tsx";

/** How the visit was classified. `bot` is counted separately and excluded from totals. */
export type LpDevice = "mobile" | "desktop" | "bot" | "unknown";

/** `redirect` = arrived through an issued 流入URL (linkId set); `ingest` = the LP itself
 *  reported the pageview (no link, e.g. someone typed the URL). */
export type LpVisitKind = "redirect" | "ingest";

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

/** サイト全体のアクセス（Cloudflare Web Analytics・LP に元から入っている計測）。
 *  configured=false はその環境でトークン/サイトタグが未設定。 */
export interface LpSiteTraffic {
  configured: boolean;
  range: { from: string; to: string };
  totals: { pageViews: number; visits: number };
  byDay: { date: string; pageViews: number; visits: number }[];
  byReferrer: { key: string; label: string; pageViews: number; visits: number }[];
}

/** `from`/`to` are inclusive calendar days (YYYY-MM-DD) — NOT timestamps, so the query
 *  key is stable across a session and the dashboard does not refetch on every render. */
export interface LpStatsQuery {
  from: string;
  to: string;
  includeBots?: boolean;
}

export interface LpVisitsQuery {
  from: string;
  to: string;
  source?: string;
  cursor?: string;
  limit?: number;
}

export interface LpVisitsPage {
  items: LpVisit[];
  nextCursor: string | null;
}

/** 発行済みの流入URL（計測つき LP URL）1 本。`slug` が utm_source に載る値。 */
export interface LpLink {
  id: string;
  name: string;
  slug: string;
  /** サーバーが組み立てた実 URL。表示・コピーはこれを使う（クライアント組み立てと一致が正）。 */
  url: string;
  /** false = 停止中。集計は残したまま「新しい共有には使わない」印。 */
  active: boolean;
  createdAt: string;
}

/** 問い合わせ期間内の、その流入URL経由の実績。 */
export interface LpLinkStats {
  visits: number;
  uniques: number;
  lastVisitAt: string | null;
}

export interface LpLinkSummary extends LpLink {
  stats: LpLinkStats;
}

/** 一覧は「どの期間の実績つきで見るか」を伴う（ログ管理タブと同じ日の閉区間）。 */
export interface LpLinksQuery {
  from: string;
  to: string;
}

export interface LpLinksPage {
  items: LpLinkSummary[];
}

export interface CreateLpLinkInput {
  name: string;
  /** 正規化済み（小文字）のパラメータ値。サーバー側も再正規化し重複は 409 で弾く。 */
  slug: string;
}

export interface LpApi {
  /** Aggregated visit counters for a day range (app:lp:view). */
  getStats(query: LpStatsQuery): Promise<LpStats>;
  /** Site-wide PV / visits / referrers from Cloudflare Web Analytics (app:lp:view). */
  getSiteTraffic(query: LpLinksQuery): Promise<LpSiteTraffic>;
  /** One cursor page of raw visits, newest first (app:lp:view). */
  listVisits(query: LpVisitsQuery): Promise<LpVisitsPage>;
  /** Issued tracking links with their in-range counters (app:lp:view). */
  listLinks(query: LpLinksQuery): Promise<LpLinksPage>;
  /** Issue a new tracking link (app:lp:edit). Duplicate slug → 409. */
  createLink(input: CreateLpLinkInput, query: LpLinksQuery): Promise<LpLinkSummary>;
  /** Pause / resume an issued link (app:lp:edit). Counters are never deleted. */
  setLinkActive(input: { id: string; active: boolean }, query: LpLinksQuery): Promise<LpLinkSummary>;
}

const BASE = "/api/v1/lp";

export function createLpApi(api: ApiClient): LpApi {
  return {
    getStats: (query) => {
      const q: Record<string, string | number | boolean | undefined> = { from: query.from, to: query.to };
      if (query.includeBots !== undefined) q.includeBots = query.includeBots;
      return api.request<LpStats>({ method: "GET", path: `${BASE}/stats`, query: q });
    },
    getSiteTraffic: (query) =>
      api.request<LpSiteTraffic>({
        method: "GET",
        path: `${BASE}/site-traffic`,
        query: { from: query.from, to: query.to },
      }),
    listVisits: (query) => {
      const q: Record<string, string | number | boolean | undefined> = { from: query.from, to: query.to };
      if (query.source !== undefined) q.source = query.source;
      if (query.cursor !== undefined) q.cursor = query.cursor;
      if (query.limit !== undefined) q.limit = query.limit;
      return api.request<LpVisitsPage>({ method: "GET", path: `${BASE}/visits`, query: q });
    },
    listLinks: (query) =>
      api.request<LpLinksPage>({ method: "GET", path: `${BASE}/links`, query: { from: query.from, to: query.to } }),
    // 作成・更新も from/to を載せる: 返す 1 件に「その期間の実績」を同梱させ、画面が
    // 作成直後に別途集計を取り直さずに済む（無料枠の読み取りを増やさない）。
    createLink: (input, query) =>
      api.request<LpLinkSummary, CreateLpLinkInput>({
        method: "POST",
        path: `${BASE}/links`,
        query: { from: query.from, to: query.to },
        body: input,
      }),
    setLinkActive: ({ id, active }, query) =>
      api.request<LpLinkSummary, { active: boolean }>({
        method: "PATCH",
        path: `${BASE}/links/${encodeURIComponent(id)}`,
        query: { from: query.from, to: query.to },
        body: { active },
      }),
  };
}
