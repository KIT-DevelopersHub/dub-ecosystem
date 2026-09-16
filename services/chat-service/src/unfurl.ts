// Link unfurl (Slack-style OGP preview) for chat messages.
//
// The browser cannot fetch third-party pages (CORS), so chat-service resolves the
// preview server-side: GET /chat/unfurl?url=... -> { url, preview | null }.
//
// This is a server-side fetch of a USER-SUPPLIED URL, i.e. an SSRF surface. Guards
// (fail-close, pure + unit-tested):
//   * http(s) only; no credentials in the URL; no non-default-port tricks beyond 80/443/8080.
//   * host must not be localhost / *.localhost / *.internal / an IP literal in a private,
//     loopback, link-local (169.254 = cloud metadata) or reserved range.
//   * every redirect hop is re-validated (manual redirect following, capped at 3).
//   * 3s timeout, 512 KB read cap, HTML content-type only.
// Results are cached (Cache API, 1 day) by the route so a chatty channel does not refetch.

export interface UnfurlPreview {
  url: string; // final (post-redirect) URL
  siteName: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
}

export interface UnfurlResponse {
  url: string; // the requested URL (as validated)
  preview: UnfurlPreview | null; // null = nothing presentable (no OGP/title, fetch failed, blocked)
}

export type Unfurler = (url: string) => Promise<UnfurlPreview | null>;

export const UNFURL_MAX_REDIRECTS = 3;
export const UNFURL_TIMEOUT_MS = 3_000;
export const UNFURL_MAX_BYTES = 512 * 1024;
export const UNFURL_CACHE_TTL_SECONDS = 86_400;

const ALLOWED_PORTS = new Set(["", "80", "443", "8080"]);

// IPv4 literal -> blocked when in a private / loopback / link-local / reserved range.
function isBlockedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true; // private A / loopback / "this"
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private B
  if (a === 192 && b === 168) return true; // private C
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIpv6(host: string): boolean {
  // URL.hostname keeps the brackets for IPv6 literals. Fail-close: a public web page
  // is always reachable by hostname, so IPv6 literals (incl. v4-mapped ::ffff:7f00:1,
  // unique-local, link-local) are rejected wholesale rather than range-parsed.
  return host.startsWith("[");
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".home.arpa")) return true;
  if (!h.includes(".") && !h.startsWith("[")) return true; // bare intranet names (e.g. "intranet")
  return false;
}

/**
 * Validate a user-supplied URL for server-side fetching. Returns the normalized URL
 * or null when the URL must not be fetched (scheme, credentials, port, private host).
 */
export function validateUnfurlUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!ALLOWED_PORTS.has(u.port)) return null;
  const host = u.hostname;
  if (!host) return null;
  if (isBlockedIpv4(host) || isBlockedIpv6(host) || isBlockedHostname(host)) return null;
  u.hash = "";
  return u;
}

// ---- OGP parsing (regex on the <head>; no DOM available in Workers) ----

const ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ent: string) => {
    const e = ent.toLowerCase();
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITY_MAP[e] ?? all;
  });
}

function metaContent(html: string, keys: string[]): string | null {
  // <meta property="og:title" content="..."> in either attribute order.
  for (const key of keys) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re1 = new RegExp(`<meta[^>]*?(?:property|name)\\s*=\\s*["']${k}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${k}["']`, "i");
    const m = re1.exec(html) ?? re2.exec(html);
    const v = m?.[1]?.trim();
    if (v) return decodeEntities(v);
  }
  return null;
}

function clip(s: string | null, max: number): string | null {
  if (s === null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Extract an OGP preview from HTML. Returns null when nothing presentable exists. */
export function parseOgp(html: string, baseUrl: string): UnfurlPreview | null {
  const head = html.slice(0, UNFURL_MAX_BYTES);
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]?.trim();
  const title = metaContent(head, ["og:title", "twitter:title"]) ?? (titleTag ? decodeEntities(titleTag) : null);
  const description = metaContent(head, ["og:description", "twitter:description", "description"]);
  const siteName = metaContent(head, ["og:site_name"]);
  const rawImage = metaContent(head, ["og:image", "og:image:url", "twitter:image"]);
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      const abs = new URL(rawImage, baseUrl);
      if (abs.protocol === "https:" || abs.protocol === "http:") imageUrl = abs.toString();
    } catch {
      imageUrl = null;
    }
  }
  const t = clip(title, 200);
  if (!t) return null; // a card without a title is noise — hide it
  let site = clip(siteName, 80);
  if (!site) {
    try {
      site = new URL(baseUrl).hostname.replace(/^www\./, "");
    } catch {
      site = null;
    }
  }
  return { url: baseUrl, siteName: site, title: t, description: clip(description, 300), imageUrl };
}

export interface UnfurlerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf.subarray(0, Math.min(total, maxBytes)));
}

/**
 * Build an Unfurler: validates, follows redirects manually (re-validating each hop),
 * bounds time + bytes, and parses OGP. Never throws — any failure yields null.
 */
export function createUnfurler(opts: UnfurlerOptions = {}): Unfurler {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? UNFURL_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? UNFURL_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? UNFURL_MAX_REDIRECTS;

  return async (raw: string): Promise<UnfurlPreview | null> => {
    let target = validateUnfurlUrl(raw);
    if (!target) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const res = await fetchImpl(target.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "text/html,application/xhtml+xml", "user-agent": "DubChatUnfurl/1.0 (+https://developershub.jp)" },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) return null;
          const next = validateUnfurlUrl(new URL(loc, target).toString());
          if (!next) return null; // redirect into a private host -> blocked
          target = next;
          continue;
        }
        if (!res.ok) return null;
        const ct = res.headers.get("content-type") ?? "";
        if (!/text\/html|application\/xhtml\+xml/i.test(ct)) return null;
        const html = await readCapped(res, maxBytes);
        return parseOgp(html, target.toString());
      }
      return null; // too many redirects
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
