// policyGate — THE authorization layer. Mounted once, first, as `app.use("*", ...)`, so it
// runs before any handler on any route, including routes added after it.
//
// WHY it exists (the bug class it closes):
//   Authorization used to be opt-in per route (`requireAuth, requirePerm(KEY)` repeated in
//   every `app.get(...)` call). A route that simply forgot the middleware was WIDE OPEN, and
//   nothing anywhere could notice: there is no artifact listing what should be checked, so
//   "no check" and "intentionally public" looked identical. Every new endpoint was another
//   chance to leave a hole.
//   Here the table is that artifact. A route the table does not mention is DENIED, not
//   allowed, and the coverage test (see coverage.ts) turns the omission red in CI. Forgetting
//   is now a loud failure instead of a silent hole.
//
// THE RULE for services using this: no other layer performs an authorization check. No
// `requirePermission` on a route, no `if (!perms.includes(...))` in a handler or service,
// and no hand-rolled `if (!c.req.header("x-dub-internal")) 404` middleware either — that
// guard is now the INTERNAL rule form, so the table lists internal-only routes too instead
// of them being invisible to a reader of the table. One table, one decision, one place to read.
//
// NOT this layer's job: anything that needs request DATA to decide — "is this task in a
// project the caller owns?" Entry-layer rules are static (method + route pattern -> keys);
// per-resource ownership is a domain rule and belongs in the service/usecase that already
// loaded the row. The split is deliberate: the gate stays a lookup plus one comparison, and
// therefore stays trivially auditable.
//
//   RESOURCE SCOPE IS PART OF THAT — the decision, not an omission. Several services ask
//   identity "does this user hold `event:read` ON event X?" (`AuthzQuery.resourceType` /
//   `resourceId`: event-service's 12 event-scoped routes, gantt-service's 5). The
//   `PermissionGranter` port below takes NO resource and WILL NOT be extended to take one.
//   Reason: `resourceId` lives in the request (a path param, a query string, sometimes the
//   body), so admitting it would turn every rule into a function of the request and the table
//   back into code — the exact property this package exists to remove. A port that can ask
//   about a resource also invites "while we're here, load the row and check the owner", which
//   is the domain layer wearing a middleware costume.
//   So a migrated service authorizes in TWO layers, by design:
//     1. the table — does the caller hold the key AT ALL (type-level: `event:read`)
//     2. the handler — does it apply to THIS resource (instance-level: event X), asserted
//        where the row is already loaded, and the branch the handler's own tests cover.
//   Dropping layer 1 into the table does not weaken anything on its own, but layer 2 must be
//   written explicitly at the same time: an event-scoped check that silently becomes
//   org-wide IS a regression (see `docs/policy-coverage-inventory.md` b-5 / a-4). Migration
//   rule of thumb: every route whose old guard passed a `resourceId` needs a handler-side
//   assertion in the same commit as its table entry.
import type { MiddlewareHandler } from "hono";
import { errors } from "@dub/errors";
import { HDR_USER_ID, HDR_INTERNAL } from "@dub/observability";
import { common, type identity } from "@dub/types";
import {
  PUBLIC,
  AUTHENTICATED,
  INTERNAL,
  isInternalWithKeys,
  missingKeys,
  type RouteRule,
  type RequiredKeys,
} from "./rule";
import type { PolicyTable } from "./table";
import { matchedRouteKey } from "./routes";

type PermissionKey = identity.PermissionKey;

/**
 * Port to the authorization decision point: which of `keys` does `userId` hold in `orgId`?
 * One call per request regardless of how many keys a rule names. Implementations MUST fail
 * closed (throw, never return a partial "allow") when identity is unreachable — see
 * `createAuthzGranter`.
 */
export type PermissionGranter = (
  userId: string,
  orgId: string,
  keys: readonly PermissionKey[],
) => Promise<readonly PermissionKey[]>;

/** Hono Variables the gate populates for handlers downstream. */
export type PolicyGateVars = {
  /**
   * Authenticated caller. Always set on an `AUTHENTICATED`, `RequiredKeys` or
   * `internalWithKeys` route (the gate 401s without it), so those handlers never re-read the
   * header or re-check whether authn happened.
   *
   * On a bare INTERNAL route it is set only when the calling service propagated a user id —
   * a liveness probe or a drain has no acting user. Handlers on INTERNAL routes that need
   * an actor must therefore check, not assume. (That is the practical difference between
   * `INTERNAL` and `internalWithKeys`: the latter guarantees an actor.)
   * On a PUBLIC route it is never set.
   */
  userId: string;
};

