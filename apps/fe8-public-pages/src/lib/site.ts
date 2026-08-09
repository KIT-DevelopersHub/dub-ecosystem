// Site-wide constants (α defaults, design §1). Brand = DevelopersHub; flagship
// event = 北陸ITカンファレンス. Public pages are LIGHT-FIXED (design §1; no dark theme).
export const SITE = {
  name: "DevelopersHub",
  nameJa: "DevelopersHub",
  tagline: "北陸の開発者コミュニティ基盤",
  url: "https://developershub.jp",
  locale: "ja_JP",
  lang: "ja",
  ogImage: "/og-default.png",
  sameAs: ["https://github.com/developershub"],
} as const;

export interface SeoInput {
  title: string;
  description: string;
  path: string; // absolute path beginning with "/"
  ogImage?: string;
  noindex?: boolean;
}

export interface ResolvedSeo {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  noindex: boolean;
}

/** Build the SEO surface for a page (design §2-2 Seo, §7 test-point 2). */
export function resolveSeo(input: SeoInput): ResolvedSeo {
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const base = SITE.url.replace(/\/$/, "");
  const canonical = path === "/" ? `${base}/` : `${base}${path}`;
  const title = input.title === SITE.name ? SITE.name : `${input.title} | ${SITE.name}`;
  const og = input.ogImage ?? SITE.ogImage;
  return {
    title,
    description: input.description,
    canonical,
    ogImage: og.startsWith("http") ? og : `${base}${og}`,
    noindex: input.noindex ?? false,
  };
}
