// Emits dist/app-health.json at build time so the app-health-monitor can verify the SPA's code
// is fully present on the live origin — a 404 on a referenced chunk is the "something went wrong"
// stale-chunk failure this guards against.
//
// Two lists are emitted:
//   • loadBearing — the chunks that gate "can a screen open": the entry chunk + its static
//     imports (the always-loaded vendor/shell graph) + every dynamic-entry chunk (one per lazily
//     loaded app screen) + their CSS. The monitor probes THIS set every cycle. Bounded (~1 per
//     screen) so the whole poll stays under the Workers free-plan 50-subrequests-per-invocation
//     cap. Cloudflare static-asset deploys are ATOMIC (the whole dist goes live together), so
//     verifying the entry graph + each screen's dynamic entry proves the deployment is complete —
//     no need to also chase every transitive import.
//   • assets — every JS/CSS output (reference / debugging; not all probed each cycle).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export function appHealthManifest(): Plugin {
  return {
    name: "app-health-manifest",
    apply: "build",
    writeBundle(options, bundle) {
      const assets: string[] = [];
      const loadBearing = new Set<string>();
      const url = (f: string) => `/${f}`;

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith(".js") || fileName.endsWith(".css")) assets.push(url(fileName));
        if ((chunk as { type?: string }).type !== "chunk") continue;
        const c = chunk as {
          isEntry?: boolean;
          isDynamicEntry?: boolean;
          imports?: string[];
          fileName: string;
          viteMetadata?: { importedCss?: Set<string> };
        };
        // Entry (shell) + its static imports (vendor graph), and every dynamic entry (a lazily
        // loaded screen). These are exactly the files whose absence breaks "open a screen".
        // Entry (shell) contributes itself + its static imports (the always-loaded vendor graph).
        if (c.isEntry) {
          loadBearing.add(url(c.fileName));
          for (const imp of c.imports ?? []) loadBearing.add(url(imp));
        }
        // Each dynamic entry is one lazily-loaded screen — probe its own chunk (atomic deploy
        // means its imports ship together, so the per-screen chunk is the representative signal).
        if (c.isDynamicEntry) loadBearing.add(url(c.fileName));
        if (c.isEntry || c.isDynamicEntry) {
          for (const css of c.viteMetadata?.importedCss ?? []) loadBearing.add(url(css));
        }
      }

      assets.sort();
      const manifest = {
        generatedAt: new Date().toISOString(),
        loadBearing: [...loadBearing].sort(),
        count: assets.length,
        assets,
      };
      writeFileSync(join(options.dir ?? "dist", "app-health.json"), JSON.stringify(manifest, null, 2));
    },
  };
}
