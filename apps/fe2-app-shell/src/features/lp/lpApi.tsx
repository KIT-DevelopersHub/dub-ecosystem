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

export interface LpApi {
  /** Aggregated visit counters for a day range (app:lp:view). */
  getStats(query: LpStatsQuery): Promise<LpStats>;
  /** One cursor page of raw visits, newest first (app:lp:view). */
  listVisits(query: LpVisitsQuery): Promise<LpVisitsPage>;
}

const BASE = "/api/v1/lp";

export function createLpApi(api: ApiClient): LpApi {
  return {
    getStats: (query) => {
      const q: Record<string, string | number | boolean | undefined> = { from: query.from, to: query.to };
      if (query.includeBots !== undefined) q.includeBots = query.includeBots;
      return api.request<LpStats>({ method: "GET", path: `${BASE}/stats`, query: q });
    },
    listVisits: (query) => {
      const q: Record<string, string | number | boolean | undefined> = { from: query.from, to: query.to };
      if (query.source !== undefined) q.source = query.source;
      if (query.cursor !== undefined) q.cursor = query.cursor;
      if (query.limit !== undefined) q.limit = query.limit;
      return api.request<LpVisitsPage>({ method: "GET", path: `${BASE}/visits`, query: q });
    },
  };
}
