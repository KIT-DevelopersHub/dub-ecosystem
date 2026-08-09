import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "../lib/site";

const STATIC_PATHS = [
  "/",
  "/about",
  "/news",
  "/events",
  "/contact",
  "/sponsors",
  "/sponsors/inquiry",
  "/code-of-conduct",
  "/privacy",
];

export const GET: APIRoute = async () => {
  const base = SITE.url.replace(/\/$/, "");
  const events = await getCollection("events");
  const news = await getCollection("news");

  const paths = [
    ...STATIC_PATHS,
    ...events.map((e) => `/events/${e.slug}`),
    ...news.map((n) => `/news/${n.slug}`),
  ];

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    paths.map((p) => `  <url><loc>${base}${p === "/" ? "/" : p}</loc></url>`).join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
