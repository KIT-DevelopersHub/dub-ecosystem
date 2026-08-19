// Emits dist/app-health.json at build time: the list of every hashed JS/CSS chunk the SPA
// ships. The app-health-monitor service fetches this manifest and verifies each asset resolves
// (HTTP 200) on the live origin — a 404 on any listed chunk means a deploy landed index.html but
// not all its code, the exact "something went wrong" stale-chunk failure this guards against.
//
// Why a build manifest (not scraping index.html): index.html only references the entry graph;
// lazily-split chunks are referenced from JS. Listing the whole emitted bundle catches a missing
// chunk regardless of how it's loaded. Only .js/.css are listed (source maps are dev-only).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export function appHealthManifest(): Plugin {
  return {
    name: "app-health-manifest",
    apply: "build",
    writeBundle(options, bundle) {
      const assets: string[] = [];
      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith(".js") || fileName.endsWith(".css")) {
          // Served from the site root; index.html asset URLs are root-absolute (/assets/…).
          assets.push(`/${fileName}`);
        }
      }
      assets.sort();
      const outDir = options.dir ?? "dist";
      const manifest = { generatedAt: new Date().toISOString(), count: assets.length, assets };
      writeFileSync(join(outDir, "app-health.json"), JSON.stringify(manifest, null, 2));
    },
  };
}
