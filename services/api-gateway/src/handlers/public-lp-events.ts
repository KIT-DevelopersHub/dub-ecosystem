// POST /api/v1/public/lp-events — public (unauthenticated) LP アクセス解析ビーコン（#904）。
// The LP Worker injects a small script that sends ONE navigator.sendBeacon per page when the
// page is hidden / left (text/plain = CORS simple request, response unread).
//
// Edge-only work here, then a genuine s2s forward to lp-analytics /lp/internal/events:
//   * Origin filter (same allow-list as /lp-visits) — others get the same 204 and are dropped.
//   * DNT: 1 / Sec-GPC: 1 → dropped (the script already stays silent; this is defense in depth).
//   * UA + low-entropy Client Hints → device / OS / browser FAMILY only; bots are dropped.
//   * country + ISO 3166-2 region from the Cloudflare edge (request.cf), never from the client.
//   * referrer → host only (self-referral removed).
// Nothing identifying is forwarded: no IP, no UA string, no visitor / session id. lp-analytics
// only adds the result to per-day counters (no per-visit row).
import type { Context } from "hono";
import { lpInsights } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices } from "../services";
import { lpOrigins, optedOut } from "./public-lp-visit";

const SYSTEM_ACTOR = "system:public-lp-visit";

/** Host of the referrer, or null when absent / unparsable / the LP itself. */
function referrerHost(raw: string | null, selfOrigin: string): string | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).host.toLowerCase();
    const self = new URL(selfOrigin).host.toLowerCase();
    return host && host !== self && host !== `www.${self}` && `www.${host}` !== self ? host : null;
  } catch {
    return null;
  }
}

export async function publicLpEventsHandler(
  c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>,
): Promise<Response> {
  const drop = c.body(null, 204);
  const origin = c.req.header("origin");
  if (!origin || !lpOrigins(c.env).includes(origin)) return drop;
  if (optedOut(c.req.header("dnt"), c.req.header("sec-gpc"))) return drop;
  if (Number(c.req.header("content-length") ?? 0) > lpInsights.LP_INSIGHT_BODY_MAX) return drop;
  const text = await c.req.text();
  if (text.length > lpInsights.LP_INSIGHT_BODY_MAX) return drop;
  let beacon: lpInsights.LpInsightBeacon | null;
  try {
    beacon = lpInsights.parseInsightBeacon(JSON.parse(text));
  } catch {
    beacon = null;
  }
  if (!beacon) return drop;

  const cls = lpInsights.classifyClient(c.req.header("user-agent"), {
    mobile: c.req.header("sec-ch-ua-mobile") ?? null,
    platform: c.req.header("sec-ch-ua-platform") ?? null,
  });
  if (cls.device === "bot") return drop;
  const cf = (c.req.raw as unknown as { cf?: { country?: unknown; regionCode?: unknown } }).cf;
  const rawCountry = typeof cf?.country === "string" ? cf.country : (c.req.header("cf-ipcountry") ?? null);
  const country = rawCountry && /^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : null;

  // 訪問の属性（端末・地域・流入元）は入口ページだけで数えるので、それ以外のビーコンには載せない。
  const first = beacon.first;
  const ingest: lpInsights.LpInsightIngest = {
    path: beacon.path,
    first,
    source: beacon.src,
    medium: first ? beacon.med : null,
    campaign: first ? beacon.cmp : null,
    referrerHost: first ? referrerHost(beacon.ref, origin) : null,
    device: first ? cls.device : null,
    os: first ? cls.os : null,
    browser: first ? cls.browser : null,
    country: first ? country : null,
    region: first ? lpInsights.regionKey(country, cf?.regionCode) : null,
    engagedMs: beacon.ms,
    scroll: lpInsights.scrollBucket(beacon.scroll),
    sections: beacon.sec,
    ctas: beacon.cta,
    steps: beacon.steps.filter(lpInsights.isLpInsightStep),
    vitals:
      first && beacon.vit
        ? { lcp: beacon.vit.lcp ?? null, inp: beacon.vit.inp ?? null, cls: beacon.vit.cls ?? null }
        : null,
  };

  const svc = createServices(c.env);
  const ctx: RequestContext = { requestId: getRequestId(c), userId: SYSTEM_ACTOR, caller: "api-gateway" };
  await svc.lp.post(ctx, "/lp/internal/events", ingest);
  return drop;
}
