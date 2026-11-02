// 公開設定（セクション切り替え）の読み込みと <html> への属性付与（worker/index.ts から使う）。
// 値は lp-analytics の GET /lp/internal/site-config（本番 30 秒・下書き 3 秒キャッシュ）。
// 取れない・古い版のときは属性を付けない = 静的 HTML のまま既定のバリアントが出る。
// No runtime-only imports so it runs under both workerd and `node --test` (strip-only TS).
import { LP_SECTION_REGISTRY, normalizeLayout, type LpLayout } from "../../../packages/types/src/lp.ts";
import { layoutAttributes } from "../src/sections/slots.ts";
import { readCookie } from "./route.ts";

export const CONFIG_PARAM = "config";
export const CONFIG_COOKIE = "lp_config";
export const PUBLISHED_TTL_MS = 30_000;
export const DRAFT_TTL_MS = 3_000;
const TIMEOUT_MS = 1_500;
const COOKIE_MAX_AGE = 3600;

/** 公開設定（data-lp-*）を読む最初の版。これより前の版には属性を付けない。 */
const FIRST_SUPPORTED = { major: 3, minor: 6 };

export function supportsSiteConfig(version: string): boolean {
  const m = /^v(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > FIRST_SUPPORTED.major || (major === FIRST_SUPPORTED.major && minor >= FIRST_SUPPORTED.minor);
}

const isLive = (url: URL, param: string): boolean => url.searchParams.get(param)?.trim().toLowerCase() === "live";
const isDraft = (v: string | null | undefined): boolean => v?.trim().toLowerCase() === "draft";

/**
 * 下書きの公開設定を見るか。?config=draft > cookie > 同一オリジンの referer（LP管理の iframe では
 * cookie が third-party で落ちることがある）。?config=live / ?version=live で解除。
 */
export function draftPreview(url: URL, cookieHeader: string | null, referer: string | null = null): boolean {
  if (isLive(url, CONFIG_PARAM) || isLive(url, "version")) return false;
  if (url.searchParams.has(CONFIG_PARAM)) return isDraft(url.searchParams.get(CONFIG_PARAM));
  if (isDraft(readCookie(cookieHeader, CONFIG_COOKIE))) return true;
  if (!referer) return false;
  try {
    const u = new URL(referer);
    return u.origin === url.origin && isDraft(u.searchParams.get(CONFIG_PARAM));
  } catch {
    return false;
  }
}

/** Set-Cookie for ?config=draft (1 h) or ?config=live / ?version=live (clear); null otherwise. */
export function draftCookie(url: URL): string | null {
  if (isLive(url, CONFIG_PARAM) || isLive(url, "version")) {
    return `${CONFIG_COOKIE}=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0`;
  }
  return isDraft(url.searchParams.get(CONFIG_PARAM))
    ? `${CONFIG_COOKIE}=draft; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=${COOKIE_MAX_AGE}`
    : null;
}

export interface SiteLayouts {
  published: LpLayout;
  draft: LpLayout;
}

/** GET /lp/internal/site-config の応答 → 正規化済み layout。形が違えば null。 */
export function parseSiteConfig(raw: unknown): SiteLayouts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { published?: unknown; draft?: unknown };
  if (typeof r.published !== "object" || r.published === null) return null;
  const published = normalizeLayout(r.published);
  // 下書きが無い・壊れている → 本番と同じ（下書きプレビューでも本番の見た目）。
  const draft = typeof r.draft === "object" && r.draft !== null ? normalizeLayout(r.draft) : published;
  return { published, draft };
}

/** layout → <html> に付ける data-lp-* 属性（既定値と同じものは付けない）。 */
export function htmlAttributes(layout: LpLayout | null): Record<string, string> {
  return layout ? layoutAttributes(LP_SECTION_REGISTRY, layout) : {};
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 公開設定の読み込み元（isolate ごとに 1 つ）。1 回の fetch で本番と下書きの両方が来るので、
 * 同じキャッシュを本番は 30 秒・下書きは 3 秒で使い回す。取れなかったら前回の正常値、
 * それも無ければ null（= 属性なし・既定値）。never throws.
 */
export function createSiteConfigSource(fetcher: Fetch | null, now: () => number = Date.now) {
  let cache: { value: SiteLayouts | null; at: number } | null = null;
  let lastGood: SiteLayouts | null = null;
  return async function layout(draft: boolean): Promise<LpLayout | null> {
    const ttl = draft ? DRAFT_TTL_MS : PUBLISHED_TTL_MS;
    const t = now();
    if (!cache || t - cache.at >= ttl) {
      let value: SiteLayouts | null = null;
      try {
        if (fetcher) {
          const res = await fetcher("https://lp-analytics/lp/internal/site-config", {
            headers: { "x-dub-internal": "1" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.ok) value = parseSiteConfig(await res.json());
        }
      } catch {
        // Never fail the page because of the site config.
      }
      if (value) lastGood = value;
      cache = { value: value ?? lastGood, at: t };
    }
    const v = cache.value;
    return v ? (draft ? v.draft : v.published) : null;
  };
}
