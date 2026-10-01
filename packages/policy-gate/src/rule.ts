// The rule vocabulary a policy table is written in. Deliberately tiny: a route is PUBLIC,
// INTERNAL, or it names the catalog permission keys the caller must hold. There is no fourth
// form, no callback, no "resolve at runtime" escape hatch — anything that needs request
// DATA to decide is NOT an entry-layer concern (see gate.ts's header for where it goes).
import { identity, policy, appRegistry } from "@dub/types";

type PermissionKey = identity.PermissionKey;

/**
 * A route ANYONE may call — unauthenticated, from the open internet, through api-gateway.
 * Public webhooks and the handful of genuinely open endpoints. Nothing else.
 *
 * Do NOT reach for this for a liveness probe or any other "it's only called by us anyway"
 * endpoint: that is INTERNAL, which is enforced rather than merely assumed.
 */
export const PUBLIC = "public" as const;

/**
 * A route only a genuine service-to-service call may reach: a Service Binding call that
 * carries the `x-dub-internal` marker (`HDR_INTERNAL`, set by `@dub/http`'s
 * `createServiceClient` on every s2s call). Anything else gets 403.
 *
 * WHY this is not forgeable: api-gateway's proxy (`services/api-gateway/src/proxy.ts`)
 * strips EVERY inbound `x-dub-*` header as spoof defense and deliberately never re-adds
 * `x-dub-internal` on an external forward. So an external client cannot make its request
 * look internal no matter what it sends, and the marker's presence really does mean "this
 * came from another Worker over a binding".
 *
 * INTERNAL vs PUBLIC — the distinction this constant exists to force:
 *   PUBLIC   = "the open internet may call this, and that is intended".
 *   INTERNAL = "only our own services may call this".
 * Health probes, drain/landing routes, admin-only s2s endpoints are INTERNAL. Marking them
 * PUBLIC is the lazy answer that happens to work (the gateway usually does not route them)
 * and leaves a real hole the day routing changes. See `src/policy-table.ts` of any service.
 *
 * INTERNAL does NOT imply any permission. It is a separate axis: an s2s call carrying the
 * marker still fails a `RequiredKeys` rule unless it also holds the keys (the gate never
 * lets the marker substitute for a permission). Conversely no permission key, however
 * privileged, opens an INTERNAL route to an external caller.
 */
export const INTERNAL = "internal" as const;

/** Non-empty by type: "I thought about this route and it needs no key" must be PUBLIC or
 *  INTERNAL, written out, rather than an easy-to-miss empty array. */
export type RequiredKeys = readonly [PermissionKey, ...PermissionKey[]];

/**
 * What one route demands. `RequiredKeys` is conjunctive (the caller must hold EVERY key) —
 * the stricter reading, so a half-finished entry errs toward 403 rather than toward an
 * accidental allow. OR-semantics is intentionally absent: express it as two routes or a
 * single key, never as a looser rule.
 */
export type RouteRule = typeof PUBLIC | typeof INTERNAL | RequiredKeys;

/**
 * Which keys a rule demands that `granted` does not hold — `[]` means "this rule's KEY
 * requirement is satisfied".
 *
 * CAREFUL: `[]` is not the same as "allowed". PUBLIC and INTERNAL demand no keys, so both
 * return `[]` here, but INTERNAL is still closed to a caller without the marker. For a
 * reachability question ("can a role holding these keys call this route?") use `allows`,
 * which answers correctly for all three rule forms. The gate branches on PUBLIC/INTERNAL
 * before it ever reaches this function.
 */
export function missingKeys(rule: RouteRule, granted: Iterable<PermissionKey>): PermissionKey[] {
  if (rule === PUBLIC || rule === INTERNAL) return [];
  const held = granted instanceof Set ? granted : new Set(granted);
  return rule.filter((k) => !held.has(k));
}

/**
 * True when a caller holding exactly `granted` — and NOT carrying the internal marker, i.e.
 * a normal user request through api-gateway — may call the route.
 *
 * This is the predicate the per-service "role x endpoint" matrix tests use, so INTERNAL
 * routes correctly appear in NO role's reachable set: no permission key grants an external
 * caller an internal-only endpoint.
 */
export function allows(rule: RouteRule, granted: Iterable<PermissionKey>): boolean {
  if (rule === INTERNAL) return false;
  return missingKeys(rule, granted).length === 0;
}

/**
 * The keys the ロール管理 3-tier demands for `app` at `level`, plus any fine-grained keys.
 *
 * Use this instead of hand-writing `app:<id>:view` in a table: the app -> key mapping lives
 * in APP_MANIFEST (`@dub/types` appRegistry) and is reached through `policy.keysForAppLevel`,
 * so a table can never disagree with ロール管理 about what 閲覧/編集 means. Throws on an
 * unregistered app id — a typo fails at module load, not on a request.
 */
export function appLevel(
  app: string,
  level: Exclude<policy.AppAccessLevel, "none">,
  ...alsoRequires: PermissionKey[]
): RequiredKeys {
  if (!appRegistry.getApp(app)) {
    throw new Error(`policy-gate: unknown app id "${app}" (not in APP_MANIFEST)`);
  }
  const keys = [...policy.keysForAppLevel(app, level), ...alsoRequires];
  const unique = [...new Set(keys)];
  // keysForAppLevel returns >=1 key for every registered app at view/edit, so the cast is
  // sound; assert anyway so a future manifest change cannot silently produce an empty rule.
  const [first, ...rest] = unique;
  if (first === undefined) throw new Error(`policy-gate: app "${app}" resolved to no keys`);
  return [first, ...rest];
}
