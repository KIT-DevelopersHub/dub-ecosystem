// lp-conference-next — one Worker that bundles every LP version (dist-bundle/, built by
// scripts/build-bundle.mjs) and picks which one to show from a remote publish flag, so
// switching the public version needs no redeploy. Routing rules live in ./route.ts.
//
// NOTE: only `export default` here — workerd treats named exports as entrypoints.
import manifest from "../versions.json";
import {
  EXIT_ATTR,
  isNavigation,
  previewBanner,
  previewQuery,
  proposalsPreview,
  refererFallback,
  resolveRequest,
  rewriteLocation,
  staleCookieClears,
  ticketsPreview,
  withPreview,
} from "./route.ts";
import {
  DEMO_CONFIG,
  handleTickets,
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

interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
interface Env {
  ASSETS: Fetcher;
  LP_FLAG?: Fetcher;
  DEFAULT_VERSION?: string;
  TICKETS_DEMO?: string;
}
interface RewriterElement {
  append(content: string, opts: { html: boolean }): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
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

// Demo has no lp-analytics: sales off, so only ?tickets=on (LP管理「プレビュー」タブ) shows them.
const DEMO_PREVIEW: TicketConfig = { ...DEMO_CONFIG, enabled: false };

/** Ticket config (30s cache). null = unavailable; never throws. */
async function ticketConfig(env: Env): Promise<TicketConfig | null> {
  if (env.TICKETS_DEMO === "1") return DEMO_PREVIEW;
  const now = Date.now();
  if (ticketsCache && now - ticketsCache.at < FLAG_TTL_MS) return ticketsCache.value;
  let value: TicketConfig | null = null;
  try {
    if (env.LP_FLAG) {
      const res = await env.LP_FLAG.fetch("https://lp-analytics/lp/internal/tickets", {
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

/**
 * Final touch on every response: clears legacy preview cookies, and while previewing keeps the
 * preview params on same-origin links / form actions / redirects so in-page navigation stays in
 * the preview (the URL is the only state).
 */
function finish(res: Response, url: URL, cookieHeader: string | null): Response {
  const clears = staleCookieClears(cookieHeader);
  const pq = previewQuery(url, BUNDLED);
  const carry = [...pq.keys()].length > 0;
  const loc = res.headers.get("location");
  const newLoc = carry && loc ? withPreview(loc, url.origin, pq) : loc;
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  if (clears.length === 0 && newLoc === loc && !(carry && isHtml)) return res;
  const headers = new Headers(res.headers);
  for (const c of clears) headers.append("set-cookie", c);
  if (newLoc && newLoc !== loc) headers.set("location", newLoc);
  if (carry && isHtml) headers.delete("etag");
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  if (!carry || !isHtml) return out;
  const rewrite = (attr: string) => (el: RewriterElement) => {
    if (el.hasAttribute(EXIT_ATTR)) return;
    const v = el.getAttribute(attr);
    if (v === null) return;
    const next = withPreview(v, url.origin, pq);
    if (next !== v) el.setAttribute(attr, next);
  };
  return new HTMLRewriter()
    .on("a[href]", { element: rewrite("href") })
    .on("form[action]", { element: rewrite("action") })
    .transform(out);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    return finish(await serve(req, env, url), url, req.headers.get("cookie"));
  },
};

async function serve(req: Request, env: Env, url: URL): Promise<Response> {
  const ticketsPath = isTicketsPath(url.pathname);
  // Preview = URL params only. Same-origin referer only for subresources of a previewed page.
  const fallback = refererFallback(req.headers.get("referer"), url.origin, isNavigation(req.headers));
  // LP管理「プレビュー」タブの ?tickets=on|off はこの閲覧者にだけ効く（公開中の LP は不変）。
  const mode = ticketsPreview(url, fallback);
  const getConfig = async (): Promise<TicketConfig | null> => previewConfig(await ticketConfig(env), mode);
  // 登壇者募集も同じ流儀（?proposals=on|off はこの閲覧者にだけ効く）。
  const proposalsPath = isProposalsPath(url.pathname);
  const spMode = proposalsPreview(url, fallback);
  const getProposals = async (): Promise<ProposalConfig | null> => previewProposals(await proposalConfig(env), spMode);
  if (proposalsPath) {
    const handled = await handleProposals(req, {
      demo: env.TICKETS_DEMO === "1",
      getConfig: getProposals,
      internal: ticketsInternal(env),
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
    });
    if (handled) return handled;
  }
  // Started in parallel; only awaited for HTML pages (CTA injection).
  const tickets = ticketsPath ? null : getConfig();
  const proposals = proposalsPath ? null : getProposals();
  const published = await publishedVersion(env);
  const r = resolveRequest(url, published, BUNDLED, fallback);

  if (r.kind === "redirect") {
    return new Response(null, { status: 302, headers: { location: r.location, "cache-control": "no-store" } });
  }

  let res = await env.ASSETS.fetch(new Request(url.origin + r.assetPath, req));
  if (res.status === 404) res = await notFound(env, url.origin, r.version, req);

  const headers = new Headers(res.headers);
  const loc = headers.get("location");
  if (loc) headers.set("location", rewriteLocation(loc, r.version, url.origin));
  if (r.preview || mode || spMode) headers.set("x-robots-tag", "noindex");

  const isHtml = (headers.get("content-type") ?? "").includes("text/html");
  const page = isHtml && res.status === 200;
  const cfg = page && tickets ? await tickets : null;
  const spCfg = page && proposals ? await proposals : null;
  const previewing = [
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
  const inject =
    (r.preview ? previewBanner(r.version, published) : "") +
    previewBar(previewing, hidden) +
    ticketsInjection(cfg, false) +
    proposalsInjection(spCfg);
  if (inject) headers.delete("etag");
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  if (!inject || !isHtml) return out;
  return new HTMLRewriter()
    .on("body", { element: (el) => el.append(inject, { html: true }) })
    .transform(out);
}
