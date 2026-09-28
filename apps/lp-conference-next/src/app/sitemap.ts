import type { MetadataRoute } from "next";
import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

const { seo, publishedAt } = snapshot as LpConfig;

// Static sitemap.xml (single-page LP). Generated at build time like
// manifest.ts / robots.ts — no server runtime, works with `output: export`.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: seo.siteUrl,
      lastModified: publishedAt,
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
