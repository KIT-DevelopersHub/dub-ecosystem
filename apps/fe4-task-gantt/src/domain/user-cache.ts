// assignee/watcher display-name resolution with an in-memory cache so a view
// resolves N assignees in ONE batched request, never N+1 (design §3 / test 13).
// Batches are chunked to the identity contract's 50-id ceiling.
import type { identity, common } from "@dub/types";
import { USER_BATCH_MAX } from "../api/endpoints";

export type UserCache = Map<common.UserId, identity.UserSummary>;

export function createUserCache(seed?: readonly identity.UserSummary[]): UserCache {
  const m: UserCache = new Map();
  if (seed) for (const u of seed) m.set(u.id, u);
  return m;
}

/** ids not yet in cache, de-duplicated and null-stripped. */
export function missingIds(cache: UserCache, ids: readonly (common.UserId | null)[]): common.UserId[] {
  const out: common.UserId[] = [];
  const seen = new Set<common.UserId>();
  for (const id of ids) {
    if (id === null || seen.has(id) || cache.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Resolve missing ids in batches (<=50), writing results into the cache. */
export async function ensureUsers(
  cache: UserCache,
  ids: readonly (common.UserId | null)[],
  fetchBatch: (batch: common.UserId[]) => Promise<common.Paginated<identity.UserSummary>>,
): Promise<UserCache> {
  const missing = missingIds(cache, ids);
  if (missing.length === 0) return cache;
  for (const batch of chunk(missing, USER_BATCH_MAX)) {
    const res = await fetchBatch(batch);
    for (const u of res.items) cache.set(u.id, u);
  }
  return cache;
}

export function displayName(cache: UserCache, id: common.UserId | null): string {
  if (id === null) return "未割当";
  return cache.get(id)?.displayName ?? id;
}
