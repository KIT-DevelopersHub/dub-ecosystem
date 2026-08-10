// Light static extraction of a service's HTTP surface from its Hono app source.
// Reads only the app-definition file (src/app.ts) — never the client modules — so
// outbound `client.get("/...")` calls are not mistaken for route declarations.
// Handles single-level sub-router mounts (`app.route("/identity", ext)`).
import { readFileSync } from "node:fs";

export interface Route {
  method: string; // upper-case HTTP verb
  path: string; // normalized: every path param collapsed to "{}"
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

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
  const mountRe = /\.route\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*([A-Za-z0-9_$]+)\s*\)/g;
  for (let m; (m = mountRe.exec(src)); ) mounts.set(m[2]!, m[1]!);

  // 2) route declarations: <receiver>.<method>("<path starting with />", ...).
  const verbs = METHODS.join("|");
  const routeRe = new RegExp(
    `([A-Za-z0-9_$]+)\\.(${verbs})\\(\\s*["'\`](/[^"'\`]*)["'\`]`,
    "g",
  );
  const seen = new Set<string>();
  const out: Route[] = [];
  for (let m; (m = routeRe.exec(src)); ) {
    const receiver = m[1]!;
    const method = m[2]!.toUpperCase();
    const prefix = mounts.get(receiver) ?? "";
    const path = normalizePath(prefix + m[3]!);
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