export interface PolicyGateOptions {
  /** Service name, for the deny message / logs. */
  service: string;
  /** The service's complete route -> rule table. */
  table: PolicyTable;
  granted: PermissionGranter;
  /** Org the request acts in. Defaults to the single P0 org. */
  orgId?: string;
}

export function policyGate(opts: PolicyGateOptions): MiddlewareHandler<{ Variables: PolicyGateVars }> {
  const orgId = opts.orgId ?? common.DUB_DEFAULT_ORG_ID;

  return async (c, next) => {
    const key = matchedRouteKey(c);
    // No endpoint matched — nothing exists to authorize; Hono answers 404.
    if (key === null) return next();

    const rule: RouteRule | undefined = opts.table[key as keyof PolicyTable];
    if (rule === undefined) {
      // Fail closed. A new endpoint without a table entry is unreachable rather than open;
      // `coverage.ts` makes this a CI failure so it is never discovered in production.
      throw errors.forbidden(`${opts.service}: no policy rule for ${key}`, {
        reason: "no_policy_rule",
        route: key,
      });
    }
    // Open to the internet by explicit decision.
    if (rule === PUBLIC) return next();

    // Any signed-in user. Authn only: prove the session, publish the id, make NO identity
    // subrequest (there are no keys to ask about). Correct only for routes whose subject is
    // the session itself — see rule.ts for the test this form must pass.
    if (rule === AUTHENTICATED) {
      const actor = c.req.header(HDR_USER_ID);
      if (!actor) throw errors.unauthenticated(`${HDR_USER_ID} absent`);
      c.set("userId", actor);
      return next();
    }

    // Service-to-service only. The marker is presence-checked, never value-matched, matching
    // @dub/http's "presence-only" contract. It is unforgeable from outside because
    // api-gateway strips all inbound x-dub-* and never re-adds this one (see rule.ts).
    // Note what this branch does NOT do: it never substitutes for a permission — a
    // RequiredKeys rule below still runs its key check for an s2s caller.
    if (rule === INTERNAL) {
      if (c.req.header(HDR_INTERNAL) === undefined) {
        throw errors.forbidden(`${opts.service}: ${key} is internal-only`, {
          reason: "internal_only",
          route: key,
        });
      }
      // Propagate the acting user when the caller supplied one; s2s calls often have none.
      const actor = c.req.header(HDR_USER_ID);
      if (actor) c.set("userId", actor);
      return next();
    }

    // Internal-only AND key-gated: a conjunction, so the marker check comes FIRST and is the
    // same 403 (`internal_only`) a bare INTERNAL route gives. An external caller therefore
    // learns nothing about which permission would have been needed, and cannot turn the route
    // into a permission oracle. Having passed it, the request falls into the ordinary key
    // check below — the marker still buys no key (rule.ts), it only opens the door.
    if (isInternalWithKeys(rule)) {
      if (c.req.header(HDR_INTERNAL) === undefined) {
        throw errors.forbidden(`${opts.service}: ${key} is internal-only`, {
          reason: "internal_only",
          route: key,
        });
      }
    }

    // Keys demanded, whether the rule reached here as RequiredKeys or internalWithKeys.
    const required: RequiredKeys = isInternalWithKeys(rule) ? rule.keys : rule;

    // Unlike a bare INTERNAL route, this one names keys, so it needs an actor to attribute
    // them to: an s2s call that propagated no user id is a 401 here, not an anonymous allow.
    const userId = c.req.header(HDR_USER_ID);
    if (!userId) throw errors.unauthenticated(`${HDR_USER_ID} absent`);
    c.set("userId", userId);

    const held = await opts.granted(userId, orgId, required);
    const missing = missingKeys(required, held);

    // ── the one authorization decision in this service ──
    if (missing.length > 0) {
      throw errors.forbidden(`permission denied: ${missing.join(", ")}`, {
        reason: "missing_permission",
        route: key,
        required: [...required],
        missing,
      });
    }

    await next();
  };
}
