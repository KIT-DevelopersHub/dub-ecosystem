// POST /api/v1/public/lp-visits — public (unauthenticated) LP pageview beacon.
// The conference LP (hokuriku-it-conf.com) sends one navigator.sendBeacon per page load
// with { source (utm_source), path, lpVersion, referrer, vid }. sendBeacon posts
// text/plain, so this is a CORS "simple request" (no preflight, response unread).
//
// The gateway does the edge-only work, then forwards a sanitized row to lp-analytics'
// internal route as a genuine s2s call:
//   * Origin filter — only the LP origins are recorded; others get the same 204 but are
//     dropped (no signal for a scraper to tune against).
//   * UA → device (bots are recorded as `bot` and excluded from totals downstream).
//   * country from the Cloudflare edge (request.cf), never from the client.
//   * visitorKey = SHA-256 of the client's random anonymous id. Without one (storage
//     blocked) a fresh random key is used — never anything derived from IP / UA, which
//     an unsalted hash would make reversible. Raw IP / UA are never forwarded or stored.
// Global rate limiting (middleware) bounds abuse per IP.
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import { getRequestId } from "../context";
import { createServices } from "../services";

const SYSTEM_ACTOR = "system:public-lp-visit";
export const DEFAULT_LP_ORIGINS = ["https://hokuriku-it-conf.com", "https://www.hokuriku-it-conf.com"];
const MAX_BODY_CHARS = 2048;
const FIELD_MAX = 200;
const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|whatsapp|headless|lighthouse|pagespeed|phantomjs|python-requests|curl\/|wget\//i;
const MOBILE_RE = /mobi|android|iphone|ipad|ipod/i;

export type LpDevice = "mobile" | "desktop" | "bot" | "unknown";

export function classifyDevice(ua: string | undefined): LpDevice {
  if (!ua) return "unknown";
  if (BOT_RE.test(ua)) return "bot";
  return MOBILE_RE.test(ua) ? "mobile" : "desktop";
}

export function lpOrigins(env: GatewayEnv): string[] {
  const raw = env.LP_BEACON_ORIGINS;
  if (!raw) return DEFAULT_LP_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, FIELD_MAX) : null;

/** Host of the referrer, or null when absent / unparsable / the LP itself. */
function referrerHost(raw: string | null, selfOrigin: string | undefined): string | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).host.toLowerCase();
    const self = selfOrigin ? new URL(selfOrigin).host.toLowerCase() : null;
    return host && host !== self ? host : null;
  } catch {
    return null;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function publicLpVisitHandler(
  c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>,
): Promise<Response> {
  const origin = c.req.header("origin");
  if (!origin || !lpOrigins(c.env).includes(origin)) return c.body(null, 204);

  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_CHARS) {
    throw errors.validationFailed([{ field: "body", reason: "too_large" }]);
  }
  const text = await c.req.text();
  if (text.length > MAX_BODY_CHARS) throw errors.validationFailed([{ field: "body", reason: "too_large" }]);
  let b: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    b = parsed as Record<string, unknown>;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }

  const ua = c.req.header("user-agent");
  const vid = typeof b.vid === "string" && VID_RE.test(b.vid) ? b.vid : null;
  const visitorKey = await sha256Hex(vid ? `vid:${vid}` : `anon:${crypto.randomUUID()}`);
  const cf = (c.req.raw as unknown as { cf?: { country?: unknown } }).cf;
  const country = str(cf?.country) ?? str(c.req.header("cf-ipcountry"));

  const svc = createServices(c.env);
  const ctx: RequestContext = { requestId: getRequestId(c), userId: SYSTEM_ACTOR, caller: "api-gateway" };
  await svc.lp.post(ctx, "/lp/internal/visits", {
    source: str(b.source),
    path: str(b.path),
    lpVersion: str(b.lpVersion),
    referrerHost: referrerHost(str(b.referrer), origin),
    country: country ? country.toUpperCase().slice(0, 2) : null,
    device: classifyDevice(ua),
    visitorKey,
  });
  return c.body(null, 204);
}
