import type { Metadata } from "next";
import "./globals.css";
import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

// Typography — Inter for latin/numerals (clean, high x-height) layered over
// Zen Kaku Gothic New for Japanese (modern, highly readable geometric gothic).
// Loaded at RUNTIME via Google Fonts <link> (display=swap) rather than
// next/font/google, because next/font fetches the font files at BUILD time and
// the CI builder has no outbound network (build failed with next/font). The
// stylesheet is preconnected and uses display=swap so the system fallback paints
// immediately (no FOIT) while the web fonts stream in. Family names are exposed
// to globals.css through the --font-inter / --font-jp CSS variables.
const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap";

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
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          本文へスキップ
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
