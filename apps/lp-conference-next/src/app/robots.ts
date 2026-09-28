import type { MetadataRoute } from "next";
import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

const { seo } = snapshot as LpConfig;

// Static robots.txt (replaces public/robots.txt so the sitemap reference stays
// in sync with seo.siteUrl automatically). Allows all crawlers, points at
// /sitemap.xml. Generated at build time — works with `output: export`.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${seo.siteUrl}/sitemap.xml`,
  };
}
