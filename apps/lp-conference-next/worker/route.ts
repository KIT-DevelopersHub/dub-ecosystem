// Pure routing logic for the multi-version LP Worker (worker/index.ts).
// No runtime imports so it runs under both workerd and `node --test` (strip-only TS).

export const VERSION_COOKIE = "lp_version";

export type Resolution =
  | { kind: "redirect"; location: string; setCookie: string }
  | { kind: "serve"; version: string; preview: boolean; assetPath: string; setCookie: string | null };

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

export function sessionCookie(version: string): string {
  return `${VERSION_COOKIE}=${version}; Path=/; SameSite=None; Secure; HttpOnly`;
}

export function clearCookie(): string {
  return `${VERSION_COOKIE}=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0`;
}

export function resolveRequest(
  url: URL,
  cookieHeader: string | null,
  published: string,
  bundled: readonly string[],
  referer: string | null = null,
): Resolution {
  const param = url.searchParams.get("version");
  if (param !== null && param.trim().toLowerCase() === "live") {
    const clean = new URL(url.toString());
    clean.searchParams.delete("version");
    return { kind: "redirect", location: clean.pathname + clean.search, setCookie: clearCookie() };
  }
  const fromParam = normalizeVersion(param, bundled);
  const fromCookie = normalizeVersion(readCookie(cookieHeader, VERSION_COOKIE), bundled);
  // Inside the LP管理 iframe the cookie is third-party and may be blocked, so a same-origin
  // subresource falls back to the ?version= of the page that requested it.
  const version = fromParam ?? fromCookie ?? versionFromReferer(referer, url.origin, bundled) ?? published;
  return {
    kind: "serve",
    version,
    preview: version !== published,
    assetPath: `/versions/${version}${url.pathname}`,
    setCookie: fromParam ? sessionCookie(fromParam) : null,
  };
}

export const TICKETS_COOKIE = "lp_tickets";

/** LP管理「プレビュー」タブのチケット販売あり/なし。null = 指定なし（実際の販売状態のまま）。 */
export type TicketsPreview = "on" | "off";

function normalizeTickets(raw: string | null | undefined): TicketsPreview | null {
  const v = raw?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : null;
}

/** ?tickets= > cookie > same-origin referer (LP管理 iframe). ?version=live clears it. */
export function ticketsPreview(url: URL, cookieHeader: string | null, referer: string | null = null): TicketsPreview | null {
  if (url.searchParams.get("version")?.trim().toLowerCase() === "live") return null;
  const fromParam = normalizeTickets(url.searchParams.get("tickets"));
  if (fromParam) return fromParam;
  const fromCookie = normalizeTickets(readCookie(cookieHeader, TICKETS_COOKIE));
  if (fromCookie) return fromCookie;
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return u.origin === url.origin ? normalizeTickets(u.searchParams.get("tickets")) : null;
  } catch {
    return null;
  }
}

/** Set-Cookie for ?tickets= (session) or ?version=live (clear); null otherwise. */
export function ticketsCookie(url: URL): string | null {
  if (url.searchParams.get("version")?.trim().toLowerCase() === "live") {
    return `${TICKETS_COOKIE}=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0`;
  }
  const v = normalizeTickets(url.searchParams.get("tickets"));
  return v ? `${TICKETS_COOKIE}=${v}; Path=/; SameSite=None; Secure; HttpOnly` : null;
}

function versionFromReferer(referer: string | null, origin: string, bundled: readonly string[]): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return u.origin === origin ? normalizeVersion(u.searchParams.get("version"), bundled) : null;
  } catch {
    return null;
  }
}

/** Maps an assets redirect (e.g. trailing slash) back to the public path. */
export function rewriteLocation(location: string, version: string, origin: string): string {
  const prefix = `/versions/${version}`;
  const u = new URL(location, origin);
  if (u.origin !== origin || !(u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))) return location;
  return (u.pathname.slice(prefix.length) || "/") + u.search + u.hash;
}

export function previewBanner(version: string, published: string): string {
  return (
    '<div id="lp-preview-banner" role="status" style="position:fixed;left:16px;bottom:16px;' +
    "z-index:2147483647;display:flex;gap:12px;align-items:center;padding:8px 16px;border-radius:999px;" +
    "background:rgba(17,17,17,.92);color:#fff;font:600 13px/1.4 system-ui,-apple-system,sans-serif;" +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:nowrap">' +
    `<span>${version} をプレビュー中（公開中は ${published}）</span>` +
    '<a href="/?version=live" style="color:#fff;text-decoration:underline">解除</a></div>'
  );
}
