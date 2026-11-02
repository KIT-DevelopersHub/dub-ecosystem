#!/usr/bin/env node
// Fails when the staging debug menu leaked into a PRODUCTION fe2 build.
// The menu is a lazy chunk behind VITE_DEMO_AUTOLOGIN / VITE_DEMO; a prod build (neither set)
// must contain none of its markers in any emitted file (JS, CSS, sourcemaps, HTML).
//   node apps/fe2-app-shell/scripts/assert-no-staging-debug.mjs [distDir]
// Skips (exit 0) when the build was made with a staging/demo flag, since the menu is expected there.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEBUG_MENU_MARKERS = ["fe2-staging-debug-menu", "fe2-staging-debug-fab"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|css|map|html)$/.test(name)) out.push(p);
  }
  return out;
}

/** Returns [{ file, marker }] for every marker hit under distDir. */
export function findDebugMenuLeaks(distDir) {
  const hits = [];
  for (const file of walk(distDir)) {
    const text = readFileSync(file, "utf8");
    for (const marker of DEBUG_MENU_MARKERS) if (text.includes(marker)) hits.push({ file, marker });
  }
  return hits;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const distDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const flagged = ["VITE_DEMO_AUTOLOGIN", "VITE_DEMO"].filter((k) => ["1", "true"].includes(process.env[k] ?? ""));
  if (flagged.length > 0) {
    console.log(`[assert-no-staging-debug] skipped: ${flagged.join(", ")} set (non-production build).`);
    process.exit(0);
  }
  if (!existsSync(distDir)) {
    console.error(`[assert-no-staging-debug] dist not found: ${distDir} (run the fe2 build first)`);
    process.exit(1);
  }
  const hits = findDebugMenuLeaks(distDir);
  if (hits.length > 0) {
    for (const h of hits) console.error(`::error::staging debug menu leaked into production bundle: ${h.marker} in ${h.file}`);
    process.exit(1);
  }
  console.log("[assert-no-staging-debug] ok: production bundle contains no staging debug menu.");
}
