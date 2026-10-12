import { describe, it, expect } from "vitest";
import { isStale, STALE_AFTER_MS } from "../src/freshness";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("isStale", () => {
  it("is fresh within 48h of the last capture (one missed day is not stale yet)", () => {
    expect(isStale(ago(0), NOW)).toBe(false);
    expect(isStale(ago(30 * 3_600_000), NOW)).toBe(false);
    expect(isStale(ago(STALE_AFTER_MS), NOW)).toBe(false);
  });

  it("is stale past 48h", () => {
    expect(isStale(ago(STALE_AFTER_MS + 1), NOW)).toBe(true);
    expect(isStale("2026-09-17T20:48:01.331Z", NOW)).toBe(true);
  });

  it("is stale when nothing was ever captured or the timestamp is unreadable", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale("not-a-date", NOW)).toBe(true);
  });
});
