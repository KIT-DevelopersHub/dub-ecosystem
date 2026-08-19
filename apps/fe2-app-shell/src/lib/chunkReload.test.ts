// Regression: stale-chunk recovery helper for the 通知 / メール名簿 が
// "Something went wrong" で開けない incident (failed dynamic import after a deploy).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, reloadForStaleChunk } from "./chunkReload.ts";

describe("isChunkLoadError", () => {
  it("recognises the browser dynamic-import failure wordings", () => {
    for (const msg of [
      "Failed to fetch dynamically imported module: https://x/assets/NotificationInboxPage-BuWxr0tT.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Failed to fetch",
    ]) {
      expect(isChunkLoadError(new Error(msg))).toBe(true);
    }
  });

  it("does not misclassify unrelated errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new Error("UNAUTHENTICATED"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("reloadForStaleChunk", () => {
  const reload = vi.fn();
  beforeEach(() => {
    reload.mockClear();
    window.sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("reloads once, then suppresses a rapid second attempt (no loop)", () => {
    expect(reloadForStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // Immediate retry within the guard window must NOT reload again.
    expect(reloadForStaleChunk()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recovers again once the guard window has elapsed", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    expect(reloadForStaleChunk()).toBe(true);
    now.mockReturnValue(1_000_000 + 31_000); // > 30s later
    expect(reloadForStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
