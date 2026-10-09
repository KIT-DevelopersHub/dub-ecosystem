// Site-wide LP traffic from Cloudflare Web Analytics (RUM beacon auto-injected on the LP zone).
// This is the data that already exists from before lp-analytics: page views / visits per JST
// day and the referrer host. Read-only; nothing is stored in D1.
//
// Why aliases PER DAY: the RUM dataset is adaptively sampled and the sampling gets coarser as
// the window grows or a dimension is added (10/01: 82 PV ungrouped vs 120 grouped by referrer).
// So each JST day gets two aliases: an ungrouped total (the day's PV / visits) and a
// referrer breakdown. Cloudflare caps the nodes per request, so days are chunked.
import { errors } from "@dub/errors";

export const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
/** Two aliases per day. Verified against the live API: 25 aliases pass, 182 hit "quota". */
const DAYS_PER_REQUEST = 10;
/** Distinct referrer hosts kept per day. Days with more than this would undercount. */
const REFERRERS_PER_DAY = 100;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** One (JST day, referrer host) cell. host "" = no referrer (direct / app / typed URL). */
export interface SiteTrafficRow {
  date: string;
  host: string;
  pageViews: number;
  visits: number;
}

export interface SiteTrafficDay {
  date: string;
  pageViews: number;
  visits: number;
}

export interface SiteTrafficData {
  days: SiteTrafficDay[];
  referrers: SiteTrafficRow[];
}

export interface SiteTrafficSource {
  /** Totals + referrer rows for `days` (YYYY-MM-DD, JST). Days without traffic yield no rows. */
  fetchDays(days: readonly string[]): Promise<SiteTrafficData>;
}

export interface CfSiteTrafficConfig {
  token: string;
  accountId: string;
  siteTag: string;
  fetch?: typeof fetch;
}

/** JST day → the UTC instant it starts at. */
function jstDayStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - JST_OFFSET_MS).toISOString().replace(".000Z", "Z");
}

function nextDayStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - JST_OFFSET_MS + 86_400_000).toISOString().replace(".000Z", "Z");
}

export function buildQuery(days: readonly string[]): string {
  const parts = days.map((day, i) => {
    const filter = `filter: { siteTag: $siteTag, datetime_geq: "${jstDayStart(day)}", datetime_lt: "${nextDayStart(day)}" }`;
    return (
      `t${i}: rumPageloadEventsAdaptiveGroups(limit: 1, ${filter}) { count sum { visits } } ` +
      `r${i}: rumPageloadEventsAdaptiveGroups(limit: ${REFERRERS_PER_DAY}, ${filter}, orderBy: [count_DESC]) ` +
      `{ count sum { visits } dimensions { refererHost } }`
    );
  });
  return `query($accountTag: String!, $siteTag: String!) { viewer { accounts(filter: { accountTag: $accountTag }) { ${parts.join(" ")} } } }`;
}

interface RumGroup {
  count?: number;
  sum?: { visits?: number };
  dimensions?: { refererHost?: string | null };
}

interface GraphqlResponse {
  data?: { viewer?: { accounts?: Record<string, RumGroup[] | null>[] } } | null;
  errors?: { message?: string }[] | null;
}

export function createCfSiteTrafficSource(cfg: CfSiteTrafficConfig): SiteTrafficSource {
  const doFetch = cfg.fetch ?? fetch;

  async function fetchChunk(days: readonly string[]): Promise<SiteTrafficData> {
    let res: Response;
    try {
      res = await doFetch(CF_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: buildQuery(days), variables: { accountTag: cfg.accountId, siteTag: cfg.siteTag } }),
      });
    } catch (cause) {
      throw errors.upstreamUnavailable("cloudflare-analytics", cause);
    }
    const body = (await res.json().catch(() => ({}))) as GraphqlResponse;
    const account = body.data?.viewer?.accounts?.[0];
    if (!res.ok || (body.errors && body.errors.length > 0) || !account) {
      throw errors.upstreamUnavailable("cloudflare-analytics", body.errors?.[0]?.message ?? `HTTP ${res.status}`);
    }
    const out: SiteTrafficData = { days: [], referrers: [] };
    days.forEach((date, i) => {
      for (const g of account[`t${i}`] ?? []) {
        out.days.push({ date, pageViews: g.count ?? 0, visits: g.sum?.visits ?? 0 });
      }
      for (const g of account[`r${i}`] ?? []) {
        out.referrers.push({ date, host: g.dimensions?.refererHost ?? "", pageViews: g.count ?? 0, visits: g.sum?.visits ?? 0 });
      }
    });
    return out;
  }

  return {
    async fetchDays(days) {
      const chunks: string[][] = [];
      for (let i = 0; i < days.length; i += DAYS_PER_REQUEST) chunks.push(days.slice(i, i + DAYS_PER_REQUEST));
      const parts = await Promise.all(chunks.map(fetchChunk));
      return { days: parts.flatMap((p) => p.days), referrers: parts.flatMap((p) => p.referrers) };
    },
  };
}

const KNOWN_REFERRERS: Record<string, string> = {
  "t.co": "X (Twitter)",
  "x.com": "X (Twitter)",
  "m.facebook.com": "Facebook",
  "www.facebook.com": "Facebook",
  "l.facebook.com": "Facebook",
  "lm.facebook.com": "Facebook",
  "l.instagram.com": "Instagram",
  "www.google.com": "Google 検索",
  "www.bing.com": "Bing 検索",
  "search.yahoo.co.jp": "Yahoo! 検索",
  "camp-fire.jp": "CAMPFIRE",
  "connpass.com": "connpass",
};

/** Human label for a referrer host. The LP's own host means a move / reload inside the site. */
export function referrerLabel(host: string, lpHost: string): string {
  if (host === "") return "直接アクセス";
  if (host === lpHost || host === `www.${lpHost}`) return "サイト内の移動";
  return KNOWN_REFERRERS[host] ?? host;
}
