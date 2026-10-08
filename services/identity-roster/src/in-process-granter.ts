// The PermissionGranter identity-roster hands to its own policyGate — and the ONE service in
// the ecosystem that cannot use `@dub/policy-gate`'s `sharedAuthzGranter`.
//
// WHY: that granter answers "which of these keys does this user hold?" by POSTing
// /authz/check over the SVC_IDENTITY Service Binding. identity-roster IS the Worker serving
// /authz/check, so wiring it here would make every gated request call back into this same
// app, which re-enters the gate, which calls the granter again — unbounded self-recursion
// across the binding (and a subrequest storm) for one roster read. The service has decided
// its own authorization in-process since before the gate existed (`svc.can` /
// `svc.decidePolicy`, the "dogfood" middleware), and this adapter is that same path wearing
// the gate's port.
//
// It is deliberately a thin ADAPTER, not a second evaluator: the decision still comes from
// `IdentityService.effectivePermissions`, i.e. `authz.ts`'s `effectiveOrgWidePermissions`
// over the rows the repo loaded — the exact function `POST /authz/check` and the gateway's
// /me aggregation answer from. There is no second copy of the RBAC semantics to drift.
import type { PermissionGranter } from "@dub/policy-gate";
import type { IdentityService } from "./service";

/**
 * `(userId, orgId, keys) -> the subset of keys held` — the gate's port, satisfied in-process.
 *
 * Contract notes, matching `createAuthzGranter` (packages/policy-gate/src/authz.ts) so the
 * gate behaves identically whichever granter it was given:
 *   - ONE lookup per request regardless of how many keys the rule names (the whole effective
 *     set is loaded once and intersected), so a 2-key `appLevel` rule costs what the old
 *     `requirePolicy` single `decidePolicy` call cost — not one query per key.
 *   - FAIL CLOSED: a repo failure throws out of here and becomes a 5xx. It must never
 *     degrade into "no decision, so allow".
 *   - NO CACHE, on purpose. ADR 0004's TTL cache exists to avoid the network hop; there is
 *     none here, and a cache would instead make identity-roster the one service that can
 *     authorize a request against a stale copy of a role it just rewrote — the keys this
 *     very service mutates (`POST /identity/users/:id/roles` and friends) are exactly the
 *     ones `isDangerousPermission` forces off the cache elsewhere.
 *   - ORG-WIDE ONLY, like the port itself: `PermissionGranter` takes no resource (gate.ts
 *     states it never will), and `effectiveOrgWidePermissions` is the matching semantics —
 *     a resource-scoped grant never satisfies an entry-layer rule. Resource-scoped checks
 *     stay in the handler/service layer, where the row is already loaded.
 */
export function createInProcessGranter(svc: IdentityService): PermissionGranter {
  return async (userId, orgId, keys) => {
    if (keys.length === 0) return [];
    const { permissions } = await svc.effectivePermissions(userId, orgId);
    const held = new Set<string>(permissions);
    // Preserve the caller's key order, as the wire granter does.
    return keys.filter((k) => held.has(k));
  };
}
