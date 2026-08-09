import { describe, it, expect, vi } from "vitest";
import type { identity } from "@dub/types";
import { createUserCache, missingIds, ensureUsers, displayName, chunk } from "../src/domain/user-cache";

const u = (id: string): identity.UserSummary => ({ id, displayName: `name-${id}`, avatarUrl: null });

describe("user-cache batch resolution (design test 13)", () => {
  it("missingIds dedupes, drops null and cached", () => {
    const cache = createUserCache([u("a")]);
    expect(missingIds(cache, ["a", "b", "b", null, "c"])).toEqual(["b", "c"]);
  });

  it("ensureUsers resolves all missing in ONE batch (no N+1)", async () => {
    const cache = createUserCache();
    const fetchBatch = vi.fn(async (batch: string[]) => ({ items: batch.map(u), nextCursor: null }));
    await ensureUsers(cache, ["a", "b", "a", null, "c"], fetchBatch);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(fetchBatch).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(displayName(cache, "b")).toBe("name-b");
    expect(displayName(cache, null)).toBe("未割当");
  });

  it("chunks over the 50-id ceiling", async () => {
    const cache = createUserCache();
    const ids = Array.from({ length: 120 }, (_, i) => `u${i}`);
    const fetchBatch = vi.fn(async (batch: string[]) => ({ items: batch.map(u), nextCursor: null }));
    await ensureUsers(cache, ids, fetchBatch);
    expect(fetchBatch).toHaveBeenCalledTimes(3); // 50 + 50 + 20
    expect(chunk(ids, 50).map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it("no fetch when everything is cached", async () => {
    const cache = createUserCache([u("a"), u("b")]);
    const fetchBatch = vi.fn(async () => ({ items: [], nextCursor: null }));
    await ensureUsers(cache, ["a", "b"], fetchBatch);
    expect(fetchBatch).not.toHaveBeenCalled();
  });
});
