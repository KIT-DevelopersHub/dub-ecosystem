// The policy TABLE: one object literal per service listing every endpoint and the keys it
// demands. This is the artifact the whole package exists for — the place a reviewer (or an
// AI writing the next endpoint) looks to answer "who may call this?" without reading a
// single handler.
import type { RouteRule } from "./rule";

/** Methods a table key may use (Hono's verbs + ALL). */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "ALL";

/** `"PATCH /driveshare/files/:id/permissions/:permId"` — the method and the route PATTERN
 *  exactly as registered on the router (`:param` segments included, verbatim). */
export type RouteKey = `${HttpMethod} /${string}`;

export type PolicyTable = Readonly<Partial<Record<RouteKey, RouteRule>>>;

/**
 * Identity function that pins a table literal to `PolicyTable` while keeping its exact keys.
 *
 * Two compile-time guarantees come from using it instead of a plain object:
 *   - a permission string outside `PERMISSION_CATALOG` is a type error (the rule type is
 *     built on the closed `PermissionKey` union), and
 *   - a malformed key ("GET/driveshare", "get /x", "FETCH /x") is a type error.
 * The `const` type parameter is what makes `["drive:read"]` infer as a readonly tuple of
 * literals rather than `string[]`.
 */
export function definePolicyTable<const T extends PolicyTable>(table: T): T {
  return table;
}
