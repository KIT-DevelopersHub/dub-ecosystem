// Minimal OpenAPI paths extractor. Deliberately dependency-free: it only reads the
// `paths:` block's path keys and their HTTP-method sub-keys (all this conformance
// check needs), so no YAML library is pulled in for a light reconciliation.
import { readFileSync } from "node:fs";
import { normalizePath, key, type Route } from "./routes";

const METHOD_RE = /^\s{4,}(get|post|put|patch|delete|head|options|trace):\s*$/;
const PATH_RE = /^\s{2}("?)(\/[^"]*?)\1:\s*$/;

/** Parse {method, path} pairs from an OpenAPI 3.x spec's `paths:` block. */
export function extractSpecRoutesFromSource(src: string): Route[] {
  const lines = src.split(/\r?\n/);
  let inPaths = false;
  let currentPath: string | null = null;
  const seen = new Set<string>();
  const out: Route[] = [];

  for (const raw of lines) {
    if (!inPaths) {
      if (/^paths:\s*$/.test(raw)) inPaths = true;
      continue;
    }
    // A new top-level key (no indent) ends the paths block.
    if (/^\S/.test(raw)) break;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    const pm = PATH_RE.exec(raw);
    if (pm) {
      currentPath = normalizePath(pm[2]!);
      continue;
    }
    const mm = METHOD_RE.exec(raw);
    if (mm && currentPath) {
      const r: Route = { method: mm[1]!.toUpperCase(), path: currentPath };
      const k = key(r);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}

export function extractSpecRoutesFromFile(specFile: string): Route[] {
  return extractSpecRoutesFromSource(readFileSync(specFile, "utf8"));
}
