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

/** Resolve a raw route/mount token (contents of a "", '' or `` literal) to a concrete
 *  path, or null when it is not a static path. Accepts a literal "/..." or a template
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
    const rawPath = resolvePathToken(m[3]!);
    if (rawPath === null) continue;
    const method = m[2]!.toUpperCase();
    const prefix = mounts.get(receiver) ?? "";
    const path = normalizePath(prefix + rawPath);
    const r: Route = { method, path };
    const k = key(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}

export function extractRoutesFromFile(appFile: string): Route[] {
  return extractRoutesFromSource(readFileSync(appFile, "utf8"));
}
