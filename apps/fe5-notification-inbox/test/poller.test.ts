import { describe, expect, it, vi } from "vitest";
import { createUnreadPoller } from "../src/lib/poller";

describe("createUnreadPoller", () => {
  it("polls immediately and reports the value", async () => {
    const onValue = vi.fn();
    const poller = createUnreadPoller({
      fetchCount: async () => 7,
      onValue,
      setInterval: () => 1,
      clearInterval: () => {},
      isHidden: () => false,
    });
    await poller.poll();
    expect(onValue).toHaveBeenCalledWith(7);
  });

  it("does not fetch while the tab is hidden", async () => {
    const fetchCount = vi.fn(async () => 3);
    const poller = createUnreadPoller({
      fetchCount,
      onValue: () => {},
      isHidden: () => true,
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await poller.poll();
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it("keeps last value silently on error (onValue not called)", async () => {
    const onValue = vi.fn();
    const onError = vi.fn();
    const poller = createUnreadPoller({
      fetchCount: async () => {
        throw new Error("network");
      },
      onValue,
      onError,
      isHidden: () => false,
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await poller.poll();
    expect(onValue).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it("start triggers an immediate poll and registers an interval", () => {
    const setInterval = vi.fn(() => 42);
    const clearInterval = vi.fn();
    const poller = createUnreadPoller({
      fetchCount: async () => 1,
      onValue: () => {},
      isHidden: () => false,
      setInterval,
      clearInterval,
    });
    poller.start();
    expect(setInterval).toHaveBeenCalledOnce();
    poller.stop();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });
});
