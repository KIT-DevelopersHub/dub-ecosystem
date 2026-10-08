// The one production implementation of the gate's PermissionGranter port: identity-roster's
// POST /authz/check over a Service Binding. Services wire it in a single line, so none of
// them hand-rolls the wire call (and none can accidentally hand-roll an evaluator either —
// the decision stays in identity-roster/src/authz.ts).
//
// It is a CACHING granter, per ADR 0004: every decision identity returns is held for the TTL
// identity itself specifies, dangerous keys are always re-asked, and only cache misses go on
// the wire (still one batched call, never one call per key). See authz-cache.ts for why each
// of those is a requirement rather than a tuning knob.
//
// Use `sharedAuthzGranter(env, ...)` in a Worker entrypoint, not `createAuthzGranter`: the
// cache only pays off if it outlives the request, and a granter built per request has a
// freshly empty one.
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, newRequestId } from "@dub/http";
import type { identity } from "@dub/types";
import type { PermissionGranter } from "./gate";
import {
  createAuthzCache,
  isDangerousPermission,
  type AuthzCacheOptions,
  type AuthzDecisionCache,
} from "./authz-cache";

/** identity-roster caps one /authz/check at 20 queries (MAX_BATCH_CHECKS). */
const MAX_BATCH_CHECKS = 20;

export interface AuthzGranterOptions {
  /** Calling service name (correlation headers / identity logs). */
  caller: string;
  /** Propagate the inbound x-dub-request-id when the caller has it. */
  requestId?: string;
  /**
   * TTL cache for decisions. Omit and the granter gets its own — which is only useful if
   * the granter itself is long-lived; `sharedAuthzGranter` passes one that is memoized per
   * Env so it survives across requests in the same isolate.
   */
  cache?: AuthzDecisionCache;
  /** Tuning for the cache this granter creates when `cache` is not supplied. */
  cacheOptions?: AuthzCacheOptions;
}

export function createAuthzGranter(binding: Fetcher, opts: AuthzGranterOptions): PermissionGranter {
  const client = createServiceClient(binding, { service: "identity-roster", caller: opts.caller });
  const cache = opts.cache ?? createAuthzCache(opts.cacheOptions);

  return async (userId, orgId, keys) => {
    if (keys.length === 0) return [];

    // Cache granularity is exactly the query granularity: (userId, orgId, permission), the
    // three arguments this port takes. gate.ts states the port will NOT grow a resource
    // parameter; if that ever changes, the resource MUST become part of the cache key in the
    // same commit, or a decision about resource X would answer a question about resource Y.
    // Decisions by request position, so the returned subset keeps the caller's key order.
    const allowed = new Array<boolean | undefined>(keys.length);
    const missIdx: number[] = [];
    keys.forEach((permission, i) => {
      // Dangerous keys bypass the cache on read AND on write (authz-cache.ts).
      const hit = isDangerousPermission(permission) ? undefined : cache.get(userId, orgId, permission);
      if (hit === undefined) missIdx.push(i);
      else allowed[i] = hit;
    });

    // Only the misses go on the wire, still batched: one call for a rule of any size
    // (identity's own cap at 20 is the only thing that can split it), and zero calls when
    // every key is cached.
    for (let i = 0; i < missIdx.length; i += MAX_BATCH_CHECKS) {
      const batch = missIdx.slice(i, i + MAX_BATCH_CHECKS).map((idx) => keys[idx]!);
      const req: identity.AuthzCheckRequest = {
        subjectUserId: userId,
        orgId,
        checks: batch.map((permission) => ({ permission })),
      };
      // Fail closed: a transport/upstream failure throws and becomes a 5xx. It must never
      // degrade into "no decision, so allow" — and nothing is cached on this path, so a
      // failure cannot be answered from a stale entry either.
      const res = await client.post<identity.AuthzCheckResponse>(
        { requestId: opts.requestId ?? newRequestId() },
        "/authz/check",
        req,
      );
      batch.forEach((permission, j) => {
        const decision = res.decisions[j];
        if (decision === undefined) return; // absent decision = not held (fail closed)
        allowed[missIdx[i + j]!] = decision.allowed;
        // TTL is identity's to decide (AuthzDecision.ttlSeconds, 60s today), never ours.
        cache.set(userId, orgId, permission, decision.allowed, decision.ttlSeconds);
      });
    }

    return keys.filter((_, i) => allowed[i] === true);
  };
}

// Decision cache per Env, so it survives across requests served by the same isolate. Keyed
// on the Env object exactly like services/gantt-service/src/deps.ts memoizes its authClient;
// a WeakMap means a torn-down isolate's cache is collectable and nothing accumulates.
const cacheByEnv = new WeakMap<object, AuthzDecisionCache>();

/**
 * The granter a Worker entrypoint should use. Same arguments as `createAuthzGranter` plus
 * the `env` it was handed, which is all it takes to make the TTL cache effective:
 *
 *   const authz = sharedAuthzGranter(env, env.SVC_IDENTITY, {
 *     caller: "my-service",
 *     requestId,
 *   });
 *   // ... policyGate({ service: "my-service", table: POLICY_TABLE, granted: authz })
 *
 * Safe to call once per request (the per-request `requestId` is the point): the granter is a
 * closure over a shared cache, so building it is cheap and only the cache is reused. The
 * cache is keyed by (userId, orgId, permission), so sharing it between requests never shares
 * a decision between users or orgs.
 */
export function sharedAuthzGranter<E extends object>(
  env: E,
  binding: Fetcher,
  opts: AuthzGranterOptions,
): PermissionGranter {
  let cache = opts.cache ?? cacheByEnv.get(env);
  if (cache === undefined) {
    cache = createAuthzCache(opts.cacheOptions);
    cacheByEnv.set(env, cache);
  }
  return createAuthzGranter(binding, { ...opts, cache });
}
