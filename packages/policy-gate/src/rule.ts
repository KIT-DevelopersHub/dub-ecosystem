// The rule vocabulary a policy table is written in. Deliberately tiny — five forms, and the
// list is CLOSED:
//
//   PUBLIC                   the open internet may call this, deliberately
//   AUTHENTICATED            any signed-in user, no permission key
//   INTERNAL                 service-to-service only (x-dub-internal marker)
//   [key, ...]               the caller must hold EVERY key (see also `appLevel`)
//   internalWithKeys([...])  BOTH: the marker AND every key
//
// Two axes, not five unrelated cases: "who may reach this door" (internet / signed-in user /
// our own Workers) times "which permission keys they must hold" (none / some). The forms are
// the combinations that actually occur.
//
// There is no callback, no "resolve at runtime" escape hatch, and no OR — anything that needs
// request DATA to decide is NOT an entry-layer concern (see gate.ts's header for where it goes).
// Adding a sixth form is a design change, not a convenience: a reader of a table must be able
// to hold the whole vocabulary in their head, which is the property that makes the table
// auditable at a glance.
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
 * A route ANY signed-in user may call: authentication is required, no permission key is.
 * The gate 401s without `x-dub-user-id` and otherwise lets the request through, setting
 * `userId` for the handler. It makes NO identity subrequest (there is nothing to ask about),
 * so this form is also the cheapest gated rule.
 *
 * WHEN THIS IS THE RIGHT ANSWER — one narrow shape, and it is the only one:
 * the handler acts solely on the SESSION's own user id, and the client cannot name the
 * subject. api-gateway's `/me` family is the model: the route has no `:userId` segment and
 * the handler takes the id from the authenticated session, so "may I read this?" cannot even
 * be asked about someone else. Same for `GET /members/me/mention-teams` (derives the caller's
 * own teams) and `POST /feedback` (files feedback as the caller). A self-scoped route like
 * that needs no key because there is no privileged subject to protect.
 *
 * WHEN IT IS WRONG — and this is the failure mode to watch for in review:
 *   - "we want this one to be permissive" / "everyone complains about the 403". That is a
 *     ROLE problem (fix the role in ロール管理), not a table problem. AUTHENTICATED written
 *     for convenience silently drops a route out of ロール管理's control forever, and reads
 *     in the table as if it were a decision.
 *   - the path (or body) names the subject — `/users/:id/...`, `?userId=`, `{ "targetId": }`.
 *     Then every signed-in user can act on every other user and the route needs keys.
 *   - the handler reads or writes anything org-wide, even read-only. "Only a list of names"
 *     is still a roster read: that is `appLevel(...)` or an explicit key.
 *
 * AUTHENTICATED vs PUBLIC — not interchangeable in either direction:
 *   PUBLIC        = no session at all; `userId` is NOT set and a handler must not expect one.
 *   AUTHENTICATED = a session is required and proven; `userId` is always set.
 * A `/me` route marked PUBLIC does not become "slightly more open" — it loses the very id its
 * handler is built on. Conversely a genuinely open endpoint (a provider webhook, the login
 * route itself) cannot be AUTHENTICATED: there is no session yet by construction.
 */
export const AUTHENTICATED = "authenticated" as const;

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
 * INTERNAL does NOT imply any permission, and it does not DEMAND one either. It is a separate
 * axis: an s2s call carrying the marker still fails a `RequiredKeys` rule unless it also holds
 * the keys (the gate never lets the marker substitute for a permission), while a bare
 * `INTERNAL` route accepts an s2s call that holds nothing at all. Conversely no permission
 * key, however privileged, opens an INTERNAL route to an external caller.
 *
 * Need both at once ("internal-only AND the acting user must hold a key")? That is
 * `internalWithKeys([...])` below — not `INTERNAL` plus a hand-rolled check in the handler.
 */
export const INTERNAL = "internal" as const;

/** Non-empty by type: "I thought about this route and it needs no key" must be PUBLIC,
 *  AUTHENTICATED or INTERNAL, written out, rather than an easy-to-miss empty array. */
export type RequiredKeys = readonly [PermissionKey, ...PermissionKey[]];

/** Discriminant of the one object-shaped rule form, so narrowing never leans on
 *  `Array.isArray` against a readonly tuple. */
const INTERNAL_WITH_KEYS = "internal+keys" as const;

/**
 * The conjunction of `INTERNAL` and `RequiredKeys`: the caller must carry the s2s marker
 * AND hold every key. Produced only by `internalWithKeys`, never written by hand.
 */
export interface InternalWithKeys {
  readonly kind: typeof INTERNAL_WITH_KEYS;
  readonly keys: RequiredKeys;
}

