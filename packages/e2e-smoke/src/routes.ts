// Light static extraction of a service's HTTP surface from its Hono app source.
// Reads only the app-definition file (src/app.ts) — never the client modules — so
// outbound `client.get("/...")` calls are not mistaken for route declarations.
// Handles single-level sub-router mounts (`app.route("/identity", ext)`) and mounts
// interpolated from a known prefix constant (`app.get(`${API_PREFIX}/me`, ...)`).
import { readFileSync } from "node:fs";
import { common } from "@dub/types";

export interface Route {
  method: string; // upper-case HTTP verb
  path: string; // normalized: every path param collapsed to "{}"
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

// Prefix constants services interpolate into route/mount literals. Sourced from the
// single source of truth (@dub/types) so the parser never hardcodes — and never drifts
// from — the real values. Lets `${API_PREFIX}/me` resolve to the concrete "/api/v1/me".
const PREFIX_CONSTANTS: Record<string, string> = {
  API_PREFIX: common.API_PREFIX,
  MOBILE_API_PREFIX: common.MOBILE_API_PREFIX,
};

/** Resolve a raw mount token (contents of a "", '' or `` literal) to a single concrete
 *  prefix, or null when it is not a static path. Accepts a literal "/..." or a template
 *  that begins with a known prefix constant, e.g. `${API_PREFIX}/me` -> "/api/v1/me". */
function resolvePathToken(raw: string): string | null {
  if (raw.startsWith("/")) return raw;
  const t = /^\$\{\s*([A-Za-z0-9_$]+)\s*\}(.*)$/.exec(raw);
  if (t) {
    const val = PREFIX_CONSTANTS[t[1]!];
    if (val === undefined) return null; // unknown interpolation -> not statically resolvable
    return val + t[2]!;
  }
  return null; // non-path string arg (e.g. c.get("userId"))
}

/** Some services declare their whole route surface inside a local "mount helper" whose
 *  first parameter is the path prefix, then invoke it once per prefix, e.g.
 *    const mountNotif = (p) => { app.get(`${p}/inbox`, …); … };
 *    mountNotif(""); mountNotif("/notifications");
 *  A route literal like `${p}/inbox` is therefore served under EVERY prefix the helper is
 *  called with. Map each such parameter name -> the set of concrete string-literal prefixes
 *  it is invoked with, so the extractor can expand one route per prefix. Purely static:
 *  only string-literal call args are collected (dynamic args are ignored). */
function collectPrefixParams(src: string): Map<string, string[]> {
  // helper name -> parameter name (the identifier interpolated as the leading prefix)
  const helperParam = new Map<string, string>();
  const arrowRe = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(\s*([A-Za-z0-9_$]+)\b[^)]*\)\s*=>/g;
  const fnRe = /function\s+([A-Za-z0-9_$]+)\s*\(\s*([A-Za-z0-9_$]+)\b/g;
  for (const re of [arrowRe, fnRe]) {
    for (let m; (m = re.exec(src)); ) helperParam.set(m[1]!, m[2]!);
  }
  // For each helper, gather the string-literal prefixes it is called with.
  const paramPrefixes = new Map<string, string[]>();
  for (const [helper, param] of helperParam) {
    const callRe = new RegExp(`\\b${helper}\\(\\s*["'\`]([^"'\`]*)["'\`]\\s*\\)`, "g");
    const vals = paramPrefixes.get(param) ?? [];
    for (let m; (m = callRe.exec(src)); ) if (!vals.includes(m[1]!)) vals.push(m[1]!);
    if (vals.length > 0) paramPrefixes.set(param, vals);
  }
  return paramPrefixes;
}

/** Resolve a route path token to 0+ concrete paths. A literal or prefix-constant template
 *  yields one; a `${param}…` template whose param is a known mount-helper prefix yields one
 *  per call-site prefix; anything else yields none. */
function resolveRoutePaths(raw: string, prefixParams: Map<string, string[]>): string[] {
  const t = /^\$\{\s*([A-Za-z0-9_$]+)\s*\}(.*)$/.exec(raw);
  if (t && prefixParams.has(t[1]!)) return prefixParams.get(t[1]!)!.map((p) => p + t[2]!);
  const single = resolvePathToken(raw);
  return single === null ? [] : [single];
}

/** Collapse `:param` and `{param}` to a single canonical placeholder so Hono and
 *  OpenAPI path spellings compare equal. */
export function normalizePath(p: string): string {
  return p
    .replace(/:[A-Za-z0-9_]+/g, "{}")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/\/+$/, "") || "/";
}

export function key(r: Route): string {
  return `${r.method} ${r.path}`;
}

/** Extract routes from Hono app source text. */
export function extractRoutesFromSource(src: string): Route[] {
  // 1) sub-router mounts: receiverVar -> prefix (e.g. app.route("/identity", ext)).
  const mounts = new Map<string, string>();
  const mountRe = /\.route\(\s*["'`]([^"'`]*)["'`]\s*,\s*([A-Za-z0-9_$]+)\s*\)/g;
  for (let m; (m = mountRe.exec(src)); ) {
    const prefix = resolvePathToken(m[1]!);
    if (prefix !== null) mounts.set(m[2]!, prefix);
  }

  // 1b) mount-helper prefix params: `${p}/inbox` served under every prefix the helper
  //     is invoked with (e.g. mountNotif("") + mountNotif("/notifications")).
  const prefixParams = collectPrefixParams(src);

  // 2) route declarations: <receiver>.<method>("<path>", ...). The path may be a
  //    literal ("/x") or a prefix-constant template (`${API_PREFIX}/x`); non-path
  //    string args are dropped by resolvePathToken.
  const verbs = METHODS.join("|");
  const routeRe = new RegExp(
    `([A-Za-z0-9_$]+)\\.(${verbs})\\(\\s*["'\`]([^"'\`]*)["'\`]`,
    "g",
  );
  const seen = new Set<string>();
  const out: Route[] = [];
  for (let m; (m = routeRe.exec(src)); ) {
    const receiver = m[1]!;
    const method = m[2]!.toUpperCase();
    const prefix = mounts.get(receiver) ?? "";
    for (const rawPath of resolveRoutePaths(m[3]!, prefixParams)) {
      const path = normalizePath(prefix + rawPath);
      const r: Route = { method, path };
      const k = key(r);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}

export function extractRoutesFromFile(appFile: string): Route[] {
  return extractRoutesFromSource(readFileSync(appFile, "utf8"));
}
