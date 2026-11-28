#!/usr/bin/env node
// Inlines the Next.js CSS into every exported HTML page so the first paint needs no
// extra round trip (Lighthouse: render-blocking resources / FCP on slow mobile).
//
// Each `<link rel="stylesheet" ... data-precedence="next">` gets an inline <style> copy
// in front of it, and the link itself becomes media="print" (downloaded at low priority,
// never applied). The link stays in the DOM on purpose: React's hydration finds it there
// and does not insert a second, render-blocking copy.
//
// Usage: node scripts/inline-css.mjs <outDir>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: inline-css.mjs <outDir>");
  process.exit(2);
}

const LINK = /<link rel="stylesheet" href="([^"]*\/_next\/static\/css\/([\w-]+\.css))" data-precedence="next"\/>/g;

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "_next") return [];
    if (statSync(p).isDirectory()) return htmlFiles(p);
    return name.endsWith(".html") ? [p] : [];
  });
}

let pages = 0;
for (const file of htmlFiles(outDir)) {
  const html = readFileSync(file, "utf8");
  let count = 0;
  const next = html.replace(LINK, (_, href, name) => {
    count++;
    const css = readFileSync(join(outDir, "_next", "static", "css", name), "utf8").replace(/<\/style/gi, "<\\/style");
    return `<style data-inline-css="${name}">${css}</style><link rel="stylesheet" href="${href}" data-precedence="next" media="print"/>`;
  });
  if (count > 0) {
    writeFileSync(file, next);
    pages++;
  }
}
console.log(`[inline-css] inlined stylesheets into ${pages} page(s) in ${outDir}`);
