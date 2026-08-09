import { describe, it, expect } from "vitest";
import { SwrCache } from "../src/cache.js";
import { InMemoryTokenStore } from "../src/token-store.js";

describe("SWR read cache (design §1 read cache, §3 logout clears)", () => {
  it("returns fresh then stale as time passes", () => {
    let now = 1_000;
    const cache = new SwrCache(100, () => now);
    cache.set("home", { unread: 2 });

    expect(cache.get<{ unread: number }>("home")).toEqual({ value: { unread: 2 }, stale: false });
    now = 1_200; // past ttl
    expect(cache.get<{ unread: number }>("home")!.stale).toBe(true);
    expect(cache.get<{ unread: number }>("home")!.value).toEqual({ unread: 2 }); // still returned
  });

  it("returns null for a missing key", () => {
    expect(new SwrCache().get("nope")).toBeNull();
  });

  it("clear() drops all display copies (logout)", () => {
    const cache = new SwrCache();
    cache.set("a", 1);
    cache.clear();
    expect(cache.get("a")).toBeNull();
  });
});

describe("token store logout (design §3)", () => {
  it("clear removes the session", () => {
    const store = new InMemoryTokenStore();
    store.write({ token: "t", sessionExpiresAt: 1 });
    expect(store.read()).not.toBeNull();
    store.clear();
    expect(store.read()).toBeNull();
  });
});
