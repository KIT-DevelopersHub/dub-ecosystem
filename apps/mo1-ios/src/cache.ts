// cache — read-only stale-while-revalidate cache (design §1 "読み取りローカル
// キャッシュ", §8-3 "オフライン書込キューは持たない"). The Swift app backs this
// with SwiftData; the reference layer is an in-memory TTL map. Values are
// display copies, never the source of truth, and logout clears everything (§3).
export interface CacheEntry<T> {
  value: T;
  /** true once past TTL: still returned (stale) but a refetch should fire. */
  stale: boolean;
}

interface StoredEntry {
  value: unknown;
  storedAt: number;
}

export class SwrCache {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #map = new Map<string, StoredEntry>();

  constructor(ttlMs = 5 * 60 * 1000, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  set<T>(key: string, value: T): void {
    this.#map.set(key, { value, storedAt: this.#now() });
  }

  get<T>(key: string): CacheEntry<T> | null {
    const e = this.#map.get(key);
    if (e === undefined) return null;
    return { value: e.value as T, stale: this.#now() - e.storedAt > this.#ttlMs };
  }

  /** Logout / account switch: drop all display copies. */
  clear(): void {
    this.#map.clear();
  }
}
