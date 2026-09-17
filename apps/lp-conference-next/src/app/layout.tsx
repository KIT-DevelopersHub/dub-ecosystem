import type { Metadata } from "next";
import { Inter, Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";
import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

// Typography — Inter for latin/numerals (clean, high x-height) layered over
// Zen Kaku Gothic New for Japanese (modern, highly readable geometric gothic).
// Both are self-hosted at build time via next/font (works with output: export)
// so the SSG page ships no render-blocking third-party font request.
// Inter covers latin/numerals (the page is JP-primary). It is a single ~48 KB
// latin subset and — crucially — the LCP element is the latin hero eyebrow
// ("HOKURIKU IT CONFERENCE 2027"), so Inter stays PRELOADED (next/font default)
// to keep the LCP font on the fast path. Only the huge Japanese face below is
// dropped from preload.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-inter",
  display: "swap",
});
// Zen Kaku Gothic New covers the full JIS glyph set, so next/font splits it into
// ~490 unicode-range woff2 subset chunks. Auto-preload would inject a <link
// rel="preload"> for EVERY chunk (~360 files / ~5.8 MB), stalling LCP to ~30 s on
// throttled mobile. `preload: false` drops those preloads: with `display: swap`
// the system-JP fallback paints immediately and the browser lazily fetches only
// the few subset chunks whose glyphs actually appear on the page.
const zenKaku = Zen_Kaku_Gothic_New({
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
  variable: "--font-jp",
  display: "swap",
  preload: false,
});

const config = snapshot as LpConfig;
const { seo } = config;

// Light-fixed anonymous marketing LP. Metadata is derived from the read-only
// publish snapshot; the page ships no admin design-system and calls no internal
// services live.
export const metadata: Metadata = {
  metadataBase: new URL(seo.siteUrl),
  title: seo.title,
  description: seo.description,
  alternates: { canonical: seo.siteUrl },
  openGraph: {
    type: "website",
    title: seo.title,
    description: seo.description,
    url: seo.siteUrl,
    images: [seo.ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title: seo.title,
    description: seo.description,
    images: [seo.ogImage],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className={`${inter.variable} ${zenKaku.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          本文へスキップ
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
