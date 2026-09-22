import type { MetadataRoute } from "next";
import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

const { seo } = snapshot as LpConfig;

// PWA / "add to home screen" manifest. Served at /manifest.webmanifest and
// linked automatically by Next.js. Icons are the navy-plate brand mark
// (maskable + any) generated from the official logo.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: seo.title,
    short_name: "北陸ITカンファ",
    description: seo.description,
    start_url: "/",
    display: "standalone",
    background_color: "#0c1533",
    theme_color: "#0c1533",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
