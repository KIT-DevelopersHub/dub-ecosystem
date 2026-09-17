// OGP previews for the backend-free builds (standalone mock + fe2 VITE_DEMO).
// The demo never contacts a real backend, so a few well-known hosts get hand-tuned
// cards from the table below, and EVERY other http(s) URL gets a sensible generic
// card (site = hostname, title from the path, a deterministic inline SVG thumbnail)
// so the demo visibly unfurls anything a reviewer pastes — not just the 5 seeds.
// Only unparseable / non-http(s) inputs yield null (= no card, URL stays autolinked).
// Pure + deterministic. The real endpoint (chat-service unfurl.ts) still returns null
// for pages without OGP — that fidelity lives in staging/prod, not the offline demo.
import type { UnfurlPreview } from "../api/contract";

// Liveness marker: verify-live asserts this literal is in the served demo bundle,
// proving the generic-unfurl fix (any-host cards) shipped, not just the old table.
export const UNFURL_GENERIC_MARKER = "fe6-unfurl-generic-v2";

// Tiny inline SVG thumbnails so the demo renders an image without a network fetch.
const svgThumb = (bg: string, label: string): string =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="126"><rect width="240" height="126" rx="8" fill="${bg}"/><text x="120" y="72" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff">${label}</text></svg>`,
  );

interface MockOgp {
  siteName: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
}

const BY_HOST: Record<string, MockOgp> = {
  "github.com": {
    siteName: "GitHub",
    title: "KIT-DevelopersHub/dub-ecosystem: DevHub (Dub) ecosystem monorepo",
    description: "DevHub (Dub) ecosystem monorepo — 運営ツール・名簿・チャット・タスクを一つに。Cloudflare Workers + React。",
    imageUrl: svgThumb("#24292f", "GitHub"),
  },
  "zenn.dev": {
    siteName: "Zenn",
    title: "Cloudflare Workers で Slack 風チャットの OGP プレビューを作る",
    description: "Worker 側で unfurl エンドポイントを持ち、SSRF 対策とキャッシュを入れつつ Slack 風カードを出すまでの実装メモ。",
    imageUrl: svgThumb("#3ea8ff", "Zenn"),
  },
  "developershub.jp": {
    siteName: "DevelopersHub",
    title: "北陸ITカンファレンス 2026 | DevelopersHub",
    description: "北陸の開発者が集う年に一度のカンファレンス。登壇・スポンサー募集中。",
    imageUrl: svgThumb("#3358e8", "DevHub"),
  },
  "qiita.com": {
    siteName: "Qiita",
    title: "React でメッセージ本文を安全に自動リンク化する",
    description: "dangerouslySetInnerHTML を使わずに URL を <a> に分割描画する小技。",
    imageUrl: svgThumb("#55c500", "Qiita"),
  },
  "example.com": {
    siteName: "example.com",
    title: "Example Domain",
    description: "This domain is for use in illustrative examples in documents.",
    imageUrl: null,
  },
};

// Deterministic hue (0-359) from a string, so a given host always gets the same
// thumbnail colour across renders/sessions (no Math.random -> stays pure).
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Human-ish title from the URL path: last non-empty segment, decoded, extension
// and separators cleaned up; falls back to the bare site name.
function titleFromUrl(u: URL, site: string): string {
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last) return site;
  let t: string;
  try {
    t = decodeURIComponent(last);
  } catch {
    t = last;
  }
  t = t
    .replace(/\.[a-z0-9]{1,5}$/i, "") // drop a file extension
    .replace(/[-_+]+/g, " ")
    .trim();
  return t.length > 0 ? t : site;
}

// Generic Slack-style card for any host without a hand-tuned entry: enough shape
// (site / title / description / thumbnail) that the demo always unfurls.
function genericPreview(url: string, u: URL, host: string): UnfurlPreview {
  const site = host.replace(/^www\./, "");
  const label = (site.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  const bg = `hsl(${hueOf(site)},58%,42%)`;
  return {
    url,
    siteName: site,
    title: titleFromUrl(u, site),
    description: `${site} のリンクプレビュー`,
    imageUrl: svgThumb(bg, label),
  };
}

/**
 * Preview for a pasted URL in the backend-free demo. Hand-tuned card for known
 * hosts (subdomains included), a generic card for any other http(s) URL, and
 * null only for unparseable / non-http(s) inputs (rendered as a plain autolink).
 */
export function mockUnfurl(url: string): UnfurlPreview | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const key = Object.keys(BY_HOST).find((h) => host === h || host.endsWith(`.${h}`));
  if (key) return { url, ...BY_HOST[key]! };
  return genericPreview(url, u, host);
}
