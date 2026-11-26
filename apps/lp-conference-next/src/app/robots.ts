import type { MetadataRoute } from "next";
import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

const { seo } = snapshot as LpConfig;

// AI training crawlers kept out of the LP. Same list as Cloudflare's managed robots.txt,
// so that setting can be turned off (its `Content-Signal:` line fails Lighthouse SEO)
// without opening the site to them.
const AI_TRAINING_BOTS = [
  "Amazonbot",
  "anthropic-ai",
  "Applebot-Extended",
  "atlassian-bot",
  "AwarioRssBot",
  "AwarioSmartBot",
  "Baiduspider",
  "BorderxBot",
  "Bytespider",
  "CCBot",
  "CitibotSiteCrawler",
  "Claude-Web",
  "ClaudeBot",
  "cohere-ai",
  "Cotoyogi",
  "Diffbot",
  "FishBot",
  "Google-CloudVertexBot",
  "Google-Extended",
  "GoogleOther",
  "GPTBot",
  "ICC-Crawler",
  "KimiBot",
  "magpie-crawler",
  "meta-externalagent",
  "MistralAI-Training",
  "NavuBot",
  "omgili",
  "PetalBot",
  "QualifiedBot",
  "SemrushBot-SWA",
  "WARDBot",
];

// Static robots.txt (replaces public/robots.txt so the sitemap reference stays
// in sync with seo.siteUrl automatically). Allows search crawlers, points at
// /sitemap.xml. Generated at build time — works with `output: export`.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      { userAgent: AI_TRAINING_BOTS, disallow: "/" },
    ],
    sitemap: `${seo.siteUrl}/sitemap.xml`,
  };
}
