// KV response cache — the single place rate control / freshness is managed (§2-2).
// Keys & TTL semantics are frozen; the numbers are env-tunable (§8-2 old#8).
import type { KVNamespace } from "@cloudflare/workers-types";

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}

// ---- key builders (frozen shapes, §2-2) ----
export const TOKEN_KEY = "drive:token";
export const fileKey = (id: string): string => `drive:file:${id}`;
export const listPrefix = (folderId: string): string => `drive:list:${folderId}:`;
export const listKey = (folderId: string, hash: string): string => `drive:list:${folderId}:${hash}`;
export const sheetPrefix = (id: string): string => `drive:sheet:${id}:`;
export const sheetKey = (id: string, hash: string): string => `drive:sheet:${id}:${hash}`;

/** Stable djb2 hash of the query-shaping params (cursor/limit/kind/q, range). */
export function hashParams(parts: (string | number | undefined)[]): string {
  const s = parts.map((p) => p ?? "").join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Workers KV enforces expirationTtl >= 60s; sub-minute TTLs are clamped there but
// honored exactly by the in-memory cache used in tests.
const KV_MIN_TTL = 60;

export function createKvCache(kv: KVNamespace): Cache {
  return {
    async get<T>(key: string): Promise<T | null> {
      return (await kv.get(key, "json")) as T | null;
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(KV_MIN_TTL, Math.ceil(ttlSeconds)) });
    },
    async delete(key: string): Promise<void> {
      await kv.delete(key);
    },
    async deleteByPrefix(prefix: string): Promise<void> {
      let cursor: string | undefined;
      do {
        const page = await kv.list(cursor ? { prefix, cursor } : { prefix });
        await Promise.all(page.keys.map((k) => kv.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    },
  };
}
