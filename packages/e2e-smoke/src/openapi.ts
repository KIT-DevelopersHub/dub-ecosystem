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

// ── Query-parameter extraction (per operationId) ─────────────────────────────
// Route (method+path) reconciliation above is blind to query-parameter NAMES — the
// exact blind spot that let `?event=` (client) vs `?eventId=` (server) ship. This
// pulls each operation's inline `in: query` parameter names, keyed by operationId, so
// a wire-contract test can reconcile them against the @dub/types SoT + the server reads.
const OP_RE = /^\s{6,}operationId:\s*(\S+)\s*$/;
const NAME_RE = /^\s*-?\s*name:\s*(\S+)\s*$/;
const IN_RE = /^\s*in:\s*(\S+)\s*$/;

/** Map operationId -> sorted list of its `in: query` parameter names (inline params only). */
export function extractQueryParamsByOperation(src: string): Record<string, string[]> {
  const lines = src.split(/\r?\n/);
  let inPaths = false;
  let currentOp: string | null = null;
  let pendingName: string | null = null;
  const out: Record<string, Set<string>> = {};

  for (const raw of lines) {
    if (!inPaths) {
      if (/^paths:\s*$/.test(raw)) inPaths = true;
      continue;
    }
    if (/^\S/.test(raw)) break; // a new top-level key (e.g. components:) ends paths

    const op = OP_RE.exec(raw);
    if (op) {
      currentOp = op[1]!;
      pendingName = null;
      if (!out[currentOp]) out[currentOp] = new Set();
      continue;
    }
    const nm = NAME_RE.exec(raw);
    if (nm) {
      pendingName = nm[1]!;
      continue;
    }
    const im = IN_RE.exec(raw);
    if (im && currentOp && pendingName && im[1] === "query") {
      out[currentOp]!.add(pendingName);
      pendingName = null;
    }
  }
  const res: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(out)) res[k] = [...v].sort();
  return res;
}

export function extractQueryParamsFromFile(specFile: string): Record<string, string[]> {
  return extractQueryParamsByOperation(readFileSync(specFile, "utf8"));
}