/**
 * "Internal-only AND key-gated" — both halves, in one rule.
 *
 * WHY a named form rather than two rules: the two axes are independent (see INTERNAL above:
 * the marker never substitutes for a key, a key never opens an internal door), and a real
 * service needs both at once. mail-automation is the case that forced this: its 13 routes sit
 * behind no gateway segment (unreachable from outside) and ALSO demand `mail:read`/`mail:admin`
 * of the acting user that the calling service propagated. Written as plain `["mail:admin"]`
 * the table would claim the route is externally reachable by any mail admin; written as
 * `INTERNAL` it would claim an s2s call needs no key, letting one compromised caller drive
 * admin-level mutations. Both are lies about the route, and the lie is in the artifact that
 * reviewers trust. The explicit name makes the intent unmissable in the table itself.
 *
 * The call reads as the declaration it is:
 *   "PATCH /settings": internalWithKeys(["mail:admin"]),
 *   "POST /process":   internalWithKeys(appLevel("mail", "edit", "mail:send")),
 *
 * Keys are non-empty by type, exactly as `RequiredKeys`: an internal route that genuinely
 * needs no key is plain `INTERNAL`, which says so.
 *
 * Reachability: `allows()` is FALSE for every key set, same as `INTERNAL` — these routes
 * belong in no role's reachable set, because no external caller can reach them at all.
 */
export function internalWithKeys(keys: RequiredKeys): InternalWithKeys {
  return { kind: INTERNAL_WITH_KEYS, keys };
}

/**
 * What one route demands. A discriminated union: the three string constants, the key tuple,
 * and the one object form. `RequiredKeys` is conjunctive (the caller must hold EVERY key) —
 * the stricter reading, so a half-finished entry errs toward 403 rather than toward an
 * accidental allow. OR-semantics is intentionally absent: express it as two routes or a
 * single key, never as a looser rule.
 */
export type RouteRule =
  | typeof PUBLIC
  | typeof AUTHENTICATED
  | typeof INTERNAL
  | RequiredKeys
  | InternalWithKeys;

/** Narrows `RouteRule` to the marker-and-keys form. */
export function isInternalWithKeys(rule: RouteRule): rule is InternalWithKeys {
  // `"kind" in rule` (not Array.isArray) is what narrows a readonly tuple reliably.
  return typeof rule === "object" && "kind" in rule && rule.kind === INTERNAL_WITH_KEYS;
}

/** The keys a rule demands, or `undefined` for the key-free forms. */
export function requiredKeysOf(rule: RouteRule): RequiredKeys | undefined {
  if (rule === PUBLIC || rule === AUTHENTICATED || rule === INTERNAL) return undefined;
  return isInternalWithKeys(rule) ? rule.keys : rule;
}

/**
 * Which keys a rule demands that `granted` does not hold — `[]` means "this rule's KEY
 * requirement is satisfied".
 *
 * CAREFUL: `[]` is not the same as "allowed". PUBLIC, AUTHENTICATED and INTERNAL demand no
 * keys, so all three return `[]` here, yet INTERNAL is still closed to a caller without the
 * marker and AUTHENTICATED is still closed to a caller with no session. Symmetrically an
 * `internalWithKeys` rule can return `[]` for a caller who holds the keys but carries no
 * marker — satisfied on the key axis, denied on the other. For a reachability question ("can
 * a role holding these keys call this route?") use `allows`, which answers correctly for
 * every rule form. The gate branches on the non-key axis before it reaches this function.
 */
export function missingKeys(rule: RouteRule, granted: Iterable<PermissionKey>): PermissionKey[] {
  const required = requiredKeysOf(rule);
  if (required === undefined) return [];
  const held = granted instanceof Set ? granted : new Set(granted);
  return required.filter((k) => !held.has(k));
}

/**
 * True when a caller holding exactly `granted` — and NOT carrying the internal marker, i.e.
 * a normal user request through api-gateway — may call the route.
 *
 * This is the predicate the per-service "role x endpoint" matrix tests use, so both
 * internal-only forms (`INTERNAL`, `internalWithKeys`) correctly appear in NO role's
 * reachable set: no permission key grants an external caller an internal-only endpoint, and
 * that stays true when the internal route ALSO demands keys.
 *
 * AUTHENTICATED is true for every key set, including the empty one — the opposite end from
 * INTERNAL. That is the honest answer to "which roles can reach this": all of them, which is
 * precisely the fact a matrix test should show rather than hide.
 */
export function allows(rule: RouteRule, granted: Iterable<PermissionKey>): boolean {
  if (rule === INTERNAL || isInternalWithKeys(rule)) return false;
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
