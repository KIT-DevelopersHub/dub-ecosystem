// Pure routing logic for the multi-version LP Worker (worker/index.ts).
// No runtime imports so it runs under both workerd and `node --test` (strip-only TS).

/**
 * Preview is decided by the URL only (?version= / ?tickets= / ?proposals=). Nothing is stored in
 * the browser, so opening the LP without params always shows what is public. Cookies from the
 * old cookie-based preview are cleared on sight (see staleCookieClears).
 */
export const PREVIEW_PARAMS = ["version", "tickets", "proposals"] as const;
export const LEGACY_COOKIES = ["lp_version", "lp_tickets", "lp_proposals"] as const;

export type Resolution =
  | { kind: "redirect"; location: string }
  | { kind: "serve"; version: string; preview: boolean; assetPath: string };

/** "3.1" / "v3.1" -> "v3.1" when bundled, else null. */
export function normalizeVersion(raw: string | null | undefined, bundled: readonly string[]): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const id = v.startsWith("v") ? v : `v${v}`;
  return bundled.includes(id) ? id : null;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Max-Age=0 Set-Cookie for every legacy preview cookie the browser still sends. */
export function staleCookieClears(cookieHeader: string | null): string[] {
  return LEGACY_COOKIES.filter((n) => readCookie(cookieHeader, n) !== null).map(
    (n) => `${n}=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0`,
  );
}

/**
 * Same-origin referer fallback, for subresources only (JS/CSS/images of a previewed page, whose
 * own URL has no params). A navigation (link click, form post, reload) never inherits it: it must
 * carry the params itself (link rewriting), so a plain visit is never a preview.
 */
export function refererFallback(referer: string | null, origin: string, navigation: boolean): URLSearchParams | null {
  if (!referer || navigation) return null;
  try {
    const u = new URL(referer);
    return u.origin === origin ? u.searchParams : null;
  } catch {
    return null;
  }
}

/** Sec-Fetch-Mode: navigate / Sec-Fetch-Dest: document|iframe|frame. Unknown (old browser) = not. */
export function isNavigation(headers: { get(name: string): string | null }): boolean {
  if (headers.get("sec-fetch-mode") === "navigate") return true;
  const dest = headers.get("sec-fetch-dest");
  return dest === "document" || dest === "iframe" || dest === "frame";
}

export function resolveRequest(
  url: URL,
  published: string,
  bundled: readonly string[],
  fallback: URLSearchParams | null = null,
): Resolution {
  const param = url.searchParams.get("version");
  if (param !== null && param.trim().toLowerCase() === "live") {
    // Old 解除 links: drop every preview param.
    const clean = new URL(url.toString());
    for (const p of PREVIEW_PARAMS) clean.searchParams.delete(p);
    return { kind: "redirect", location: clean.pathname + clean.search };
  }
  const version = normalizeVersion(param, bundled) ?? normalizeVersion(fallback?.get("version"), bundled) ?? published;
  return {
    kind: "serve",
    version,
    preview: version !== published,
    assetPath: `/versions/${version}${url.pathname}`,
  };
}

/** LP管理「プレビュー」タブの あり/なし。null = 指定なし（実際の公開状態のまま）。 */
export type TicketsPreview = "on" | "off";
export type FeaturePreview = TicketsPreview;

function normalizeMode(raw: string | null | undefined): FeaturePreview | null {
  const v = raw?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : null;
}

/** ?<param>= > referer fallback (subresources only). ?version=live clears it. */
function featurePreview(param: string, url: URL, fallback: URLSearchParams | null): FeaturePreview | null {
  if (url.searchParams.get("version")?.trim().toLowerCase() === "live") return null;
  return normalizeMode(url.searchParams.get(param)) ?? normalizeMode(fallback?.get(param));
}

/** チケット販売あり/なし (?tickets=on|off)。 */
export function ticketsPreview(url: URL, fallback: URLSearchParams | null = null): TicketsPreview | null {
  return featurePreview("tickets", url, fallback);
}

/** 登壇者募集あり/なし (?proposals=on|off)。 */
export function proposalsPreview(url: URL, fallback: URLSearchParams | null = null): FeaturePreview | null {
  return featurePreview("proposals", url, fallback);
}

/** The valid preview params of this request URL (what links / redirects must carry on). */
export function previewQuery(url: URL, bundled: readonly string[]): URLSearchParams {
  const q = new URLSearchParams();
  const v = normalizeVersion(url.searchParams.get("version"), bundled);
  if (v) q.set("version", v);
  const t = ticketsPreview(url);
  if (t) q.set("tickets", t);
  const p = proposalsPreview(url);
  if (p) q.set("proposals", p);
  return q;
}

/**
 * Adds the preview params to a same-origin URL (href / action / Location). Cross-origin, hash-only,
 * non-http(s) and already-specified params are left alone. Returns the input when unchanged.
 */
export function withPreview(raw: string, origin: string, preview: URLSearchParams): string {
  const s = raw.trim();
  if (!s || s.startsWith("#") || [...preview.keys()].length === 0) return raw;
  let u: URL;
  try {
    u = new URL(s, `${origin}/`);
  } catch {
    return raw;
  }
  if (u.origin !== origin || (u.protocol !== "https:" && u.protocol !== "http:")) return raw;
  let changed = false;
  for (const [k, v] of preview) {
    if (!u.searchParams.has(k)) {
      u.searchParams.set(k, v);
      changed = true;
    }
  }
  if (!changed) return raw;
  return /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//") ? u.toString() : u.pathname + u.search + u.hash;
}

/** Maps an assets redirect (e.g. trailing slash) back to the public path. */
export function rewriteLocation(location: string, version: string, origin: string): string {
  const prefix = `/versions/${version}`;
  const u = new URL(location, origin);
  if (u.origin !== origin || !(u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))) return location;
  return (u.pathname.slice(prefix.length) || "/") + u.search + u.hash;
}

/** 解除 links go to the bare URL; link rewriting must not add the params back. */
export const EXIT_ATTR = "data-lp-preview-exit";

export function previewBanner(version: string, published: string): string {
  return (
    '<div id="lp-preview-banner" role="status" style="position:fixed;left:16px;bottom:16px;' +
    "z-index:2147483647;display:flex;gap:12px;align-items:center;padding:8px 16px;border-radius:999px;" +
    "background:rgba(17,17,17,.92);color:#fff;font:600 13px/1.4 system-ui,-apple-system,sans-serif;" +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:nowrap">' +
    `<span>${version} をプレビュー中（公開中は ${published}）</span>` +
    `<a href="/" ${EXIT_ATTR} style="color:#fff;text-decoration:underline">解除</a></div>`
  );
}
