import type { Metadata } from "next";
import "./globals.css";
import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

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
      <body>
        <a className="skip-link" href="#main">
          本文へスキップ
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
