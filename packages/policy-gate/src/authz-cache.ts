// Per-decision TTL cache for the authz granter — the ADR 0004 requirement, not an
// optimization bolted on afterwards.
//
// ADR 0004 (docs/adr/0004-auth-session-cookie-plus-trusted-gateway-header.md) decided:
// "authz は常に live check" PLUS "per-decision TTL キャッシュ(userId, orgId, permission,
// resource)" PLUS "dangerous キーは常に cache bypass". Without the cache every gated route
// in every service becomes an unconditional identity-roster subrequest, which makes
// identity-roster a single point of failure on the hot path of the whole platform — the
// decision this file exists to honour.
//
// WHAT IS DELIBERATELY *NOT* CACHED
//   - dangerous keys (identity.PERMISSION_CATALOG `dangerous: true`): always bypassed, both
//     read and write, so a revoked `infra:deploy` / `mail:send` / `chat:moderate` takes
//     effect on the very next request. The cost of a stale "allow" there is irreversible.
//   - nothing is ever served past its expiry, including when identity is unreachable. There
//     is no serve-stale-on-error path: a dead identity-roster means the gate throws (5xx),
//     never "the cache said yes". Entries are written only from a successful decision.
//
// RELATION TO @dub/auth-client
//   `packages/auth-client/src/index.ts` carries the same cache for the older per-route
//   `requirePermission` PEP. This is a deliberate, documented port rather than an import:
//   policy-gate is the layer that REPLACES auth-client's PEP (see gate.ts), so depending on
//   the package being retired would pin it in place; auth-client's only cache entry point is
//   `checkPermissions`, which hard-rejects >20 checks and so cannot own "select misses, then
//   batch"; and it reads `Date.now()` directly, which this file makes injectable so the TTL
//   behaviour is testable without sleeping. Semantics are kept identical on purpose
//   (key shape, server-specified TTL, dangerous bypass, bounded entry count).
import { identity } from "@dub/types";

/** Keys the catalog marks `dangerous: true` — never cached, in either direction. */
export const DANGEROUS_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  identity.PERMISSION_CATALOG.filter((e) => e.dangerous).map((e) => e.key),
);

export function isDangerousPermission(key: string): boolean {
  return DANGEROUS_PERMISSION_KEYS.has(key);
}

/** Entries before the oldest is evicted. ~1000 x ~100B is negligible per isolate. */
const DEFAULT_MAX_ENTRIES = 1000;
/**
 * Upper bound on the TTL this cache will honour, in seconds. The TTL itself always comes
 * from identity (`AuthzDecision.ttlSeconds`, 60s today — see identity-roster's
 * AUTHZ_TTL_SECONDS); this only stops a misconfigured or malformed upstream value from
 * turning "authz is a live check with a 60s window" into hours of unrevokable access. It
 * does not bind at the current 60s.
 */
const DEFAULT_MAX_TTL_SECONDS = 300;

export interface AuthzCacheOptions {
  /** LRU capacity. Default 1000. `0` disables caching entirely. */
  maxEntries?: number;
  /** Clamp for the server-provided TTL. Default 300s. */
  maxTtlSeconds?: number;
  /** Injectable clock (ms epoch). Default `Date.now`. Tests pass a fake. */
  now?: () => number;
}

export interface AuthzDecisionCache {
  /** `true`/`false` = a fresh cached decision; `undefined` = must ask identity. */
  get(userId: string, orgId: string, permission: string): boolean | undefined;
  /** Record a decision identity actually returned. No-op for dangerous keys / TTL <= 0. */
  set(userId: string, orgId: string, permission: string, allowed: boolean, ttlSeconds: number): void;
  /** Drop everything, or just one subject's entries. */
  invalidate(userId?: string): void;
  readonly size: number;
}

/**
 * Cache key. The separator is NUL, which cannot occur in any of the three parts: a
 * permission key comes from the closed `PERMISSION_CATALOG`, and userId/orgId arrive as HTTP
 * header values (`x-dub-user-id`), where NUL is forbidden by the protocol and rejected by
 * the Headers implementation. So no attacker-chosen id can be split or joined to collide
 * with another subject's entry — `("a", "b|c", k)` and `("a|b", "c", k)` stay distinct keys.
 * Both ids are always part of the key, so a decision is never read back for a different
 * user or a different org.
 */
function cacheKey(userId: string, orgId: string, permission: string): string {
  return `${userId}\u0000${orgId}\u0000${permission}`;
}

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
  userId: string;
}

export function createAuthzCache(opts: AuthzCacheOptions = {}): AuthzDecisionCache {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTtlSeconds = opts.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
  const now = opts.now ?? Date.now;
  // Insertion order = recency order: a hit re-inserts, so `keys().next()` is the LRU victim.
  const entries = new Map<string, CacheEntry>();

  return {
    get(userId, orgId, permission) {
      if (maxEntries <= 0 || isDangerousPermission(permission)) return undefined;
      const key = cacheKey(userId, orgId, permission);
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, hit); // mark most-recently-used
      return hit.allowed;
    },

    set(userId, orgId, permission, allowed, ttlSeconds) {
      if (maxEntries <= 0 || isDangerousPermission(permission)) return;
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
      const ttl = Math.min(ttlSeconds, maxTtlSeconds);
      const key = cacheKey(userId, orgId, permission);
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { allowed, expiresAt: now() + ttl * 1000, userId });
    },

    invalidate(userId) {
      if (userId === undefined) {
        entries.clear();
        return;
      }
      for (const [key, entry] of entries) if (entry.userId === userId) entries.delete(key);
    },

    get size() {
      return entries.size;
    },
  };
}
