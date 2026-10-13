// lp-conference-next — one Worker that bundles every LP version (dist-bundle/, built by
// scripts/build-bundle.mjs) and picks which one to show from a remote publish flag, so
// switching the public version needs no redeploy. Routing rules live in ./route.ts.
//
// NOTE: only `export default` here — workerd treats named exports as entrypoints.
import manifest from "../versions.json";
import { previewBanner, resolveRequest, rewriteLocation } from "./route.ts";
import { DEMO_CONFIG, handleTickets, isTicketsPath, parseConfig, ticketsInjection, type TicketConfig } from "./tickets.ts";

interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
interface Env {
  ASSETS: Fetcher;
  LP_FLAG?: Fetcher;
  DEFAULT_VERSION?: string;
  TICKETS_DEMO?: string;
}
declare class HTMLRewriter {
  on(selector: string, handler: { element(el: { append(content: string, opts: { html: boolean }): void }): void }): HTMLRewriter;
  transform(res: Response): Response;
}

const BUNDLED: readonly string[] = manifest.versions.map((v: { id: string }) => v.id);
const FLAG_TTL_MS = 30_000;
const FLAG_TIMEOUT_MS = 1_500;

let flagCache: { value: string; at: number } | null = null;
let lastGood: string | null = null;

async function publishedVersion(env: Env): Promise<string> {
  const now = Date.now();
  if (flagCache && now - flagCache.at < FLAG_TTL_MS) return flagCache.value;
  let value: string | null = null;
  try {
    if (env.LP_FLAG) {
      const res = await env.LP_FLAG.fetch("https://lp-analytics/lp/internal/publish", {
        headers: { "x-dub-internal": "1" },
        signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { versionId?: unknown };
        if (typeof body.versionId === "string" && BUNDLED.includes(body.versionId)) value = body.versionId;
      }
    }
  } catch {
    // Never fail the page because of the flag.
  }
  if (value) lastGood = value;
  const fallback = env.DEFAULT_VERSION && BUNDLED.includes(env.DEFAULT_VERSION) ? env.DEFAULT_VERSION : manifest.default;
  const resolved = value ?? lastGood ?? fallback;
  flagCache = { value: resolved, at: now };
  return resolved;
}

let ticketsCache: { value: TicketConfig | null; at: number } | null = null;

// 公開前プレビュー: LP管理が発行した /tickets?preview=<token> で開くと cookie に移し、
// 以降の LP ページ・/tickets でも同じ token で lp-analytics に問い合わせる（キャッシュしない）。
const PREVIEW_COOKIE = "lp_tk_preview";
const PREVIEW_MAX_AGE_SEC = 24 * 60 * 60;
const PREVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function previewToken(url: URL, cookie: string | null, ticketsPath: boolean): { token: string; fromQuery: boolean } | null {
  const q = ticketsPath ? url.searchParams.get("preview") : null;
  if (q && PREVIEW_TOKEN_RE.test(q)) return { token: q, fromQuery: true };
  const m = /(?:^|;\s*)lp_tk_preview=([^;]+)/.exec(cookie ?? "");
  return m && PREVIEW_TOKEN_RE.test(m[1]!) ? { token: m[1]!, fromQuery: false } : null;
}

function previewCookie(token: string | null): string {
  const attrs = "; Path=/; HttpOnly; Secure; SameSite=Lax";
  return token ? `${PREVIEW_COOKIE}=${token}; Max-Age=${PREVIEW_MAX_AGE_SEC}${attrs}` : `${PREVIEW_COOKIE}=; Max-Age=0${attrs}`;
}

async function fetchTicketConfig(env: Env, preview: string | null): Promise<TicketConfig | null> {
  if (!env.LP_FLAG) return null;
  try {
    const q = preview ? `?preview=${encodeURIComponent(preview)}` : "";
    const res = await env.LP_FLAG.fetch(`https://lp-analytics/lp/internal/tickets${q}`, {
      headers: { "x-dub-internal": "1" },
      signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
    });
    return res.ok ? parseConfig(await res.json()) : null;
  } catch {
    // Never fail the page because of the tickets config.
    return null;
  }
}

/** Ticket config (30s cache; preview requests skip it). null = unavailable; never throws. */
async function ticketConfig(env: Env, preview: string | null = null): Promise<TicketConfig | null> {
  // Demo: any well-formed preview token shows the preview notice (no lp-analytics behind it).
  if (env.TICKETS_DEMO === "1") return preview ? { ...DEMO_CONFIG, preview: true } : DEMO_CONFIG;
  if (preview) return fetchTicketConfig(env, preview);
  const now = Date.now();
  if (ticketsCache && now - ticketsCache.at < FLAG_TTL_MS) return ticketsCache.value;
  const value = await fetchTicketConfig(env, null);
  ticketsCache = { value, at: now };
  return value;
}

function ticketsInternal(env: Env): ((path: string, init: RequestInit) => Promise<Response>) | null {
  const flag = env.LP_FLAG;
  if (!flag || env.TICKETS_DEMO === "1") return null;
  return (path, init) => {
    const headers = new Headers(init.headers);
    headers.set("x-dub-internal", "1");
    return flag.fetch(`https://lp-analytics${path}`, { ...init, headers });
  };
}

async function notFound(env: Env, origin: string, version: string, req: Request): Promise<Response> {
  let res = await env.ASSETS.fetch(new Request(`${origin}/versions/${version}/404.html`, { headers: req.headers }));
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) {
    res = await env.ASSETS.fetch(new Request(new URL(loc, origin).toString(), { headers: req.headers }));
  }
  return new Response(res.ok ? res.body : "Not Found", { status: 404, headers: res.ok ? res.headers : undefined });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const ticketsPath = isTicketsPath(url.pathname);
    const preview = previewToken(url, req.headers.get("cookie"), ticketsPath);
    // Set-Cookie for the preview: store a link token once it proved valid, drop a dead cookie.
    let previewSetCookie: string | null = null;
    const getConfig = async (): Promise<TicketConfig | null> => {
      const cfg = await ticketConfig(env, preview?.token ?? null);
      if (preview && cfg) {
        if (cfg.preview && preview.fromQuery) previewSetCookie = previewCookie(preview.token);
        else if (!cfg.preview && !preview.fromQuery) previewSetCookie = previewCookie(null);
      }
      return cfg;
    };
    if (ticketsPath) {
      const handled = await handleTickets(req, {
        demo: env.TICKETS_DEMO === "1",
        getConfig,
        invalidate: () => {
          ticketsCache = null;
        },
        internal: ticketsInternal(env),
      });
      if (handled) {
        if (previewSetCookie) handled.headers.append("set-cookie", previewSetCookie);
        return handled;
      }
    }
    // Started in parallel; only awaited for HTML pages (CTA injection).
    const tickets = ticketsPath ? null : getConfig();
    const published = await publishedVersion(env);
    const r = resolveRequest(url, req.headers.get("cookie"), published, BUNDLED, req.headers.get("referer"));

    if (r.kind === "redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: r.location, "set-cookie": r.setCookie, vary: "Cookie", "cache-control": "no-store" },
      });
    }

    let res = await env.ASSETS.fetch(new Request(url.origin + r.assetPath, req));
    if (res.status === 404) res = await notFound(env, url.origin, r.version, req);

    const headers = new Headers(res.headers);
    headers.append("vary", "Cookie");
    if (r.setCookie) headers.append("set-cookie", r.setCookie);
    const loc = headers.get("location");
    if (loc) headers.set("location", rewriteLocation(loc, r.version, url.origin));
    if (r.preview) headers.set("x-robots-tag", "noindex");

    const isHtml = (headers.get("content-type") ?? "").includes("text/html");
    const cfg = isHtml && res.status === 200 && tickets ? await tickets : null;
    if (previewSetCookie) headers.append("set-cookie", previewSetCookie);
    const inject = (r.preview ? previewBanner(r.version, published) : "") + ticketsInjection(cfg);
    if (inject) headers.delete("etag");
    const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    if (!inject || !isHtml) return out;
    return new HTMLRewriter()
      .on("body", { element: (el) => el.append(inject, { html: true }) })
      .transform(out);
  },
};
