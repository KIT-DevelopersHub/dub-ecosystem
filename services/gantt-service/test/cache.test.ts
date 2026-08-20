import { describe, it, expect, vi } from "vitest";
import type { KVNamespace } from "@cloudflare/workers-types";
import { createKvCache } from "../src/cache";

// A KV whose every operation rejects — models the free-tier daily write/delete quota
// being exhausted (or a transient KV error). The DTO cache is a 60s optimization, so
// none of these failures may propagate: they turned a persisted bar move/resize into a
// spurious 500 ("時間をおいて再試行") because @dub/errors normalizes a raw throw to INTERNAL.
function throwingKv(): KVNamespace {
  const boom = () => Promise.reject(new Error("KV put() limit exceeded"));
  return {
    get: boom,
    put: boom,
    delete: boom,
    list: boom,
    getWithMetadata: boom,
  } as unknown as KVNamespace;
}

describe("createKvCache — best-effort (KV failure never fails the caller)", () => {
  it("get() degrades to a cache miss (null) instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = createKvCache(throwingKv());
    await expect(cache.get("event_1")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("put() swallows a KV write failure (the GET / no-cache refetch must not 500)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = createKvCache(throwingKv());
    await expect(
      cache.put("event_1", { eventId: "event_1", rows: [], dependencies: [] }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("purge() is a no-op — no KV delete at all (#399 write-budget fix), so it never throws", async () => {
    // Purge no longer issues a KV delete (TTL handles freshness on the free plan), so even a
    // KV whose delete would reject cannot make the triggering PATCH /gantt/rows write 500.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const del = vi.fn(() => Promise.reject(new Error("KV delete() limit exceeded")));
    const kv = { get: () => Promise.resolve(null), put: () => Promise.resolve(), delete: del } as unknown as KVNamespace;
    const cache = createKvCache(kv);
    await expect(cache.purge("event_1")).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled(); // eager delete removed
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("get() on a live KV round-trips a stored DTO", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      put: (k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      },
      delete: (k: string) => {
        store.delete(k);
        return Promise.resolve();
      },
    } as unknown as KVNamespace;
    const cache = createKvCache(kv);
    await cache.put("event_1", { eventId: "event_1", rows: [], dependencies: [] });
    await expect(cache.get("event_1")).resolves.toEqual({ eventId: "event_1", rows: [], dependencies: [] });
    // purge is a no-op (#399): the key is NOT evicted eagerly — it self-expires via the 60s
    // TTL, so an immediate re-read still round-trips the stored DTO.
    await cache.purge("event_1");
    await expect(cache.get("event_1")).resolves.toEqual({ eventId: "event_1", rows: [], dependencies: [] });
  });
});
