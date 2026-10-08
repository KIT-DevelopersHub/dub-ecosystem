// Route identity — the ONE string shape a table key, a registered Hono route and a matched
// request all reduce to ("GET /driveshare/files"). The gate and the coverage test both go
// through here, so "the route the gate looked up" and "the route the test says must exist"
// can never be computed two slightly different ways.
import type { Context } from "hono";

export interface RegisteredRoute {
  method: string;
  path: string;
}

/** Anything exposing Hono's `routes` array (a Hono app, or a test double). */
export interface RoutedApp {
  readonly routes: readonly RegisteredRoute[];
}

/** `"GET /driveshare/files"` — method upper-cased, path verbatim (pattern, not URL). */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Hono registers `app.use(path, mw)` as a route with method ALL and the mount path
 * verbatim — `app.use("*", mw)` and the equally common scoped `app.use("/items/*", mw)`
 * both land in `app.routes`. Those entries are middleware, not endpoints, and must not be
 * mistaken for a route needing a rule.
 *
 * CONSTRAINT this imposes on gated services: register every endpoint with a CONCRETE
 * method. `app.get("/files/*", h)` is fine (method GET, so it is still an endpoint and IS
 * gated); `app.all("/files/*", h)` is forbidden, because Hono records it identically to a
 * `use` mount and the gate would then skip it. Use `app.get`/`post`/… instead — there is no
 * way to tell the two apart after registration, so this is a convention, not a check.
 */
function isMiddlewareMount(r: RegisteredRoute): boolean {
  if (r.method.toUpperCase() !== "ALL") return false;
  return r.path === "*" || r.path.endsWith("/*");
}

/**
 * Every endpoint of `app` that the gate is responsible for, de-duplicated and in
 * registration order. Hono records one entry per handler, so a route declared as
 * `app.get(p, mwA, mwB, handler)` appears three times — collapsed here to one key.
 */
export function protectableRouteKeys(app: RoutedApp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of app.routes) {
    if (isMiddlewareMount(r)) continue;
    const key = routeKey(r.method, r.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The route PATTERN the current request matched, as a table key. Null when no endpoint
 * matched (only catch-all middleware ran) — there is nothing to authorize and Hono will
 * 404. Read from `c.req.matchedRoutes` so the gate uses Hono's own routing decision rather
 * than re-implementing path matching.
 */
export function matchedRouteKey(c: Context): string | null {
  const matched = c.req.matchedRoutes;
  for (let i = matched.length - 1; i >= 0; i--) {
    const r = matched[i]!;
    if (!isMiddlewareMount(r)) return routeKey(r.method, r.path);
  }
  return null;
}
