// lp-conference-next — one Worker that bundles every LP version (dist-bundle/, built by
// scripts/build-bundle.mjs) and picks which one to show from a remote publish flag, so
// switching the public version needs no redeploy. Routing rules live in ./route.ts.
//
// NOTE: only `export default` here — workerd treats named exports as entrypoints.
import manifest from "../versions.json";
import {
  previewBanner,
  proposalsCookie,
  proposalsPreview,
  resolveRequest,
  rewriteLocation,
  ticketsCookie,
  ticketsPreview,
  ticketsPreviewCookie,
  ticketsPreviewToken,
} from "./route.ts";
import {
  DEMO_CONFIG,
  handleTickets,
  internalFetch,
  isTicketsPath,
  parseConfig,
  previewBar,
  previewConfig,
  ticketsInjection,
  type TicketConfig,
} from "./tickets.ts";
import {
  DEMO_PROPOSAL_CONFIG,
  handleProposals,
  isProposalsPath,
  parseProposalConfig,
  previewProposals,
  proposalsInjection,
  type ProposalConfig,
} from "./proposals.ts";
import { handlePass, matchPassRoute } from "./ticket-pass.ts";
import { createSiteConfigSource, draftCookie, draftPreview, htmlAttributes, supportsSiteConfig } from "./site-config.ts";
import { bridgeScript, parseExtraOrigins, shouldInjectBridge } from "./preview-bridge.ts";

interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
interface Env {
  ASSETS: Fetcher;
  LP_FLAG?: Fetcher;
  /** lp-tickets (dub-lp-tickets). No fallback to LP_FLAG: without it tickets are "unavailable". */
  LP_TICKETS?: Fetcher;
  DEFAULT_VERSION?: string;
  TICKETS_DEMO?: string;
  /** LP管理のミニプレビュー連動で許可する追加の親オリジン（カンマ区切り・https のみ）。 */
  PREVIEW_PARENT_ORIGINS?: string;
}
interface RewriterElement {
  append(content: string, opts: { html: boolean }): void;
  setAttribute(name: string, value: string): void;
}
declare class HTMLRewriter {
  on(selector: string, handler: { element(el: RewriterElement): void }): HTMLRewriter;
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

// Demo has no lp-tickets: sales off, so only ?tickets=on (LP管理「プレビュー」タブ) shows them.
const DEMO_PREVIEW: TicketConfig = { ...DEMO_CONFIG, enabled: false };

/** Ticket config (30s cache). null = unavailable; never throws. */
async function ticketConfig(env: Env): Promise<TicketConfig | null> {
  if (env.TICKETS_DEMO === "1") return DEMO_PREVIEW;
  const now = Date.now();
  if (ticketsCache && now - ticketsCache.at < FLAG_TTL_MS) return ticketsCache.value;
  let value: TicketConfig | null = null;
  try {
    if (env.LP_TICKETS) {
      const res = await env.LP_TICKETS.fetch("https://lp-tickets/lp/internal/tickets", {
        headers: { "x-dub-internal": "1" },
        signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
      });
      if (res.ok) value = parseConfig(await res.json());
    }
  } catch {
    // Never fail the page because of the tickets config.
  }
  ticketsCache = { value, at: now };
  return value;
}

let proposalsCache: { value: ProposalConfig | null; at: number } | null = null;

// Demo has no lp-analytics: closed, so only ?proposals=on (LP管理「プレビュー」タブ) shows it.
const DEMO_PROPOSALS_PREVIEW: ProposalConfig = { ...DEMO_PROPOSAL_CONFIG, enabled: false };

/** Proposals config (30s cache). null = unavailable; never throws. */
async function proposalConfig(env: Env): Promise<ProposalConfig | null> {
  if (env.TICKETS_DEMO === "1") return DEMO_PROPOSALS_PREVIEW;
  const now = Date.now();
  if (proposalsCache && now - proposalsCache.at < FLAG_TTL_MS) return proposalsCache.value;
  let value: ProposalConfig | null = null;
  try {
    if (env.LP_FLAG) {
      const res = await env.LP_FLAG.fetch("https://lp-analytics/lp/internal/proposals", {
        headers: { "x-dub-internal": "1" },
        signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
      });
      if (res.ok) value = parseProposalConfig(await res.json());
    }
  } catch {
    // Never fail the page because of the proposals config.
  }
  proposalsCache = { value, at: now };
  return value;
}

// 公開設定（セクション切り替え）。isolate ごとに 1 つ・service binding が無い環境（demo など）は常に既定値。
let siteConfigSource: ReturnType<typeof createSiteConfigSource> | null = null;
function siteLayout(env: Env, draft: boolean) {
  if (!siteConfigSource) {
    const flag = env.LP_FLAG;
    siteConfigSource = createSiteConfigSource(flag ? (u, init) => flag.fetch(u, init) : null);
  }
  return siteConfigSource(draft);
}

function ticketsInternal(env: Env): ((path: string, init: RequestInit) => Promise<Response>) | null {
  return internalFetch(env.LP_TICKETS, "lp-tickets", env.TICKETS_DEMO === "1");
}

// 登壇者募集は lp-analytics のまま（チケットとは別の binding）。
function proposalsInternal(env: Env): ((path: string, init: RequestInit) => Promise<Response>) | null {
  return internalFetch(env.LP_FLAG, "lp-analytics", env.TICKETS_DEMO === "1");
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
    // Before everything: tickets stay usable with sales off, and no cookie or version logic touches them.
    const pass = matchPassRoute(url.pathname);
    if (pass) return handlePass(req, pass, { demo: env.TICKETS_DEMO === "1", internal: ticketsInternal(env) });
    const ticketsPath = isTicketsPath(url.pathname);
    // LP管理「プレビュー」タブの ?tickets=on|off はこの閲覧者にだけ効く（公開中の LP は不変）。
    const mode = ticketsPreview(url, req.headers.get("cookie"), req.headers.get("referer"));
    const getConfig = async (): Promise<TicketConfig | null> => previewConfig(await ticketConfig(env), mode);
    const tkCookie = ticketsCookie(url);
    // LP管理「プレビュー」(販売あり) のテスト購入トークン。検証は lp-tickets（Stripe テストキーの時だけ有効）。
    const tkToken = ticketsPreviewToken(url, req.headers.get("cookie"), req.headers.get("referer"));
    const tkTokenCookie = ticketsPreviewCookie(url);
    // 登壇者募集も同じ流儀（?proposals=on|off はこの閲覧者にだけ効く）。
    const proposalsPath = isProposalsPath(url.pathname);
    const spMode = proposalsPreview(url, req.headers.get("cookie"), req.headers.get("referer"));
    const getProposals = async (): Promise<ProposalConfig | null> => previewProposals(await proposalConfig(env), spMode);
    const spCookie = proposalsCookie(url);
    // 下書きの公開設定プレビュー（?config=draft）。この閲覧者にだけ効く。
    const cfgDraft = draftPreview(url, req.headers.get("cookie"), req.headers.get("referer"));
    const cfgCookie = draftCookie(url);
    if (proposalsPath) {
      const handled = await handleProposals(req, {
        demo: env.TICKETS_DEMO === "1",
        getConfig: getProposals,
        internal: proposalsInternal(env),
      });
      if (handled) return handled;
    }
    if (ticketsPath) {
      const handled = await handleTickets(req, {
        demo: env.TICKETS_DEMO === "1",
        getConfig,
        invalidate: () => {
          ticketsCache = null;
        },
        internal: ticketsInternal(env),
        previewToken: tkToken,
      });
      if (handled) {
        if (!tkTokenCookie) return handled;
        const h = new Headers(handled.headers);
        h.append("set-cookie", tkTokenCookie);
        return new Response(handled.body, { status: handled.status, statusText: handled.statusText, headers: h });
      }
    }
    // Started in parallel; only awaited for HTML pages (CTA injection).
    const tickets = ticketsPath ? null : getConfig();
    const proposals = proposalsPath ? null : getProposals();
    const layout = ticketsPath || proposalsPath ? null : siteLayout(env, cfgDraft);
    const published = await publishedVersion(env);
    const r = resolveRequest(url, req.headers.get("cookie"), published, BUNDLED, req.headers.get("referer"));

    if (r.kind === "redirect") {
      const headers = new Headers({ location: r.location, vary: "Cookie", "cache-control": "no-store" });
      headers.append("set-cookie", r.setCookie);
      if (tkCookie) headers.append("set-cookie", tkCookie);
      if (spCookie) headers.append("set-cookie", spCookie);
      if (tkTokenCookie) headers.append("set-cookie", tkTokenCookie);
      if (cfgCookie) headers.append("set-cookie", cfgCookie);
      return new Response(null, { status: 302, headers });
    }

    let res = await env.ASSETS.fetch(new Request(url.origin + r.assetPath, req));
    if (res.status === 404) res = await notFound(env, url.origin, r.version, req);

    const headers = new Headers(res.headers);
    headers.append("vary", "Cookie");
    if (r.setCookie) headers.append("set-cookie", r.setCookie);
    if (tkCookie) headers.append("set-cookie", tkCookie);
    if (spCookie) headers.append("set-cookie", spCookie);
    if (tkTokenCookie) headers.append("set-cookie", tkTokenCookie);
    if (cfgCookie) headers.append("set-cookie", cfgCookie);
    const loc = headers.get("location");
    if (loc) headers.set("location", rewriteLocation(loc, r.version, url.origin));
    if (r.preview || mode || spMode || cfgDraft) headers.set("x-robots-tag", "noindex");

    const isHtml = (headers.get("content-type") ?? "").includes("text/html");
    const page = isHtml && res.status === 200;
    const cfg = page && tickets ? await tickets : null;
    const spCfg = page && proposals ? await proposals : null;
    // 公開設定は v3.6 以降の版だけ（古い版は属性を知らないので付けない）。
    const siteConfig = page && layout !== null && supportsSiteConfig(r.version);
    const attrs = siteConfig ? htmlAttributes(await layout) : {};
    const previewing = [
      siteConfig && cfgDraft ? "下書きの公開設定" : null,
      cfg?.enabled && cfg.preview ? "チケット販売" : null,
      spCfg?.enabled && spCfg.preview ? "登壇者募集" : null,
    ].filter((x): x is string => x !== null);
    // 「なし」preview hiding a live feature: say so (incl. the /tickets 404) or it looks broken.
    const hidden = isHtml
      ? [
          mode === "off" && (await ticketConfig(env))?.enabled ? "チケット販売" : null,
          spMode === "off" && (await proposalConfig(env))?.enabled ? "登壇者募集" : null,
        ].filter((x): x is string => x !== null)
      : [];
    // LP管理のミニプレビューとのスクロール連動。プレビュー表示のときだけ（公開表示には足さない）。
    const bridge = shouldInjectBridge({ page, siteConfig, previewing: r.preview || !!mode || !!spMode || cfgDraft })
      ? bridgeScript(parseExtraOrigins(env.PREVIEW_PARENT_ORIGINS))
      : "";
    const inject =
      bridge +
      (r.preview ? previewBanner(r.version, published) : "") +
      previewBar(previewing, hidden) +
      ticketsInjection(cfg, false) +
      proposalsInjection(spCfg);
    const attrEntries = Object.entries(attrs);
    if (inject || attrEntries.length > 0) headers.delete("etag");
    const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    if ((!inject && attrEntries.length === 0) || !isHtml) return out;
    let rw = new HTMLRewriter();
    if (attrEntries.length > 0) {
      rw = rw.on("html", { element: (el) => attrEntries.forEach(([k, v]) => el.setAttribute(k, v)) });
    }
    if (inject) rw = rw.on("body", { element: (el) => el.append(inject, { html: true }) });
    return rw.transform(out);
  },
};
