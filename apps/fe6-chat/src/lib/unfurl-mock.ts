// Fixed OGP previews for the backend-free builds (standalone mock + fe2 VITE_DEMO).
// The demo never contacts a real backend, so link cards for a few well-known hosts
// are answered from this table; unknown hosts yield null (= no card), exactly like
// the real endpoint does for pages without OGP. Pure + deterministic.
import type { UnfurlPreview } from "../api/contract";

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

/** Fixed preview for known hosts (subdomains included); null otherwise. */
export function mockUnfurl(url: string): UnfurlPreview | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  const key = Object.keys(BY_HOST).find((h) => host === h || host.endsWith(`.${h}`));
  if (!key) return null;
  return { url, ...BY_HOST[key]! };
}
